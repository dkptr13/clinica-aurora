'use strict';
/*
 * Crea la primera cuenta de administración y, opcionalmente, la configuración
 * inicial de la clínica en Firestore.
 *
 * Uso:
 *   ADMIN_EMAIL=admin@tudominio.com ADMIN_PASSWORD='...' ADMIN_NAME='Nombre Apellidos' \
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json \
 *   node scripts/bootstrap-admin.js --seed-config
 *
 * Requisitos de la contraseña: mínimo 10 caracteres, elegida por la clínica.
 * Nunca se guarda la contraseña en el repositorio.
 */
const admin = require('../functions/node_modules/firebase-admin');
const { Timestamp } = admin.firestore;

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
const name = String(process.env.ADMIN_NAME || 'Administración Aurora').trim();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Define ADMIN_EMAIL con un correo válido.');
if (password.length < 10) throw new Error('Define ADMIN_PASSWORD con al menos 10 caracteres.');
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('Define GOOGLE_APPLICATION_CREDENTIALS (cuenta de servicio) o FIRESTORE_EMULATOR_HOST.');
}
admin.initializeApp({ projectId });
const auth = admin.auth();
const db = admin.firestore();

const DEFAULT_TREATMENTS = [
  { id: 'limpieza', n: 'Limpieza dental', min: 45, p: 60, dentistIds: ['d1', 'd2', 'd3'], active: true },
  { id: 'ortodoncia', n: 'Ortodoncia', min: 30, p: 90, dentistIds: ['d2'], active: true },
  { id: 'implantes', n: 'Implantes', min: 60, p: 950, dentistIds: ['d1'], active: true },
  { id: 'blanqueamiento', n: 'Blanqueamiento', min: 60, p: 240, dentistIds: ['d1', 'd3'], active: true },
  { id: 'endodoncia', n: 'Endodoncia', min: 60, p: 180, dentistIds: ['d3'], active: true },
  { id: 'revision', n: 'Revisión', min: 30, p: 35, dentistIds: ['d1', 'd2', 'd3'], active: true }
];
const DEFAULT_DENTISTS = [
  { id: 'd1', n: 'Dra. Laura Méndez', r: 'Odontología general e implantes', active: true },
  { id: 'd2', n: 'Dr. Pablo Serrano', r: 'Ortodoncia', active: true },
  { id: 'd3', n: 'Dra. Marta Vidal', r: 'Endodoncia y estética dental', active: true }
];

(async () => {
  let user;
  try {
    user = await auth.getUserByEmail(email);
    console.log('La cuenta ya existe; se actualizarán sus permisos.');
    await auth.updateUser(user.uid, { password, displayName: name, disabled: false });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({ email, password, displayName: name, emailVerified: true });
    console.log('Cuenta creada.');
  }
  await auth.setCustomUserClaims(user.uid, { role: 'admin' });
  await db.doc('users/' + user.uid).set({
    uid: user.uid, email, name, role: 'admin', status: 'active', patientId: '', dentistId: '',
    phone: '', preferences: { lang: 'es', theme: 'system', motion: 'system', notifications: { email: true, sms: false } },
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), createdBy: 'bootstrap-script'
  }, { merge: true });

  if (process.argv.includes('--seed-config')) {
    const batch = db.batch();
    batch.set(db.doc('settings/clinic'), {
      name: 'Clínica Dental Aurora', addr: 'Calle de la Luz 24, 28004 Madrid',
      phone: '+34 910 000 000', email: 'info@clinicaaurora.example', timezone: 'Europe/Madrid',
      slots: ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00'],
      breakStart: '14:00', breakEnd: '16:00', openEnd: '20:00', privacyVersion: '2026-01', bookingHoldHours: 24
    }, { merge: true });
    for (const t of DEFAULT_TREATMENTS) batch.set(db.doc('treatments/' + t.id), t, { merge: true });
    for (const d of DEFAULT_DENTISTS) batch.set(db.doc('dentists/' + d.id), d, { merge: true });
    await batch.commit();
    console.log('Configuración inicial de la clínica creada/actualizada.');
  }

  // El contador de referencias debe empezar por encima de las solicitudes ya existentes.
  const existingRequests = await db.collection('requests').get();
  let maxRef = 0;
  existingRequests.forEach((d) => {
    const m = String(d.data().ref || '').match(/^AUR-\d{4}-(\d{1,6})$/);
    if (m) maxRef = Math.max(maxRef, Number(m[1]));
  });
  await db.doc('counters/requests').set({ value: maxRef, updatedAt: Timestamp.now() }, { merge: true });
  console.log('Contador de solicitudes inicializado en', maxRef);
  await db.collection('auditLogs').add({
    actorUid: user.uid, actorRole: 'system', action: 'admin.bootstrap',
    entity: 'users', entityId: user.uid, at: Timestamp.now(), meta: { seededConfig: process.argv.includes('--seed-config') }
  });
  console.log(JSON.stringify({ ok: true, uid: user.uid, email, role: 'admin' }, null, 2));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
