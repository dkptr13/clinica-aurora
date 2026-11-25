import { test, before, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, addDoc, serverTimestamp, writeBatch
} from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rules = fs.readFileSync(path.join(here, '..', 'firestore.rules'), 'utf8');
const projectId = 'demo-aurora-rules';
let testEnv;

const ids = {
  admin: 'u_admin',
  reception: 'u_reception',
  dentist1: 'u_dentist1',
  dentist2: 'u_dentist2',
  patient: 'u_patient'
};

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules, host: '127.0.0.1', port: 8080 }
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ids.admin), { uid: ids.admin, email: 'admin@test', name: 'Admin', role: 'admin', status: 'active' });
    await setDoc(doc(db, 'users', ids.reception), { uid: ids.reception, email: 'reception@test', name: 'Recepción', role: 'reception', status: 'active' });
    await setDoc(doc(db, 'users', ids.dentist1), { uid: ids.dentist1, email: 'd1@test', name: 'Dentista 1', role: 'dentist', dentistId: 'd1', status: 'active' });
    await setDoc(doc(db, 'users', ids.dentist2), { uid: ids.dentist2, email: 'd2@test', name: 'Dentista 2', role: 'dentist', dentistId: 'd2', status: 'active' });
    await setDoc(doc(db, 'users', ids.patient), { uid: ids.patient, email: 'patient@test', name: 'Paciente', role: 'patient', patientId: 'p1', status: 'active' });
    await setDoc(doc(db, 'patients', 'p1'), { fn: 'Ana', ln: 'Uno', em: 'ana@test', ph: '600000000', status: 'active', userId: ids.patient, assignedDentistId: 'd1', careTeamIds: ['d1'] });
    await setDoc(doc(db, 'patients', 'p2'), { fn: 'Beto', ln: 'Dos', em: 'beto@test', ph: '600000001', status: 'active', userId: '', assignedDentistId: 'd2', careTeamIds: ['d2'] });
    await setDoc(doc(db, 'patients', 'p3'), { fn: 'Carla', ln: 'Tres', em: 'carla@test', ph: '600000002', status: 'active', userId: '', assignedDentistId: 'd2', careTeamIds: ['d1'] });
    await setDoc(doc(db, 'appointments', 'a1'), { patientId: 'p1', patientName: 'Ana Uno', treatment: 'revision', dentistId: 'd1', date: '2026-11-25', time: '10:00', status: 'confirmed' });
    await setDoc(doc(db, 'appointments', 'a2'), { patientId: 'p2', patientName: 'Beto Dos', treatment: 'limpieza', dentistId: 'd2', date: '2026-11-25', time: '11:00', status: 'confirmed' });
    await setDoc(doc(db, 'bookedSlots', 's_a1'), { date: '2026-11-25', time: '10:00', dentistId: 'd1', appointmentId: 'a1', status: 'confirmed' });
    await setDoc(doc(db, 'consultations', 'c1'), { patientId: 'p1', dentistId: 'd1', date: '2026-11-01', notes: 'privado', share: true, visibleToPatient: true });
    await setDoc(doc(db, 'consultations', 'c2'), { patientId: 'p2', dentistId: 'd2', date: '2026-11-01', notes: 'privado 2', share: false });
    await setDoc(doc(db, 'clinicalSummaries', 's1'), { patientId: 'p1', consultationId: 'c1', date: '2026-11-01', summary: 'resumen', dentistId: 'd1' });
    await setDoc(doc(db, 'payments', 'y1'), { patientId: 'p1', amount: 60, status: 'pending', date: '2026-11-01', concept: 'Limpieza' });
    await setDoc(doc(db, 'requests', 'r1'), { kind: 'booking', name: 'Sofía', status: 'new', date: '2026-11-30', time: '10:00', dentistId: 'd1', patientId: '' });
    await setDoc(doc(db, 'patients', 'p1', 'documents', 'rad1'), { patientId: 'p1', type: 'radiograph', visibleToPatient: false, storagePath: 'patients/p1/clinical/rad1.jpg', size: 1000 });
    await setDoc(doc(db, 'patients', 'p1', 'documents', 'inv1'), { patientId: 'p1', type: 'invoice', visibleToPatient: true, storagePath: 'patients/p1/invoices/inv1.pdf', size: 1000 });
    await setDoc(doc(db, 'patients', 'p1', 'messages', 'm1'), { patientId: 'p1', senderId: ids.dentist1, senderRole: 'dentist', senderName: 'Dentista 1', body: 'Hola', readBy: [] });
    await setDoc(doc(db, 'notifications', 'n1'), { userId: ids.patient, title: 'Aviso', body: 'Texto', read: false });
    await setDoc(doc(db, 'notifications', 'n2'), { userId: ids.dentist1, title: 'Otro', body: 'Texto', read: false });
    await setDoc(doc(db, 'settings', 'clinic'), { name: 'Aurora', phone: '600000000' });
    await setDoc(doc(db, 'settings', 'internal'), { secret: 'no' });
  });
});

