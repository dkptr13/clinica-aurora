'use strict';
/*
 * Restauración lógica de una exportación creada con scripts/export-firestore.js.
 *
 * Uso:
 *   # Simulación (no escribe nada)
 *   node scripts\import-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json"
 *
 *   # Aplicar contra el emulador
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   node scripts\import-firestore.js "...json" --apply
 *
 *   # Aplicar contra un proyecto real (peligroso, requiere confirmación explícita)
 *   $env:ALLOW_PRODUCTION_IMPORT='yes'
 *   node scripts\import-firestore.js "...json" --apply
 *
 * Sobrescribe los documentos con los mismos IDs. No borra documentos que no
 * estén en la exportación. No restaura usuarios de Authentication.
 */
const fs = require('fs');
const path = require('path');
const admin = require('../functions/node_modules/firebase-admin');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts\\import-firestore.js <aurora-export.json> [--apply]');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
if (apply && !emulator && process.env.ALLOW_PRODUCTION_IMPORT !== 'yes') {
  console.error('Para escribir en un proyecto real define ALLOW_PRODUCTION_IMPORT=yes. Se recomienda probar antes en el emulador o en un proyecto temporal.');
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
if (!payload || !payload.collections || !payload.collections.patients) {
  console.error('El archivo no tiene el formato esperado (collections/patients).');
  process.exit(1);
}
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Define GOOGLE_APPLICATION_CREDENTIALS, o FIRESTORE_EMULATOR_HOST para el emulador.');
  process.exit(1);
}

admin.initializeApp({ projectId });
const db = admin.firestore();

function decode(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'object') {
    if (value.__type === 'timestamp') return admin.firestore.Timestamp.fromDate(new Date(value.value));
    if (value.__type === 'geopoint') return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    if (value.__type === 'reference') return db.doc(value.path);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

(async () => {
  let batch = db.batch();
  let pending = 0;
  const written = {};
  let total = 0;

  async function flush() {
    if (!pending) return;
    if (apply) await batch.commit();
    batch = db.batch();
    pending = 0;
  }

  async function write(ref, data, key) {
    total += 1;
    written[key] = (written[key] || 0) + 1;
    if (!apply) return;
    batch.set(ref, decode(data));
    pending += 1;
    if (pending >= 400) await flush();
  }

  for (const [name, docs] of Object.entries(payload.collections)) {
    if (!Array.isArray(docs)) continue;
    for (const item of docs) await write(db.collection(name).doc(item.id), item.data, name);
  }

  for (const [patientId, subs] of Object.entries(payload.patientDetails || {})) {
    for (const [sub, docs] of Object.entries(subs || {})) {
      if (!Array.isArray(docs)) continue;
      for (const item of docs) {
        await write(db.collection('patients').doc(patientId).collection(sub).doc(item.id), item.data, `patients/${sub}`);
      }
    }
  }

  await flush();
  console.log(JSON.stringify({
    ok: true,
    apply,
    projectId,
    emulator,
    file: path.resolve(file),
    exportedAt: payload.meta && payload.meta.exportedAt,
    documents: total,
    written,
    note: apply ? 'Importación aplicada. No se han borrado documentos ausentes.' : 'Simulación: no se ha escrito nada. Repite con --apply.'
  }, null, 2));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
