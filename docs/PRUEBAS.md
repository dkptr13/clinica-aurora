# Pruebas y verificación (modo directo, Spark)

## Automáticas

### Sintaxis y auditoría estática

```powershell
node --check functions/index.js
node --check scripts\bootstrap-admin.js
node --check scripts\export-firestore.js
node --check scripts\import-firestore.js
node --check scripts\migrate-local-data.js
node scripts\static-audit.js
```

La auditoría estática comprueba:

- ausencia de `sessionStorage` e IndexedDB;
- `localStorage` solo en la exportación manual de migración;
- ausencia de `browserLocalPersistence` y `PersistentLocalCache`;
- presencia de `memoryLocalCache`, `inMemoryPersistence` e `initializeAppCheck`;
- una sola instancia de Firestore;
- ausencia de la base demo/`seed()`.

Resultado actual: **OK** (véase `static-audit-report.json`; no se despliega).

### Reglas de Firestore

```powershell
cd tests
npm install
cd ..
firebase emulators:exec --only firestore --project demo-aurora-rules "node --test tests/rules.test.mjs"
```

Resultado actual: **13/13 pruebas OK**.

Cubren:

- anónimo no lee pacientes ni ajustes internos, pero sí `settings/clinic` y `bookedSlots`;
- paciente solo su ficha, sus citas y sus resúmenes; no consultas internas;
- recepción gestiona pacientes pero no historial clínico ni radiografías;
- odontólogo solo pacientes asignados o de su equipo, y sus consultas;
- recepción escribe citas y `bookedSlots` directamente; el paciente no;
- recepción escribe pagos; el paciente no cambia su estado;
- autoregistro: un usuario nuevo puede crear su `users/{uid}` y su `patients/{uid}` en un batch;
- paciente no puede cambiar su propio rol; solo administración cambia roles y estados;
- público puede crear una solicitud pero no una notificación de personal;
- documentos compartidos y mensajes propios visibles; documentos clínicos privados, no;
- notificaciones de otros usuarios, no.

### Exportación / restauración lógica

Probado contra el emulador:

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:GCLOUD_PROJECT='clinicadental-aurora'
node scripts\export-firestore.js "C:\Users\Oscar\AppData\Local\Temp\opencode\aurora-export-test.json"
node scripts\import-firestore.js "C:\Users\Oscar\AppData\Local\Temp\opencode\aurora-export-test.json"
node scripts\import-firestore.js "C:\Users\Oscar\AppData\Local\Temp\opencode\aurora-export-test.json" --apply
```

Resultado: exportación de 46 documentos con subcolecciones; simulación sin escrituras; importación aplicada con los mismos recuentos.

### Emulador completo (manual, ya ejecutado)

```powershell
# Terminal 1
firebase emulators:start --only auth,firestore --project clinicadental-aurora

# Terminal 2
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:GCLOUD_PROJECT='clinicadental-aurora'
node tests\seed-emulator.cjs
```

Abrir `http://127.0.0.1:5500/?emulator=1` (sirviendo el HTML por HTTP) y usar las cuentas impresas por el seed. Contraseña de prueba: `AuroraTest123!`.

Escenarios verificados en modo directo:

| Escenario | Resultado |
|---|---|
| Login admin/recepción/odontólogo/paciente | OK |
| Dashboard con datos de Firestore | OK |
| Autoregistro de paciente y carga de su área | OK |
| Crear paciente desde administración | OK |
| Crear cita desde la interfaz | OK |
| Cita solapada con otro ID en el mismo hueco | Rechazada por la transacción de cliente |
| `bookedSlots` generado al crear y eliminado al cancelar | OK |
| Disponibilidad pública excluye el hueco ocupado | OK |
| Reserva pública crea solicitud | OK |
| Aceptar solicitud crea paciente/cita y slot | OK |
| Consulta clínica con resumen compartido | OK |
| Pago creado desde administración | OK |
| Recarga: sesión desaparece; localStorage/sessionStorage vacíos | OK |

> La comprobación de solapamiento se hace antes de la transacción, no dentro. Un cliente modificado podría crear dos citas en el mismo hueco. No es un fallo de la prueba, es una limitación asumida del modo directo.

## Producción verificada (25/11/2026)

Tras `firebase deploy --only firestore:rules,firestore:indexes,hosting`:

| Comprobación | Resultado |
|---|---|
| HTML servido con modo directo (`directSaveAppointment`, `bookedSlots`) | OK |
| Página pública sin errores de consola | OK |
| `publicAvailability` en producción | OK, 675 huecos con catálogo por defecto |
| Lectura anónima de `patients` | `permission-denied` |
| Lectura anónima de `settings/internal` | `permission-denied` |
| Cabeceras CSP, `X-Frame-Options: DENY`, `no-store`, HSTS | OK |

No se han creado pacientes, usuarios ni solicitudes ficticias en producción.

## Pruebas pendientes en producción

Tras ejecutar `bootstrap-admin.js`:

1. Login real con la cuenta de administración.
2. Crear recepción y odontología desde **Usuarios y roles**.
3. Alta de paciente y de cita desde la interfaz.
4. Ver la cita en el área del paciente y en otro dispositivo.
5. Disponibilidad pública y reserva real.
6. Aceptar la solicitud y comprobar que el hueco desaparece de la web.
7. Registro de un paciente nuevo con correo real.
8. Recuperación de contraseña (correo de Firebase).
9. Cierre de sesión + recarga: debe pedir login.
10. Exportación lógica real con cuenta de servicio y prueba de restauración en emulador.

No se puede probar en producción: Functions, Storage, subida de documentos, PITR ni copias automáticas, porque no están desplegados en Spark.

## Checklist antes de abrir al público (Spark)

- [ ] `firebase deploy --only firestore:rules,firestore:indexes,hosting` completado.
- [ ] Índices en estado `READY`.
- [ ] `bootstrap-admin.js --seed-config` ejecutado con contraseña fuerte.
- [ ] Cuentas de recepción/odontología creadas y vinculadas a `d1/d2`.
- [ ] Prueba de cita, cambio, cancelación, pago, consulta y solicitud.
- [ ] Prueba de aislamiento con dos pacientes y dos odontólogos.
- [ ] Exportación lógica + restauración de prueba documentada.
- [ ] Procedimiento de revisión de `requests` (spam) y `auditLogs`.
- [ ] Política de privacidad/aviso legal revisados.
- [ ] Migración local verificada y autorización de borrado firmada.
- [ ] Formación del personal y revisión de accesos.
- [ ] Limitaciones del modo directo aceptadas por escrito.

