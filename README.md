# Clínica Dental Aurora — Firebase en modo directo (plan Spark)

Aplicación sanitaria de una sola página (HTML/CSS/JS) migrada para que **Firebase sea la única fuente de verdad**. No se usa `localStorage`, `sessionStorage` ni IndexedDB para datos de negocio, sesión o pacientes.

Esta entrega funciona **sin Cloud Functions y sin Cloud Storage**, por lo que se puede desplegar en el plan gratuito **Spark**. Las escrituras las hace el navegador autenticado y las reglas de Firestore son las que autorizan o deniegan cada operación.

## Estado real de la entrega

Comprobado el **25/11/2026** contra el proyecto `clinicadental-aurora`:

| Elemento | Estado |
|---|---|
| Firestore `(default)` | Creado en **europe-west9** (París) |
| `firestore.rules` | **Desplegadas**; modo directo; 13/13 pruebas en emulador |
| `firestore.indexes.json` | **Desplegados** |
| Hosting | **Desplegado** en https://clinicadental-aurora.web.app con el HTML de modo directo |
| Cabeceras CSP / no-store | **Verificadas en producción** |
| Authentication | Email/contraseña activado; 0 usuarios reales |
| Cloud Functions | **No usadas ni desplegadas**; el modo directo no las necesita |
| Cloud Storage | **No disponible** en Spark: los documentos binarios están desactivados en la interfaz |
| Copias programadas / PITR | **No disponibles** en Spark; se sustituyen por exportaciones manuales |
| App Check | Código preparado; sin site key, no forzado |
| Datos de producción | Firestore está vacío; no hay usuarios ni datos reales |

> **Aviso:** el modo directo no tiene transacciones de servidor. La detección de solapamientos se hace en una transacción del cliente y puede ser eludida por un cliente manipulado. No hay límite de peticiones en el formulario público. Para una clínica pequeña es aceptable; si se necesita garantía estricta contra dobles reservas o abuso, hace falta Blaze + Functions.

## Arquitectura

- **Auth**: Firebase Authentication con `inMemoryPersistence`. Al recargar hay que iniciar sesión de nuevo.
- **Firestore**: `initializeFirestore` con `memoryLocalCache()`. Sin persistencia offline ni caché persistente.
- **Modo directo**: `window.AURORA_DIRECT_MODE !== false` (valor por defecto). Todas las operaciones van directas a Firestore.
- **Modo Functions opcional**: si algún día se activa Blaze, se puede poner `window.AURORA_DIRECT_MODE = false` y desplegar `functions/`. El código conserva ambas rutas.
- **Roles**: se guardan en `users/{uid}.role` y `users/{uid}.status`. Las reglas los leen con `get()` en cada operación; **nunca** se confía en el rol enviado por JavaScript. En modo directo no se usan Custom Claims.
- **Catálogo público**: `settings/clinic`, `treatments` y `dentists` son de lectura pública; solo administración los escribe.
- **Disponibilidad pública**: se publica en `bookedSlots`, una proyección sin datos del paciente (`date`, `time`, `dentistId`, `appointmentId`, `status`). La mantiene el personal al crear, cambiar o cancelar citas.
- **Tiempo real**: listeners `onSnapshot` por sección. Se cancelan al cambiar de sección; no se duplican.
- **Datos en memoria**: `DB` solo es una proyección de Firestore para pintar la interfaz. No se persiste.
- **Documentos**: en modo directo la subida y apertura de archivos está oculta y bloqueada; requiere Cloud Storage (Blaze).

## Despliegue en Spark (sin Blaze)

### 1. Requisitos

- Node 20+ (probado con Node 24).
- Firebase CLI autenticado: `firebase login`.
- Proyecto en plan **Spark**.

### 2. Instalar dependencias de herramientas

```powershell
cd "C:\Clinica dental\clinica-aurora"
npm --prefix tests install
npm --prefix functions install   # solo para firebase-admin de los scripts; no se despliega Functions
firebase use clinicadental-aurora
```

### 3. Desplegar reglas, índices y web

```powershell
firebase deploy --only firestore:rules,firestore:indexes,hosting
```

No se despliega `functions` ni `storage`. No hace falta activar facturación.

### 4. Crear la primera cuenta de administración

Las reglas no permiten que un usuario se autoproclame administrador, así que la primera cuenta se crea con una cuenta de servicio (Admin SDK). No requiere Blaze.

