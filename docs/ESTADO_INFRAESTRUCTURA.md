# Estado de infraestructura (25/11/2026)

Proyecto: `clinicadental-aurora` (`396575884505`).

## Decisión de arquitectura

La clínica **no va a activar Blaze**. Por tanto la aplicación funciona en **modo directo**: el navegador autenticado escribe en Firestore y las reglas de seguridad autorizan cada operación. No se usan Cloud Functions ni Cloud Storage.

El modo Functions sigue en el código como opción futura (`window.AURORA_DIRECT_MODE = false`), pero **no forma parte del despliegue actual**.

## Verificado

| Recurso | Dato |
|---|---|
| Firestore | `projects/clinicadental-aurora/databases/(default)`, NATIVE, **europe-west9** |
| Firestore rules | **Desplegadas** para modo directo; 13/13 pruebas OK en emulador |
| Firestore indexes | **Desplegados**; sin índices nuevos para el modo directo |
| Hosting | https://clinicadental-aurora.web.app, **HTML de modo directo desplegado** |
| Cabeceras | CSP, `X-Frame-Options: DENY`, `Cache-Control: no-store` verificadas en producción |
| Authentication | Proveedor email/password activado; 0 usuarios reales |
| Datos | Firestore real vacío (sin pacientes, citas, consultas ni pagos) |
| Cloud Functions | No desplegadas; no son necesarias en modo directo |
| Cloud Storage | No existe bucket; los documentos binarios están desactivados |
| Copias / PITR | No disponibles en Spark; se sustituyen por exportación manual |

## Qué funciona sin Blaze

- Web pública, disponibilidad y reserva (crea una solicitud).
- Autenticación por correo/contraseña.
- Autoregistro de pacientes con ficha propia.
- Panel de administración, recepción y odontología.
- Citas, cambios de estado, pacientes, pagos y solicitudes.
- Consultas clínicas y resúmenes compartidos con el paciente.
- Notificaciones internas y auditoría escritas por el cliente.
- Preferencias y accesibilidad en `users.preferences`.

## Limitaciones reales en Spark

1. **No hay garantía atómica de no solapamiento**: la comprobación se hace en una transacción de cliente.
2. **No hay límite de peticiones** en el formulario público.
3. **No hay Cloud Storage**: no se pueden subir ni abrir documentos binarios.
4. **No hay triggers**: las escrituras secundarias (notificación, resumen, auditoría) las hace el cliente y no se reintentan si fallan.
5. **No hay copias programadas ni PITR**.
6. **No hay App Check forzado** hasta configurar una site key.
7. **Alta de personal** desde el navegador con Auth secundario; no hay consola de Auth dentro de la app.

## Qué hacer para poner en producción

1. ~~`firebase deploy --only firestore:rules,firestore:indexes,hosting`.~~ **Hecho y verificado el 25/11/2026.**
2. Ejecutar `scripts/bootstrap-admin.js --seed-config` con una cuenta de servicio. **Pendiente.**
3. Entrar como administrador y crear las cuentas de recepción/odontología. **Pendiente.**
4. Probar en producción: login, alta de paciente, cita, disponibilidad pública, reserva y aceptación. **Pendiente.**
5. Definir el procedimiento de exportación manual y probar una restauración lógica. **Herramientas listas y probadas en emulador.**

No hace falta activar Blaze para estos pasos.