after(async () => { if (testEnv) await testEnv.cleanup(); });

const db = id => testEnv.authenticatedContext(id, {}).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();
const patientClaims = {};
const receptionClaims = {};
const dentist1Claims = {};
const adminClaims = {};

test('patient can self-provision own user and patient docs', async () => {
  const newDb = testEnv.authenticatedContext('u_new', { email: 'new@test.dev' }).firestore();
  const batch = writeBatch(newDb);
  batch.set(doc(newDb, 'users', 'u_new'), { uid: 'u_new', email: 'new@test.dev', name: 'Nuevo Paciente', role: 'patient', status: 'active', patientId: 'u_new', preferences: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(doc(newDb, 'patients', 'u_new'), { fn: 'Nuevo', ln: 'Paciente', bd: '', ph: '', em: 'new@test.dev', addr: '', assignedDentistId: '', userId: 'u_new', status: 'active', careTeamIds: [], searchName: 'nuevo paciente', createdAt: serverTimestamp(), createdBy: 'self-registration', updatedAt: serverTimestamp() });
  await assertSucceeds(batch.commit());
});

test('anon cannot read patients or internal settings but can read public slots', async () => {
  await assertFails(getDoc(doc(anon(), 'patients', 'p1')));
  await assertFails(getDoc(doc(anon(), 'settings', 'internal')));
  await assertSucceeds(getDoc(doc(anon(), 'settings', 'clinic')));
  await assertSucceeds(getDoc(doc(anon(), 'bookedSlots', 's_a1')));
});

test('patient reads own record only', async () => {
  await assertSucceeds(getDoc(doc(db(ids.patient), 'patients', 'p1')));
  await assertFails(getDoc(doc(db(ids.patient), 'patients', 'p2')));
  await assertFails(getDocs(collection(db(ids.patient), 'patients')));
});

test('patient reads own appointments and summaries but not consultations', async () => {
  const p = db(ids.patient);
  await assertSucceeds(getDocs(query(collection(p, 'appointments'), where('patientId', '==', 'p1'))));
  await assertFails(getDocs(query(collection(p, 'appointments'), where('patientId', '==', 'p2'))));
  await assertSucceeds(getDocs(query(collection(p, 'clinicalSummaries'), where('patientId', '==', 'p1'))));
  await assertFails(getDoc(doc(p, 'consultations', 'c1')));
});

test('reception manages patients but not clinical history', async () => {
  const r = db(ids.reception);
  await assertSucceeds(getDoc(doc(r, 'patients', 'p1')));
  await assertFails(getDoc(doc(r, 'consultations', 'c1')));
  await assertFails(getDoc(doc(r, 'patients', 'p1', 'documents', 'rad1')));
  await assertSucceeds(getDoc(doc(r, 'patients', 'p1', 'documents', 'inv1')));
});

test('dentist only accesses assigned patients or care team', async () => {
  const d1 = db(ids.dentist1);
  await assertSucceeds(getDoc(doc(d1, 'patients', 'p1')));
  await assertSucceeds(getDoc(doc(d1, 'patients', 'p3')));
  await assertFails(getDoc(doc(d1, 'patients', 'p2')));
  await assertSucceeds(getDoc(doc(d1, 'consultations', 'c1')));
  await assertFails(getDoc(doc(d1, 'consultations', 'c2')));
  await assertSucceeds(getDocs(query(collection(d1, 'appointments'), where('dentistId', '==', 'd1'))));
});

test('reception can write appointments and slots directly', async () => {
  const r = db(ids.reception);
  await assertSucceeds(setDoc(doc(r, 'appointments', 'a3'), { patientId: 'p1', patientName: 'Ana Uno', treatment: 'revision', dentistId: 'd1', date: '2026-12-01', time: '10:00', status: 'confirmed' }));
  await assertSucceeds(setDoc(doc(r, 'bookedSlots', 's_a3'), { date: '2026-12-01', time: '10:00', dentistId: 'd1', appointmentId: 'a3', status: 'confirmed', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db(ids.patient), 'appointments', 'a4'), { patientId: 'p1', treatment: 'revision', dentistId: 'd1', date: '2026-12-02', time: '10:00', status: 'confirmed' }));
});

test('reception can write payments; patient cannot change status', async () => {
  const r = db(ids.reception);
  const p = db(ids.patient);
  await assertSucceeds(setDoc(doc(r, 'payments', 'y2'), { patientId: 'p1', concept: 'X', amount: 10, status: 'pending', date: '2026-12-01', createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(p, 'payments', 'y1'), { status: 'paid' }));
});

test('patient direct role change is denied', async () => {
  const p = db(ids.patient);
  await assertFails(updateDoc(doc(p, 'users', ids.patient), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(p, 'users', ids.patient), { preferences: { lang: 'en', a11y: { scale: 1.2 } } }));
});

test('public can create a request but not forge a staff notification', async () => {
  await assertSucceeds(addDoc(collection(anon(), 'requests'), { kind: 'booking', name: 'Sofía Prueba', phone: '600000000', email: 'sofia@test', treatment: 'revision', dentistId: 'd1', date: '2026-12-03', time: '10:00', msg: '', status: 'new', source: 'web-direct', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertFails(addDoc(collection(anon(), 'notifications'), { userId: ids.patient, title: 'X', body: 'Y', read: false, createdAt: serverTimestamp() }));
});

test('patient can read only shared documents and own messages', async () => {
  const p = db(ids.patient);
  await assertSucceeds(getDoc(doc(p, 'patients', 'p1', 'documents', 'inv1')));
  await assertFails(getDoc(doc(p, 'patients', 'p1', 'documents', 'rad1')));
  await assertSucceeds(getDoc(doc(p, 'patients', 'p1', 'messages', 'm1')));
});

test('patient cannot read internal settings or notifications of others', async () => {
  const p = db(ids.patient);
  await assertFails(getDoc(doc(p, 'settings', 'internal')));
  await assertFails(getDoc(doc(p, 'notifications', 'n2')));
  await assertSucceeds(getDoc(doc(p, 'notifications', 'n1')));
  await assertSucceeds(getDoc(doc(p, 'patients', 'p1', 'documents', 'inv1')));
});

test('only admin can change roles and account status', async () => {
  const a = db(ids.admin);
  const r = db(ids.reception);
  await assertFails(updateDoc(doc(r, 'users', ids.patient), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(a, 'users', ids.patient), { role: 'dentist', dentistId: 'd2', updatedAt: serverTimestamp(), updatedBy: ids.admin }));
  await assertSucceeds(updateDoc(doc(a, 'users', ids.reception), { status: 'inactive', updatedAt: serverTimestamp(), updatedBy: ids.admin }));
});