1. En Firebase Console → Configuración del proyecto → Cuentas de servicio → **Generar nueva clave privada**. Guarda el JSON fuera del repositorio.
2. Ejecuta:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
$env:ADMIN_EMAIL="admin@tudominio.com"
$env:ADMIN_PASSWORD="UnaClaveLargaElegidaPorLaClinica"
$env:ADMIN_NAME="Nombre Apellidos"
node scripts\bootstrap-admin.js --seed-config
```

Esto crea (o actualiza) la cuenta de Authentication, su perfil `users/{uid}` con `role: admin` y, con `--seed-config`, el horario y el catálogo inicial.

3. Entra en la web con esa cuenta.
4. Desde **Usuarios y roles**, crea las cuentas de recepción y odontología. Los odontólogos deben vincularse a `d1`, `d2`… del catálogo.

> El alta de personal usa una instancia secundaria de Auth en el navegador y después crea `users/{uid}`. Si el alta se interrumpe entre ambos pasos, puede quedar una cuenta de Auth sin perfil; en ese caso se corrige desde consola o con un script administrativo.

### 5. App Check (opcional)

El código está preparado, pero **no se fuerza**. Si se configura una site key de reCAPTCHA Enterprise:

1. Copia la clave en la meta del HTML:

```html
<meta name="aurora-appcheck-site-key" content="TU_SITE_KEY">
```

2. Añade el dominio de Hosting a los dominios permitidos de la clave.
3. Vuelve a desplegar Hosting.

No se debe activar el modo bloqueante sin verificar antes que todo el personal y los pacientes pueden obtener tokens.

## Base de datos

### Colecciones

| Colección | Contenido | Escritura en modo directo |
|---|---|---|
| `users/{uid}` | Perfil, rol, estado, preferencias, `dentistId`, `patientId` | Autoregistro de paciente; administración para roles/estados/altas |
| `patients/{id}` | Ficha administrativa; sin notas clínicas | Recepción/administración; autoregistro crea su propia ficha |
| `patients/{id}/documents` | Metadatos de archivos | Sin uso en modo directo (no hay Storage) |
| `patients/{id}/messages` | Mensajería paciente-clínica | Personal autorizado y paciente propietario |
| `appointments` | Citas y estados | Recepción/administración con transacción de cliente |
| `bookedSlots` | Proyección pública de huecos ocupados | Recepción/administración al cambiar citas |
| `consultations` | Historial clínico interno | Administración/odontólogo asignado |
| `clinicalSummaries` | Copia saneada visible al paciente | Administración/odontólogo al compartir |
| `payments` | Pagos y facturas | Recepción/administración |
| `requests` | Reservas web, contacto y cambios | Público (crear); personal (gestionar) |
| `notifications` | Avisos por usuario | Personal autorizado; el usuario solo marca leídas |
| `treatments`, `dentists` | Catálogo | Administración (o bootstrap) |
| `settings/clinic` | Horarios y contacto público | Administración |
| `auditLogs` | Trazabilidad | Personal autenticado; solo administración lee |
| `scheduleLocks`, `counters`, `rateLimits`, `backups` | Reservado para el modo Functions | Cerrado al cliente |

### Relaciones

- `patients.userId` vincula la ficha con la cuenta de Authentication.
- `patients.assignedDentistId` es el ID de catálogo (`d1`), no el UID.
- `users.dentistId` es el ID de catálogo del odontólogo.
- `appointments.dentistId` es el ID de catálogo; `appointments.dentistUid` queda vacío en modo directo.
- `consultations` también guarda `dentistId` y `dentistUid`.
- `clinicalSummaries.consultationId` apunta a la consulta original.
- `bookedSlots.appointmentId` apunta a la cita que ocupa el hueco.

## Seguridad

- Paciente: solo su ficha, sus citas, sus pagos, sus resúmenes y sus mensajes. No lee consultas internas ni documentos no compartidos.
- Recepción: agenda, pacientes, pagos, solicitudes y documentos administrativos. **No** historial clínico ni radiografías.
- Odontólogo: solo pacientes asignados o en su equipo asistencial, sus citas y sus consultas.
- Administración: acceso completo, auditoría y gestión de roles.
- El rol y el estado se leen de `users/{uid}` en cada regla; el cliente no puede escribirlos salvo administración.
- Un paciente solo puede crear su propia ficha durante el autoregistro (`patientId == uid`).
- No se guardan datos de tarjetas; las reglas rechazan campos tipo PAN/CVV/IBAN.
- `localStorage` solo se lee en la exportación manual de migración; nunca se escribe.
- `sessionStorage` e IndexedDB no se usan.

Ver [docs/SEGURIDAD_RGPD.md](docs/SEGURIDAD_RGPD.md) y [docs/COPIAS_SEGURIDAD.md](docs/COPIAS_SEGURIDAD.md).

## Limitaciones asumidas del modo directo

1. **Sin transacciones de servidor**: la cita se guarda en una transacción de Firestore del cliente; la comprobación de solapamiento se hace antes, fuera de la transacción, y otro cliente podría colarse entre la lectura y la escritura.
2. **Sin límite de peticiones**: el formulario público puede recibir spam. Las reglas validan formato y tamaño, pero no frecuencia. Revisar `requests` con regularidad.
3. **Sin Cloud Storage**: no se pueden subir ni abrir documentos binarios. La interfaz lo indica y oculta la acción.
4. **Sin triggers**: notificaciones, resúmenes clínicos y auditoría se escriben desde el propio cliente autorizado. Si una escritura secundaria falla, se registra en consola pero no se reintenta.
5. **Sin copias automáticas ni PITR**: en Spark no hay exportaciones programadas. Hay que hacer exportaciones manuales con una cuenta de servicio (ver docs).
6. **Alta de personal**: usa Auth secundario en el navegador; no hay panel de administración de Auth fuera de la app.
7. **Verificación de correo**: se envía al registrarse, pero en modo directo no bloquea el acceso ni la vinculación automática. La vinculación de una ficha antigua la hace un administrador tras verificar identidad.
8. **App Check no forzado**: sin site key no hay attestation de la app web.

## Migración de datos locales

1. Entra como administrador en la aplicación desplegada.
2. Dashboard → **Exportar datos locales**.
3. Descarga el JSON. Guárdalo en una carpeta privada, nunca en el hosting.
4. Simula la migración:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
node scripts\migrate-local-data.js "C:\ruta\privada\aurora-migracion-local-2026-11-25.json"
```

