# Copias de seguridad, recuperación y continuidad (plan Spark)

> Estado actual: el proyecto `clinicadental-aurora` está en Spark. **No hay copias automáticas, PITR ni buckets**. La estrategia se basa en exportaciones lógicas manuales y en probar la restauración.

## Estrategia en modo directo

| Medida | Frecuencia | Herramienta |
|---|---|---|
| Exportación lógica completa | Semanal y antes de cambios importantes | `scripts/export-firestore.js` |
| Verificación del archivo | Cada exportación | Revisar recuentos y abrir el JSON |
| Prueba de restauración | Mensual | `scripts/import-firestore.js` contra el emulador o un proyecto temporal |
| Revisión de auditoría | Semanal | Consola de Firestore o panel de administración |
| Exportación de datos locales antiguos | Una vez, al migrar | `scripts/migrate-local-data.js` |

## Exportación manual

Requisitos:

- Cuenta de servicio del proyecto con permiso de lectura de Firestore.
- `firebase-admin` instalado en `functions/node_modules` (`npm --prefix functions install`).
- Un soporte privado y cifrado para el archivo.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\privada\serviceAccount.json"
node scripts\export-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json"
```

El script:

- lee todas las colecciones y las subcolecciones `documents` y `messages` de cada paciente;
- conserva los IDs originales;
- convierte timestamps, referencias y geopuntos a un formato JSON legible;
- incluye recuentos en `counts` y metadatos de la exportación;
- **no escribe nada** en Firestore.

El archivo contiene datos personales y clínicos. Guárdalo cifrado, con acceso restringido, y no lo subas al repositorio, al hosting ni a carpetas compartidas. El `.gitignore` excluye `aurora-export-*.json`, pero eso no sustituye al cifrado.

## Restauración y prueba

El script de importación escribe **solo** con `--apply`. Sin ese argumento simula y muestra recuentos.

```powershell
# Prueba segura contra el emulador
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:GCLOUD_PROJECT='clinicadental-aurora'
node scripts\import-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json"
node scripts\import-firestore.js "C:\ruta\privada\aurora-export-2026-11-25.json" --apply
```

Para una prueba más realista, usa un proyecto Firebase temporal y una base Firestore vacía. Nunca importes una copia de prueba sobre `(default)` de producción sin ventana de mantenimiento y una exportación previa verificada.

Comprobación mínima tras restaurar:

1. Los recuentos coinciden con `counts`.
2. Existen los usuarios y las fichas de pacientes.
3. Una cita tiene su `bookedSlots` correspondiente.
4. Una consulta compartida tiene su `clinicalSummaries`.
5. Un pago y una solicitud conservan sus relaciones.
6. Se puede iniciar sesión con una cuenta restaurada (las contraseñas viven en Auth, no en Firestore; la exportación **no** incluye credenciales).
7. La disponibilidad pública coincide con las citas no canceladas.

> La exportación lógica **no incluye usuarios de Authentication**. Tras una restauración, las cuentas deben existir en Auth con el mismo UID. Si se pierde el proyecto de Auth, habrá que recrear las cuentas y volver a vincularlas por UID; por eso es importante conservar también la configuración y las cuentas de Auth.

## Si algún día se activa Blaze

El código de `functions/` conserva las copias automáticas y PITR, pero **no están desplegadas**. Con Blaze se podría:

- exportar Firestore a un bucket privado en `europe-west9`;
- programar copias diarias y retención;
- activar PITR y protección de borrado;
- copiar documentos de Storage.

Mientras tanto, no se debe afirmar que existe una copia automática ni una recuperación a un punto en el tiempo.

## Retención y protección

- Define una retención aprobada por la clínica (por ejemplo, 8–12 exportaciones semanales).
- Rota y destruye las copias antiguas de forma segura.
- Mantén al menos una copia fuera del equipo principal y cifrada.
- No descargues copias con datos de salud a equipos compartidos, correo o servicios sin contrato de encargado.
- Cifrado en reposo del soporte + TLS si se transfiere.
- Registra cada exportación y cada prueba de restauración en el procedimiento interno.

## Limitaciones que no se pueden resolver en Spark

- No hay recuperación a un punto en el tiempo (PITR).
- No hay copia automática si nadie ejecuta el script.
- No hay protección de borrado de la base.
- No hay copia de documentos binarios porque no hay Storage.
- La exportación lógica no captura las contraseñas ni la configuración de Authentication.
