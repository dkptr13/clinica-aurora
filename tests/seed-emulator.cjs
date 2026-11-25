'use strict';
/*
 * Datos de prueba SOLO para los emuladores locales.
 * Nunca ejecutar contra el proyecto real.
 */
const admin = require('../functions/node_modules/firebase-admin');
const projectId = 'clinicadental-aurora';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Define FIRESTORE_EMULATOR_HOST y FIREBASE_AUTH_EMULATOR_HOST. Este script no debe usarse contra producción.');
}
admin.initializeApp({ projectId, storageBucket: `${projectId}.firebasestorage.app` });
const auth = admin.auth();
const db = admin.firestore();
const password = 'AuroraTest123!';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const users = [
  { email: 'admin@aurora.test', name: 'Admin Aurora', role: 'admin' },
  { email: 'recepcion@aurora.test', name: 'Recepción Aurora', role: 'reception' },
  { email: 'dentista1@aurora.test', name: 'Dra. Laura Méndez', role: 'dentist', dentistId: 'd1' },
  { email: 'dentista2@aurora.test', name: 'Dr. Pablo Serrano', role: 'dentist', dentistId: 'd2' },
  { email: 'paciente@aurora.test', name: 'Ana García López', role: 'patient' }
];

async function upsertUser(spec) {
  let user;
  try { user = await auth.getUserByEmail(spec.email); }
  catch { user = await auth.createUser({ email: spec.email, password, displayName: spec.name, emailVerified: true }); }
  await auth.setCustomUserClaims(user.uid, { role: spec.role });
  return { ...spec, uid: user.uid };
}

