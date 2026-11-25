# Lecturas y escrituras estimadas

Las cifras son orientativas y dependen del número de documentos. El precio real debe calcularse con la tarifa vigente de Google Cloud/Firebase.

## Cargas implementadas

| Momento | Consultas | Documentos aproximados |
|---|---|---:|
| Arranque de la app (público) | `settings/clinic`, `treatments`, `dentists` | 3–20 |
| Login de personal | pacientes (máx. 200), pagos (máx. 600), notificaciones (40) | hasta ~840 |
| Dashboard | citas 10 días, solicitudes (máx. 200) | ~100–300 |
| Agenda | citas del rango visible (máx. 1.200) + solicitudes | ~50–1.200 |
| Pacientes | agenda próximos 180 días | ~100–500 |
| Ficha de paciente | citas, pagos, consultas, documentos y mensajes del paciente | ~20–300 |
| Consultas | últimas 250 | 250 |
| Pagos | últimos 600 | 600 |
| Área de paciente | ficha + citas + resúmenes + pagos + documentos + mensajes + notificaciones | ~100–300 |

Los listeners iniciales de cada sección vuelven a leer el conjunto visible; después, cada cambio cuesta una lectura del documento modificado (no de toda la colección). Los listeners se cancelan al cambiar de sección.

## Escrituras (modo directo)

- Una cita: transacción de cliente con lectura de la cita/paciente, comprobación previa de solapamiento, escritura de `appointments` y `bookedSlots`, más notificación y auditoría (2 escrituras adicionales).
- Una consulta: 1 escritura + 1 resumen si se comparte + notificación + auditoría.
- Un pago: 1 escritura + notificación + auditoría.
- Un mensaje: 1 escritura; la notificación asociada la escribe el cliente autorizado.
- Preferencias: 1 escritura por cambio agrupado (debounce 700 ms).
- Reserva pública: 1 solicitud; al aceptarla, 1–2 escrituras de paciente/cita + slot + notificación + auditoría.
- Migración: 1 escritura por registro, más `bookedSlots` por cita y resúmenes clínicos.

## Medidas de control de coste ya aplicadas

- `inMemoryPersistence` y `MemoryLocalCache`: cada recarga vuelve a leer, pero no se acumula caché persistente con datos clínicos.
- Límites en todas las consultas (`limit`).
- Listeners solo por sección y cancelación al salir.
- `getCountFromServer` para el recuento de pacientes.
- Sin listeners globales sobre todas las colecciones.
- Sin `onSnapshot` en páginas públicas.
- Sin consultas por cada pulsación de búsqueda: la búsqueda de pacientes filtra en memoria sobre la página cargada (máx. 200).

## Recomendaciones si la clínica crece

1. Paginar pacientes con “cargar más” y búsqueda por prefijo `searchName`.
2. Reducir la carga inicial de pagos a los pendientes + últimos 90 días.
3. Cargar la agenda solo para el rango visible (ya se hace) y no 180 días en la lista de pacientes.
4. Activar TTL/limpieza de solicitudes antiguas y notificaciones leídas.
5. Usar `count()` para KPIs en lugar de descargar colecciones.
6. Revisar el número de listeners simultáneos (actualmente agenda, solicitudes, pagos, notificaciones, documentos y mensajes en ficha de paciente).

## Estimación de coste

Con una clínica pequeña (2–4 profesionales, ~30 citas/día), el orden de magnitud es:

- Personal: ~1.000–2.000 lecturas por jornada y usuario, más escrituras de citas/pagos.
- Paciente: ~100–300 lecturas por visita al portal.
- Copias: la exportación de Firestore no genera lecturas de documentos facturables como consultas normales, pero sí coste de operación y almacenamiento.

Para un presupuesto exacto, exporta las métricas de Firestore durante una semana y multiplica por la tarifa vigente. No se debe prometer un coste fijo sin medir.