5. Revisa `migration-report-<fecha>.json`: recuentos, duplicados, descartes.
6. Aplica:

```powershell
node scripts\migrate-local-data.js "C:\ruta\privada\aurora-migracion-local-2026-11-25.json" --apply
```

7. Compara origen/destino, revisa relaciones y **solo entonces** borra las claves locales desde el navegador.

El script excluye los registros de demostración (`p1..p6`, `a1..a99`, `c1..c6`, `y1..y7`, `r1..r2`), usa IDs estables para poder repetirlo sin duplicar y crea `bookedSlots` para las citas migradas. Solo vincula automáticamente una ficha con una cuenta de Authentication si el correo de la cuenta está **verificado**; en caso contrario genera un aviso y la vinculación debe hacerla un administrador tras verificar identidad.

Ver [docs/MIGRACION_DATOS.md](docs/MIGRACION_DATOS.md).

## Copias de seguridad en Spark

No hay copias automáticas. La copia se hace con una exportación lógica:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
node scripts\export-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json"
```

El archivo incluye colecciones y subcolecciones, con IDs y timestamps, y **no** incluye usuarios de Authentication ni contraseñas. Guárdalo cifrado. La restauración se prueba con `scripts/import-firestore.js` (simula por defecto; escribe solo con `--apply`) contra el emulador o un proyecto temporal. Ver [docs/COPIAS_SEGURIDAD.md](docs/COPIAS_SEGURIDAD.md).

## Pruebas realizadas

- `node --check` de Functions, scripts y los dos scripts inline del HTML: **OK**.
- `tests/rules.test.mjs` con emulador de Firestore: **13/13 OK** (aislamiento de pacientes, recepción sin historial, odontólogo asignado, autoregistro, escrituras directas de citas/pagos, solicitudes públicas, roles y notificaciones).
- Emulador Auth + Firestore en modo directo:
  - Login de administración, recepción, odontólogo y paciente.
  - Autoregistro de paciente y carga de su área.
  - Creación de paciente y de cita desde la interfaz.
  - Rechazo de solapamiento con otra cita del mismo odontólogo.
  - Disponibilidad pública excluyendo `bookedSlots`.
  - Reserva pública y aceptación desde recepción.
  - Consulta clínica con resumen compartido y pago.
  - Recarga: la sesión desaparece y se exige login de nuevo.
- Hosting desplegado y verificado: el HTML servido contiene el modo directo, la página pública carga sin errores y `publicAvailability` responde en producción.
- Reglas desplegadas y verificadas: lectura anónima de `patients` y `settings/internal` devuelve `permission-denied`.
- **Pendiente**: prueba de humo con la cuenta de administración real (crear recepción/odontología, paciente, cita y reserva pública). No se han creado datos ficticios en producción.

Ver [docs/PRUEBAS.md](docs/PRUEBAS.md).

## Lecturas/escrituras

Ver [docs/LECTURAS_ESCRITURAS.md](docs/LECTURAS_ESCRITURAS.md). En resumen: una sesión de personal carga unos cientos de documentos una vez y luego usa listeners; el paciente carga solo su información. Los límites actuales son 200 pacientes, 600 pagos y 40 notificaciones por sesión.

## Estructura

```
Clinica_Dental_Aurora_accesible (1).html   Aplicación completa (UI + servicios Firebase)
firestore.rules                             Reglas de Firestore (modo directo)
firestore.indexes.json                      Índices compuestos
firebase.json                               Hosting, cabeceras y emuladores
functions/index.js                          Cloud Functions opcionales (no desplegadas)
scripts/bootstrap-admin.js                  Primera cuenta admin + configuración
scripts/export-firestore.js                 Exportación lógica manual (Spark)
scripts/import-firestore.js                 Restauración/simulación de la exportación
scripts/migrate-local-data.js               Migración idempotente desde localStorage
scripts/static-audit.js                     Auditoría de persistencia local
tests/rules.test.mjs                        Pruebas de reglas con emulador
tests/seed-emulator.cjs                     Datos ficticios SOLO para emulador
docs/                                       Seguridad, copias, pruebas, migración
```

