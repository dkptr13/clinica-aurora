# Migración de datos locales

## Qué se migra

La versión anterior guardaba en `localStorage` la clave `aurora-demo-v4` con:

```
{ patients, appts, consults, pays, reqs, users, act, seq }
```

Los datos de demostración tenían IDs `p1..p6`, `a1..a99`, `c1..c6`, `y1..y7`, `r1..r2`. La app nueva los excluye para no presentarlos como pacientes reales.

## Paso 1 — Exportar

1. Entra como administrador en el panel.
2. Pulsa **Exportar datos locales**.
3. Descarga `aurora-migracion-local-<fecha>.json`.
4. Guárdalo en una carpeta privada, cifrada si es posible. No lo subas al hosting ni al repositorio.

El JSON contiene un informe de recuentos y los datos en `data`.

## Paso 2 — Simular

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
node scripts\migrate-local-data.js "C:\ruta\privada\aurora-migracion-local-2026-11-25.json"
```

Sin `--apply` **no escribe nada**. Genera `migration-report-<fecha>.json` con:

- recuentos de origen;
- recuentos que se migrarían;
- pacientes/citas/consultas/pagos/solicitudes omitidos y motivo;
- duplicados detectados por `legacyId` o correo.

## Paso 3 — Aplicar

```powershell
node scripts\migrate-local-data.js "C:\ruta\privada\aurora-migracion-local-2026-11-25.json" --apply
```

El script:

- conserva IDs de paciente cuando son seguros; si no, genera `legacy_p_<hash>`;
- crea citas, consultas, resúmenes visibles y pagos con IDs estables (`legacy_a_...`, `legacy_c_...`, etc.);
- crea `bookedSlots` para cada cita no cancelada;
- mantiene relaciones paciente → cita → consulta;
- crea `clinicalSummaries` para consultas compartidas;
- registra `auditLogs` y evita duplicados al repetirlo.

## Paso 4 — Verificar

1. Abre `migration-report-<fecha>.json`.
2. Compara `countsSource` con `countsDestination` y `migrated`.
3. Revisa `skipped` y `duplicates`.
4. En el panel, comprueba:
   - ficha de paciente y citas relacionadas;
   - consulta y resumen visible;
   - pago pendiente;
   - solicitud y su referencia.
5. Comprueba que los pacientes de demostración no aparecen.

## Paso 5 — Autorizar el borrado local

**No borres localStorage antes de la verificación.** Cuando el informe y la revisión estén aprobados, un administrador puede ejecutar en la consola del navegador de cada equipo antiguo:

```js
['aurora-demo-v4','aurora-lang','aurora-motion','aurora-a11y-v1'].forEach(k => localStorage.removeItem(k));
sessionStorage.clear();
```

Hazlo solo después de confirmar recuentos y relaciones. Conserva una copia del JSON en un soporte privado hasta que la clínica apruebe su destrucción.

## Qué no se migra

- `users` de demostración (no tienen UID de Authentication). Las cuentas reales se crean de nuevo; las fichas se vinculan después con `adminLinkPatientAccount` o desde el panel de administración.
- `act` (actividad local): la auditoría real empieza en `auditLogs`.
- `seq`: los IDs nuevos los genera Firestore.
- Preferencias de idioma/tema/movimiento locales: se aplican solo durante la exportación; los usuarios registrados deben iniciar sesión y ajustarlas, o se migran a mano en `users.preferences` si se conoce la cuenta.

## Después de migrar

- Comprueba que cada cita migrada tiene su documento en `bookedSlots` y que la disponibilidad pública coincide.
- Revisa que no haya IDs de solicitud duplicados.
- Revisa los `auditLogs`.
- No importes el JSON de nuevo sin revisar duplicados; el script es idempotente por IDs estables, pero conviene simular antes.

## Vinculación manual ficha ↔ cuenta

El registro de un paciente crea una ficha nueva vinculada a su UID y **no** reutiliza automáticamente una ficha antigua por correo. Esto evita que alguien se apropie de un historial ajeno registrándose con el correo de otra persona.

Si una ficha antigua y una cuenta nueva comparten correo, un administrador debe:

1. Verificar la identidad de la persona (presencial o canal seguro).
2. Comprobar que el correo de la cuenta está verificado.
3. Usar la acción de vinculación desde **Usuarios y roles** o, con una sesión de administrador, `adminLinkPatientAccount({ patientId, uid })`.

La operación comprueba que ninguna de las dos partes esté ya vinculada a otra y registra la acción en `auditLogs`. En modo directo **no** vuelve a verificar el correo en el servidor: esa comprobación es responsabilidad del administrador antes de vincular.
