'use strict';
/* Auditoría estática de la migración. Falla si encuentra persistencia local
 * de datos de negocio o configuraciones prohibidas. No sustituye a las pruebas
 * de seguridad con emulador. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'Clinica_Dental_Aurora_accesible (1).html');
const html = fs.readFileSync(htmlPath, 'utf8');
const lines = html.split(/\r?\n/);
const issues = [];
const findings = { localStorage: [], sessionStorage: [], indexedDB: [], persistence: [], listeners: 0, getDocs: 0, onSnapshot: 0, appCheck: false, memoryCache: false, inMemoryAuth: false };

lines.forEach((line, i) => {
  const n = i + 1;
  const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
  if (/localStorage\./.test(line)) findings.localStorage.push({ line: n, text: line.trim().slice(0, 220) });
  if (/sessionStorage\./.test(line)) findings.sessionStorage.push({ line: n, text: line.trim().slice(0, 220) });
  if (/indexedDB\./.test(line)) findings.indexedDB.push({ line: n, text: line.trim().slice(0, 220) });
  if (!isComment && (line.includes('browserLocalPersistence') || line.includes('persistentLocalCache') || line.includes('PersistentLocalCache'))) findings.persistence.push({ line: n, text: line.trim().slice(0, 220) });
  if (line.includes('onSnapshot(')) findings.onSnapshot += 1;
  if (line.includes('getDocs(')) findings.getDocs += 1;
  if (/initializeAppCheck/.test(line)) findings.appCheck = true;
  if (/memoryLocalCache/.test(line)) findings.memoryCache = true;
  if (/inMemoryPersistence/.test(line)) findings.inMemoryAuth = true;
});

// La única lectura de localStorage permitida es la exportación manual de datos
// antiguos para el script de migración.
for (const hit of findings.localStorage) {
  if (!/localKeys|openMigrationExport|migracion-local/.test(hit.text)) {
    issues.push(`localStorage fuera de la exportación de migración (línea ${hit.line}): ${hit.text}`);
  }
}
if (findings.sessionStorage.length) issues.push('sessionStorage sigue presente.');
if (findings.indexedDB.length) issues.push('IndexedDB sigue presente.');
if (findings.persistence.length) issues.push('Persistencia local de Firestore/Auth detectada: ' + findings.persistence.map((x) => `línea ${x.line}`).join(', '));
if (!findings.memoryCache) issues.push('No se ha encontrado memoryLocalCache.');
if (!findings.inMemoryAuth) issues.push('No se ha encontrado inMemoryPersistence.');
if (!findings.appCheck) issues.push('No se ha encontrado initializeAppCheck.');

const forbiddenDemo = ['function seed()', "const KEY='aurora-demo-v4'"].filter((needle) => html.includes(needle));
if (forbiddenDemo.length) issues.push('Restos de la base local/demo: ' + forbiddenDemo.join(', '));

// Comprueba que el módulo no crea varias instancias de Firestore.
const initializeFirestore = (html.match(/initializeFirestore\(/g) || []).length;
if (initializeFirestore > 1) issues.push(`initializeFirestore aparece ${initializeFirestore} veces.`);
const getFirestore = (html.match(/getFirestore\(/g) || []).length;
if (getFirestore) issues.push('getFirestore() aparece además de initializeFirestore().');

const report = {
  generatedAt: new Date().toISOString(),
  file: path.basename(htmlPath),
  bytes: Buffer.byteLength(html, 'utf8'),
  findings,
  issues,
  pass: issues.length === 0
};
fs.writeFileSync(path.join(root, 'static-audit-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exit(issues.length ? 1 : 0);
