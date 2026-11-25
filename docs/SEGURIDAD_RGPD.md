# Seguridad y cumplimiento (RGPD / LOPDGDD)

> Documento técnico de preparación. No es asesoramiento jurídico. La política de privacidad, el registro de actividades de tratamiento y la evaluación de impacto deben ser revisados por el DPO/asesor legal de la clínica antes de la explotación real.

## Ubicación de los datos

Verificado el 25/11/2026:

- Firestore: `europe-west9` (París, Unión Europea).
- Cloud Functions: **no se usan** en el modo directo actual (el código opcional apunta a `europe-west9`).
- Cloud Storage: **no disponible** en Spark; no hay documentos binarios.
- Hosting: CDN global de Firebase; solo sirve el HTML público, no datos de pacientes.

Antes de cambiar región, revisar contratos, transferencias internacionales y la evaluación de impacto. No se ha migrado ningún dato sanitario real: Firestore de producción está vacío.

## Principios aplicados

- **Minimización**: la ficha administrativa no contiene notas clínicas; las notas viven en `consultations`. El paciente solo ve `clinicalSummaries`, una copia saneada.
- **Control de acceso**: roles en `users/{uid}.role` y `status`; las reglas de Firestore los leen con `get()` en cada operación. No se confía en el rol enviado por JavaScript.
- **Trazabilidad**: `auditLogs` registra creación/edición de citas, consultas, pagos, solicitudes, roles y cambios de estado. El paciente no puede leerlos. En modo directo la escribe el cliente autorizado; no es inmutable frente a un cliente manipulado.
- **Confidencialidad**: recepción no accede a consultas, diagnósticos ni radiografías. Odontología solo accede a pacientes asignados/equipo asistencial.
- **Integridad**: citas y pagos se escriben en transacciones de cliente; los solapamientos se comprueban antes de escribir, pero **no hay garantía atómica de servidor**.
- **Documentos**: en Spark no hay Cloud Storage. La subida y descarga de documentos binarios está desactivada y la interfaz lo indica.
- **Registro de pacientes**: crea una ficha nueva vinculada al UID. No reutiliza automáticamente una ficha preexistente por correo, para evitar que alguien se apropie de un historial ajeno; la vinculación la autoriza administración tras verificar identidad.
- **Sesión**: `inMemoryPersistence`; no se persisten credenciales en el dispositivo. Al recargar se exige login.
- **Caché**: `MemoryLocalCache`; no hay persistencia offline con datos clínicos.
- **Copias**: exportación lógica manual con `scripts/export-firestore.js`, cifrada y verificada. Sin copias automáticas ni PITR en Spark.

## Roles

| Rol | Puede | No puede |
|---|---|---|
| `patient` | Su ficha, sus citas, sus pagos, sus documentos compartidos, sus resúmenes, mensajes propios | Otros pacientes, consultas internas, documentos clínicos no compartidos |
| `reception` | Agenda, solicitudes, pacientes, pagos, facturas/documentos administrativos, mensajes | Historial clínico, diagnósticos, radiografías/fotos clínicas |
| `dentist` | Pacientes asignados/equipo, sus citas, consultas, documentos clínicos, mensajes | Pacientes no asignados, pagos, gestión de roles |
| `admin` | Todo, auditoría, copias, roles, configuración | Cambiar su propio rol a otro; eludir las reglas de Firestore |

Los cambios de rol y estado los hace administración directamente sobre `users/{uid}`; las reglas validan el rol y el estado. El cliente no administrador no puede escribir `role` en `users`. La primera cuenta de administración se crea con `scripts/bootstrap-admin.js` y una cuenta de servicio.

## Datos y bases jurídicas (a completar por la clínica)

- **Identificación y contacto**: ejecución del contrato/asistencia sanitaria.
- **Datos de salud**: categoría especial (art. 9 RGPD); base de medicina preventiva/asistencia sanitaria y obligación legal.
- **Facturación**: obligación legal/fiscal.
- **Comunicaciones y recordatorios**: consentimiento e interés legítimo, con opt-out.
- **Documentos de consentimiento**: consentimiento explícito; se almacenan como PDF/imagen privados.
- **Accesibilidad/preferencias**: consentimiento/uso legítimo para adaptar la interfaz.

## Conservación

Orientación técnica, a validar con el asesor legal:

- Historia clínica: mínimo 5 años desde el alta (Ley 41/2002, art. 17), sin perjuicio de plazos autonómicos y de otra normativa aplicable.
- Facturas y documentación fiscal: según obligación fiscal (habitualmente 4-6 años).
- Copias de seguridad: según la política aprobada (por ejemplo, 8–12 exportaciones semanales); no deben usarse para conservar datos más allá de la política.
- Solicitudes web no convertidas: revisar y eliminar/anonimizar cuando dejen de ser necesarias.
- Documentos no reclamados: en Spark no hay documentos binarios; cuando se active Storage, definir política de revisión y borrado seguro.

## Derechos de las personas

Procedimiento recomendado:

1. Verificar identidad.
2. Localizar ficha y documentos por `patients.userId`/correo.
3. Exportar la información (solo a un canal privado).
4. Para supresión, valorar excepciones legales de conservación clínica/fiscal.
5. Registrar la solicitud y la decisión en `auditLogs`/procedimiento interno.
6. Responder en el plazo legal (1 mes, prorrogable).

La app no incorpora todavía una pantalla de “descargar mis datos” ni de supresión automática; debe hacerse con procedimiento administrativo y Admin SDK, con autorización. No borrar registros clínicos sin revisar la obligación de conservación.

## Evaluación de impacto y registro de actividades

Antes de producción, documentar:

- Finalidades y bases jurídicas.
- Categorías de datos y titulares.
- Destinatarios y encargados (Google Cloud/Firebase, proveedor de correo/SMS si se activa).
- Transferencias internacionales y garantías (SCC/DPF; confirmar con Google).
- Plazos de conservación.
- Medidas técnicas y organizativas.
- Evaluación de riesgos para derechos y libertades.
- Procedimiento de brechas de seguridad (72 h a la AEPD si procede).
- Contratos de encargado del tratamiento y designación de DPO si aplica.

## Medidas técnicas pendientes antes de producción

- Desplegar las reglas, los índices y el HTML de modo directo.
- Crear la cuenta de administración con `bootstrap-admin.js` y contraseña fuerte.
- Configurar App Check si se obtiene una site key; no forzarlo sin verificar antes a todo el personal.
- Definir y probar el procedimiento de exportación/restauración lógica.
- Revisar la política de privacidad, cookies y aviso legal (ahora son textos de plantilla).
- Configurar alertas de errores/abuso y revisar `auditLogs` y `requests` con regularidad.
- Definir política de retención aprobada y procedimiento de derechos.
- Formar al personal en acceso mínimo y no compartir cuentas.
- Asumir y documentar las limitaciones del modo directo: sin atomicidad de servidor, sin rate limiting, sin Storage y sin copias automáticas.

## Datos prohibidos en la app

- Números completos de tarjeta, CVV, PIN o secretos de pasarela.
- Contraseñas o claves en Firestore.
- Documentos clínicos en carpetas públicas o enlaces permanentes.
- Exportaciones con datos de salud en el repositorio, hosting o carpetas compartidas.

Las reglas de Firestore rechazan campos como `cardNumber`, `cvv`, `iban`, `pan` o `stripeSecret` en las colecciones validadas.