(async () => {
  const created = {};
  for (const spec of users) created[spec.role + (spec.dentistId || '')] = await upsertUser(spec);
  const patient = created['patient'];
  const adminUser = created['admin'];
  const reception = created['reception'];
  const d1 = created['dentistd1'];
  const d2 = created['dentistd2'];

  const batch = db.batch();
  batch.set(db.doc('settings/clinic'), {
    name: 'Clínica Dental Aurora', addr: 'Calle de la Luz 24, 28004 Madrid', phone: '+34 910 000 000',
    email: 'info@clinicaaurora.example', timezone: 'Europe/Madrid',
    slots: ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00'],
    breakStart: '14:00', breakEnd: '16:00', openEnd: '20:00', privacyVersion: '2026-01', bookingHoldHours: 24
  }, { merge: true });

  const treatments = [
    { id: 'limpieza', n: 'Limpieza dental', min: 45, p: 60, dentistIds: ['d1','d2'], active: true },
    { id: 'ortodoncia', n: 'Ortodoncia', min: 30, p: 90, dentistIds: ['d2'], active: true },
    { id: 'implantes', n: 'Implantes', min: 60, p: 950, dentistIds: ['d1'], active: true },
    { id: 'blanqueamiento', n: 'Blanqueamiento', min: 60, p: 240, dentistIds: ['d1'], active: true },
    { id: 'endodoncia', n: 'Endodoncia', min: 60, p: 180, dentistIds: ['d1'], active: true },
    { id: 'revision', n: 'Revisión', min: 30, p: 35, dentistIds: ['d1','d2'], active: true }
  ];
  for (const t of treatments) batch.set(db.doc('treatments/' + t.id), t, { merge: true });
  batch.set(db.doc('dentists/d1'), { n: 'Dra. Laura Méndez', r: 'Odontología general e implantes', active: true });
  batch.set(db.doc('dentists/d2'), { n: 'Dr. Pablo Serrano', r: 'Ortodoncia', active: true });

  for (const u of [adminUser, reception, d1, d2, patient]) {
    batch.set(db.doc('users/' + u.uid), {
      uid: u.uid, email: u.email, name: u.name, role: u.role, status: 'active',
      patientId: u.role === 'patient' ? 'p1' : '', dentistId: u.dentistId || '',
      phone: '600 000 000', preferences: { lang: 'es', theme: 'system', motion: 'system', notifications: { email: true, sms: false } },
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  batch.set(db.doc('patients/p1'), {
    fn: 'Ana', ln: 'García López', bd: '1988-04-12', ph: '612 345 678', em: 'paciente@aurora.test',
    addr: 'Calle Mayor 1, Madrid', assignedDentistId: 'd1', userId: patient.uid, status: 'active',
    careTeamIds: ['d1'], searchName: 'ana garcía lópez paciente@aurora.test', createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  batch.set(db.doc('patients/p2'), {
    fn: 'Carlos', ln: 'Ruiz Martín', bd: '1975-09-03', ph: '655 112 233', em: 'carlos@example.test',
    addr: '', assignedDentistId: 'd2', userId: '', status: 'active', careTeamIds: ['d2'],
    searchName: 'carlos ruiz martín carlos@example.test', createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const apptBase = {
    patientName: 'Ana García López', treatment: 'revision', treatmentName: 'Revisión', dentistId: 'd1',
    dentistUid: d1.uid, dentistName: 'Dra. Laura Méndez', box: 'Gabinete 1', note: '', req: '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  batch.set(db.doc('appointments/a100'), { ...apptBase, patientId: 'p1', date: today, time: '10:00', status: 'confirmed' });
  batch.set(db.doc('bookedSlots/s_a100'), { date: today, time: '10:00', dentistId: 'd1', appointmentId: 'a100', status: 'confirmed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  batch.set(db.doc('appointments/a101'), { ...apptBase, patientId: 'p2', patientName: 'Carlos Ruiz Martín', treatment: 'limpieza', treatmentName: 'Limpieza dental', dentistId: 'd2', dentistUid: d2.uid, dentistName: 'Dr. Pablo Serrano', date: today, time: '11:30', status: 'pending' });
  batch.set(db.doc('bookedSlots/s_a101'), { date: today, time: '11:30', dentistId: 'd2', appointmentId: 'a101', status: 'pending', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  batch.set(db.doc('appointments/a102'), { ...apptBase, patientId: 'p1', date: '2026-01-15', time: '09:30', status: 'done' });

  batch.set(db.doc('requests/r100'), {
    kind: 'booking', ref: 'AUR-2026-0001', name: 'Sofía Medina', phone: '611223344', email: 'sofia@example.test',
    treatment: 'limpieza', dentistId: 'd1', date: today, time: '16:00', msg: 'Prefiero por la tarde.',
    status: 'new', source: 'web', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.doc('payments/y100'), {
    patientId: 'p1', patientName: 'Ana García López', treatment: 'limpieza', concept: 'Limpieza dental',
    amount: 60, status: 'pending', date: today, createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.doc('consultations/c100'), {
    patientId: 'p1', patientName: 'Ana García López', appointmentId: 'a102', date: '2026-01-15',
    treatment: 'revision', treatmentName: 'Revisión', dentistId: 'd1', dentistUid: d1.uid,
    dentistName: 'Dra. Laura Méndez', notes: 'Sin caries activas.', diagnosis: 'Encías sanas.',
    plan: 'Revisión anual.', evolution: 'Sin incidencias.', sharedSummary: 'Todo correcto. Vuelve en un año.',
    share: true, visibleToPatient: true, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.doc('clinicalSummaries/c100'), {
    patientId: 'p1', consultationId: 'c100', date: '2026-01-15', treatment: 'revision',
    dentistId: 'd1', dentistUid: d1.uid, dentistName: 'Dra. Laura Méndez', summary: 'Todo correcto. Vuelve en un año.',
    sharedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.doc('patients/p1/messages/m100'), {
    patientId: 'p1', senderId: d1.uid, senderRole: 'dentist', senderName: 'Dra. Laura Méndez',
    body: 'Hola Ana, tu revisión fue correcta.', createdAt: admin.firestore.FieldValue.serverTimestamp(), readBy: [d1.uid]
  });
  batch.set(db.doc('patients/p1/documents/doc100'), {
    patientId: 'p1', type: 'consent', fileName: 'consentimiento.pdf', contentType: 'application/pdf', size: 1000,
    storagePath: 'patients/p1/shared/doc100-consentimiento.pdf', visibleToPatient: true, uploadedBy: d1.uid,
    description: 'Consentimiento informado', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.collection('notifications').doc(), {
    userId: patient.uid, type: 'appointment', title: 'Cita confirmada',
    body: 'Tu cita de revisión es hoy a las 10:00.', link: '#paciente-citas', read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();

  console.log('Emulator seed OK');
  console.log(JSON.stringify({
    password,
    admin: adminUser.email, reception: reception.email, dentist1: d1.email, dentist2: d2.email, patient: patient.email
  }, null, 2));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
