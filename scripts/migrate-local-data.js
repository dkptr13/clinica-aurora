'use strict';
/*
 * Migración de los datos exportados desde el navegador (localStorage) a Firestore.
 *
 * Uso:
 *   node scripts/migrate-local-data.js ruta/al/aurora-migracion-local-YYYY-MM-DD.json
 *   node scripts/migrate-local-data.js ruta/al/export.json --apply
 *
 * Por defecto solo simula (dry-run). Nunca borra el JSON ni localStorage.
 * Requiere credenciales de servicio con permisos de Firestore:
 *   GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccount.json
 *   GCLOUD_PROJECT=clinicadental-aurora
 *
 * El JSON debe ser el descargado por "Exportar datos locales" en el panel de
 * administración: { report, data: { patients, appts, consults, pays, reqs } }.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');
const { Timestamp } = admin.firestore;

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
if (!input) {
  console.error('Uso: node scripts/migrate-local-data.js <export.json> [--apply]');
  process.exit(1);
}
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Define GOOGLE_APPLICATION_CREDENTIALS o FIRESTORE_EMULATOR_HOST antes de ejecutar la migración.');
  process.exit(1);
}
admin.initializeApp({ projectId });
const db = admin.firestore();
const auth = admin.auth();
const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
const data = payload.data || payload;

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const timeOk = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const demoFor = (kind, o) => {
  if (!o || o.demo === true) return true;
  if (kind === 'patients') return /^p[1-6]$/.test(o.id || '') && /@correo\.example$/i.test(o.em || '');
  if (kind === 'appts') return /^a\d{1,2}$/.test(o.id || '');
  if (kind === 'consults') return /^c[1-6]$/.test(o.id || '');
  if (kind === 'pays') return /^y[1-7]$/.test(o.id || '');
  if (kind === 'reqs') return /^r[12]$/.test(o.id || '');
  return false;
};
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && !demoFor('', x)) : []);
const real = (kind) => (Array.isArray(data[kind]) ? data[kind].filter((o) => !demoFor(kind, o)) : []);

const report = {
  generatedAt: new Date().toISOString(),
  projectId,
  apply,
  source: path.basename(input),
  countsSource: { patients: real('patients').length, appts: real('appts').length, consults: real('consults').length, pays: real('pays').length, reqs: real('reqs').length, users: arr(data.users).length },
  migrated: { patients: 0, appts: 0, consults: 0, pays: 0, reqs: 0, summaries: 0 },
  skipped: [],
  warnings: [],
  duplicates: []
};

let batch = db.batch();
let ops = 0;
const pending = [];
async function flush() {
  if (!ops) return;
  if (apply) await batch.commit();
  batch = db.batch();
  ops = 0;
}
function queue(ref, value, options = { merge: true }) {
  batch.set(ref, value, options);
  ops += 1;
  if (ops >= 400) pending.push(flush());
}

(async () => {
  // 1) Pacientes
  const patientIdMap = new Map();
  const patientRefMap = new Map();
  for (const p of real('patients')) {
    if (!p.fn || !p.ln) { report.skipped.push({ kind: 'patient', id: p.id, reason: 'sin nombre' }); continue; }
    const legacyId = safeId(p.id);
    let docId = legacyId;
    if (!docId) docId = 'legacy_p_' + hash(`${p.fn}|${p.ln}|${p.bd || ''}|${p.em || ''}`);
    const existing = await db.collection('patients').where('legacyId', '==', legacyId).limit(1).get();
    let byEmail = { empty: true, docs: [] };
    if (existing.empty && p.em) byEmail = await db.collection('patients').where('em', '==', String(p.em).toLowerCase()).limit(1).get();
    const chosen = !existing.empty ? existing : byEmail;
    const target = chosen.empty ? db.collection('patients').doc(docId) : chosen.docs[0].ref;
    const duplicated = !chosen.empty && chosen.docs[0].id !== docId;
    if (duplicated) report.duplicates.push({ kind: 'patient', id: p.id, existing: chosen.docs[0].id });
    const now = Timestamp.now();
    const doc = {
      fn: String(p.fn).trim(), ln: String(p.ln).trim(), bd: dateOk(p.bd) ? p.bd : '', ph: String(p.ph || '').slice(0, 30),
      em: String(p.em || '').toLowerCase().slice(0, 254), addr: String(p.addr || '').slice(0, 300),
      assignedDentistId: /^d\d+$/.test(p.assignedDentistId || '') ? p.assignedDentistId : '',
      userId: '', status: 'active',
      searchName: `${p.fn} ${p.ln} ${p.em || ''}`.toLowerCase(),
      legacyId, demo: false, migrated: true, updatedAt: now, ...(chosen.empty ? { createdAt: now, createdBy: 'local-migration' } : {})
    };
    queue(target, doc);
    patientIdMap.set(p.id, target.id);
    patientRefMap.set(p.id, target);
    report.migrated.patients += 1;
  }
  await flush();

  // 1b) Vincular fichas con cuentas de Authentication ya existentes por correo.
  if (apply) {
    for (const p of real('patients')) {
      if (!p.em) continue;
      const target = patientRefMap.get(p.id);
      if (!target) continue;
      const userSnap = await db.collection('users').where('email', '==', String(p.em).toLowerCase()).limit(1).get();
      if (userSnap.empty) continue;
      const userDoc = userSnap.docs[0];
      const user = userDoc.data();
      if (user.role !== 'patient') continue;
      let authUser;
      try { authUser = await auth.getUser(userDoc.id); } catch { continue; }
      if (!authUser.emailVerified) {
        report.warnings.push({ kind: 'patient', id: p.id, reason: 'cuenta sin correo verificado; no se vincula automáticamente', userId: userDoc.id });
        continue;
      }
      if (user.patientId && user.patientId !== target.id) {
        report.warnings.push({ kind: 'patient', id: p.id, reason: 'la cuenta ya está vinculada a otra ficha', userId: userDoc.id });
        continue;
      }
      await target.set({ userId: userDoc.id, updatedAt: Timestamp.now() }, { merge: true });
      await userDoc.ref.set({ patientId: target.id, updatedAt: Timestamp.now() }, { merge: true });
    }
  }

  // 2) Citas
  for (const a of real('appts')) {
    const pid = patientIdMap.get(a.patientId);
    if (!pid) { report.skipped.push({ kind: 'appointment', id: a.id, reason: 'paciente no migrado' }); continue; }
    if (!dateOk(a.date) || !timeOk(a.time)) { report.skipped.push({ kind: 'appointment', id: a.id, reason: 'fecha/hora inválida' }); continue; }
    const legacyId = safeId(a.id);
    const ref = db.doc('appointments/legacy_a_' + legacyId);
    const dentistId = /^d\d+$/.test(a.dentist || '') ? a.dentist : 'd1';
    queue(ref, {
      patientId: pid, patientName: `${(data.patients || []).find((x) => x.id === a.patientId)?.fn || ''} ${(data.patients || []).find((x) => x.id === a.patientId)?.ln || ''}`.trim(),
      treatment: a.treatment || 'revision', treatmentName: a.treatmentName || '',
      dentistId, dentistUid: '', dentistName: a.dentistName || '',
      date: a.date, time: a.time, status: ['pending', 'confirmed', 'cancelled', 'done'].includes(a.status) ? a.status : 'confirmed',
      box: a.box || '', note: '', req: a.req || '', legacyId, demo: false, migrated: true,
      createdAt: Number(a.createdAt) ? Timestamp.fromMillis(Number(a.createdAt)) : Timestamp.now(), updatedAt: Timestamp.now()
    });
    const apptStatus = ['pending', 'confirmed', 'cancelled', 'done'].includes(a.status) ? a.status : 'confirmed';
    if (apptStatus !== 'cancelled') {
      queue(db.doc('bookedSlots/s_legacy_a_' + legacyId), {
        date: a.date, time: a.time, dentistId, appointmentId: 'legacy_a_' + legacyId,
        status: apptStatus, updatedAt: Timestamp.now(), migrated: true
      });
    }
    report.migrated.appts += 1;
  }
  await flush();

  // 3) Consultas clínicas + resúmenes visibles
  for (const c of real('consults')) {
    const pid = patientIdMap.get(c.patientId);
    if (!pid) { report.skipped.push({ kind: 'consultation', id: c.id, reason: 'paciente no migrado' }); continue; }
    const legacyId = safeId(c.id);
    const ref = db.doc('consultations/legacy_c_' + legacyId);
    const shared = String(c.shared || '').trim();
    const share = c.share === true && !!shared;
    queue(ref, {
      patientId: pid, appointmentId: '', date: dateOk(c.date) ? c.date : '',
      treatment: c.treatment || 'revision', treatmentName: c.treatmentName || '',
      dentistId: c.dentist || 'd1', dentistUid: '', dentistName: c.dentistName || '',
      notes: String(c.notes || '').slice(0, 20000), diagnosis: String(c.diagnosis || '').slice(0, 10000),
      plan: String(c.plan || '').slice(0, 10000), evolution: String(c.evolution || '').slice(0, 10000),
      sharedSummary: shared.slice(0, 5000), share, visibleToPatient: share, attachments: [],
      legacyId, demo: false, migrated: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), createdBy: 'local-migration'
    });
    if (share) {
      queue(db.doc('clinicalSummaries/legacy_c_' + legacyId), {
        patientId: pid, consultationId: 'legacy_c_' + legacyId, date: c.date || '',
        treatment: c.treatment || 'revision', dentistId: c.dentist || 'd1', dentistUid: '', dentistName: c.dentistName || '',
        summary: shared.slice(0, 5000), sharedAt: Timestamp.now(), updatedAt: Timestamp.now(),
        migrated: true, createdBy: 'local-migration'
      });
      report.migrated.summaries += 1;
    }
    report.migrated.consults += 1;
  }
  await flush();

  // 4) Pagos
  for (const y of real('pays')) {
    const pid = patientIdMap.get(y.patientId);
    if (!pid) { report.skipped.push({ kind: 'payment', id: y.id, reason: 'paciente no migrado' }); continue; }
    const legacyId = safeId(y.id);
    queue(db.doc('payments/legacy_y_' + legacyId), {
      patientId: pid, treatment: y.treatment || 'revision', concept: y.concept || y.treatment || 'Tratamiento',
      amount: Number(y.amount) || 0, status: ['pending', 'paid', 'refunded', 'void'].includes(y.status) ? y.status : 'pending',
      date: dateOk(y.date) ? y.date : new Date().toISOString().slice(0, 10), legacyId, demo: false,
      migrated: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), createdBy: 'local-migration'
    });
    report.migrated.pays += 1;
  }
  await flush();

  // 5) Solicitudes
  for (const r of real('reqs')) {
    const legacyId = safeId(r.id);
    queue(db.doc('requests/legacy_r_' + legacyId), {
      kind: r.kind === 'booking' ? 'booking' : 'callback', ref: r.ref || '', name: String(r.name || '').slice(0, 120),
      phone: String(r.phone || '').slice(0, 30), email: String(r.email || '').toLowerCase().slice(0, 254),
      patientId: patientIdMap.get(r.patientId) || '', treatment: r.treatment || 'otro',
      dentistId: /^d\d+$/.test(r.dentist || '') ? r.dentist : '', date: dateOk(r.date) ? r.date : '', time: timeOk(r.time) ? r.time : '',
      msg: String(r.msg || '').slice(0, 1000), status: ['new', 'accepted', 'rejected', 'expired'].includes(r.status) ? r.status : 'new',
      source: 'local-migration', legacyId, demo: false, migrated: true,
      createdAt: Number(r.created) ? Timestamp.fromMillis(Number(r.created)) : Timestamp.now(), updatedAt: Timestamp.now()
    });
    report.migrated.reqs += 1;
  }
  await flush();
  await Promise.all(pending);

  // Contador de referencias por encima de las solicitudes existentes.
  if (apply) {
    const allRequests = await db.collection('requests').get();
    let maxRef = 0;
    allRequests.forEach((d) => {
      const m = String(d.data().ref || '').match(/^AUR-\d{4}-(\d{1,6})$/);
      if (m) maxRef = Math.max(maxRef, Number(m[1]));
    });
    await db.doc('counters/requests').set({ value: maxRef, updatedAt: Timestamp.now() }, { merge: true });
    report.counterRequests = maxRef;
  }

  // 6) Verificación de recuentos destino
  async function countQuery(name, whereField, whereValue) {
    let q = db.collection(name);
    if (whereField) q = q.where(whereField, '==', whereValue);
    const snap = await q.count().get();
    return snap.data().count;
  }
  report.countsDestination = {
    patients: await countQuery('patients', 'migrated', true),
    appts: await countQuery('appointments', 'migrated', true),
    consults: await countQuery('consultations', 'migrated', true),
    pays: await countQuery('payments', 'migrated', true),
    reqs: await countQuery('requests', 'migrated', true),
    summaries: await countQuery('clinicalSummaries', 'migrated', true)
  };

  if (apply) {
    await db.collection('auditLogs').add({
      actorUid: 'migration-script', actorRole: 'system', action: 'data.local_migration',
      entity: 'migration', entityId: path.basename(input), at: Timestamp.now(),
      meta: { ...report.countsSource, migrated: report.migrated, skipped: report.skipped.length, duplicates: report.duplicates.length }
    });
  }
  const out = path.join(process.cwd(), `migration-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nInforme escrito en ${out}`);
  console.log(apply ? 'Migración aplicada. Revisa los recuentos y las relaciones antes de borrar localStorage.' : 'Simulación completada. Usa --apply para escribir en Firestore.');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
