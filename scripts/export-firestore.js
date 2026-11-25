'use strict';
/*
 * Exportación lógica de Firestore para el plan Spark (sin Cloud Storage).
 *
 * Uso:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
 *   node scripts\export-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json"
 *
 * No escribe en Firestore. Genera un JSON con todas las colecciones y las
 * subcolecciones de pacientes. Guárdalo cifrado y fuera del repositorio.
 * La restauración debe probarse en un proyecto/base temporal antes de confiar
 * en la copia.
 */
const fs = require('fs');
const path = require('path');
const admin = require('../functions/node_modules/firebase-admin');

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
const outArg = process.argv[2] || `aurora-export-${new Date().toISOString().slice(0, 10)}.json`;
const outPath = path.resolve(outArg);

if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Define GOOGLE_APPLICATION_CREDENTIALS con una cuenta de servicio, o FIRESTORE_EMULATOR_HOST para el emulador.');
  process.exit(1);
}

admin.initializeApp({ projectId });
const db = admin.firestore();

const ROOT_COLLECTIONS = [
  'users', 'patients', 'appointments', 'bookedSlots', 'consultations',
  'clinicalSummaries', 'payments', 'requests', 'notifications',
  'treatments', 'dentists', 'settings', 'auditLogs'
];
const PATIENT_SUBCOLLECTIONS = ['documents', 'messages'];

function encode(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', value: value.toDate().toISOString() };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'reference', path: value.path };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

function snapDoc(snap) {
  return { id: snap.id, data: encode(snap.data()) };
}

async function readCollection(ref) {
  const snap = await ref.get();
  return snap.docs.map(snapDoc);
}

(async () => {
  const exportedAt = new Date().toISOString();
  const collections = {};
  const counts = {};

  for (const name of ROOT_COLLECTIONS) {
    collections[name] = await readCollection(db.collection(name));
    counts[name] = collections[name].length;
  }

  const patientDetails = {};
  for (const patient of collections.patients) {
    const subs = {};
    for (const sub of PATIENT_SUBCOLLECTIONS) {
      subs[sub] = await readCollection(db.collection('patients').doc(patient.id).collection(sub));
      counts[`patients/${patient.id}/${sub}`] = subs[sub].length;
    }
    patientDetails[patient.id] = subs;
  }

  const payload = {
    meta: {
      projectId,
      exportedAt,
      emulator: !!process.env.FIRESTORE_EMULATOR_HOST,
      note: 'Exportación lógica de Firestore. Contiene datos personales y clínicos: cifrar y custodiar.'
    },
    counts,
    collections,
    patientDetails
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ ok: true, file: outPath, exportedAt, counts }, null, 2));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
