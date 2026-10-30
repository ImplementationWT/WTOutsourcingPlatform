# Rework de la plataforma: Comercial, Operativa y Financiera

Estado: **Fase 1 (Operativa) y Fase 2 (Comercial) implementadas**; falta Read.ai y la Fase 3 (Financiera). 29 de octubre de 2026.

El objetivo es que Launchpad deje de ser solo el orquestador de apps de clientes y pase a ser el
sistema único de la empresa, reemplazando Monday. No se crea otro sistema: se extiende el actual
(mismo panel React, misma API Fastify, misma base MongoDB, mismos usuarios, equipos, auditoría y
redacción de secretos).

## 1. Qué se reutiliza y qué es nuevo

| Ya existe | Se reutiliza para |
|---|---|
| Usuarios, sesiones, bloqueo por intentos, equipos (`UserDirectory`) | Login único de toda la empresa |
| `teamId` y `canSeeClient` / `clientScope` | Aislamiento de proyectos por equipo |
| `AdminStore.audit` | Auditoría de todo lo nuevo |
| `redact` + `sendOnce` | Que ningún secreto salga en JSON; revelar una credencial una sola vez |
| `lib/server-cipher.ts` (AES-256-GCM con contexto autenticado) | Vault de cuentas por proyecto |
| `ClientDoc` (app aprovisionada) | Se enlaza al proyecto operativo con `clientSlug`; no se mezcla |
| AI Developer y costos | Costos de IA entran a la rentabilidad del proyecto (Fase 3) |

Nombres: en el código actual "proyecto/cliente" es la **app aprovisionada** (repo + base + VPS). En
el dominio de negocio "proyecto" es el **proyecto del cliente**. Para no romper nada, el proyecto
de negocio vive en su propia colección (`ops_projects`) y apunta opcionalmente a la app
(`clientSlug`). En el menú, lo existente pasa a llamarse **Infraestructura**.

## 2. Roles

Hoy: `boss | lead | developer`. Se agregan dos roles sin equipo:

| Rol | Comercial | Operativa | Financiera |
|---|---|---|---|
| `boss` (CEO/CCO) | todo | todo | todo |
| `commercial` (Marketing) | todo | solo lectura de proyectos | sin acceso |
| `lead` (Team Leader) | sin acceso | proyectos de su equipo | sus comisiones |
| `developer` | sin acceso | proyectos de su equipo | sus comisiones |
| `finance` | sin acceso | solo lectura | todo |

Las cuentas del vault solo las ven `boss` y los miembros del equipo del proyecto.

## 3. Modelo de datos

### 3.1 Comercial (Fase 2, implementada)

Solo para `boss` y `commercial` (`/api/sales/*`; el resto recibe 403).

- **`sales_lead_sources`**: `name` (único), `kind` (`webhook | form | manual | import`),
  `ingestKeyHash` (SHA-256 de la clave; la clave se muestra una sola vez al crearla o rotarla),
  `keyHint`, `mapping` (`[{ from: "contact.email", to: "email" }]`), `active`, `received`,
  `lastReceivedAt` y `sampleKeys` (campos del último envío, para armar el mapeo).
- **`sales_leads`**: `status` (`new → contacted → demo → proposal_sent → won | lost`), `company`,
  `contactName`, `email`, `phone`, `notes`, `ownerUserId`, `externalId`, `fields` (todo lo recibido,
  aplanado a `clave.con.puntos → texto`) y `rawJson` (el envío original, máx. 64 KB). Como cada
  source trae datos distintos **no hay esquema fijo**: se aplica el mapeo del source y lo que falte
  se adivina por nombres habituales (email/correo, nombre/first+last name, teléfono/whatsapp,
  empresa…). Nada se descarta.
  - Registrar una novedad pasa el lead a `contacted`, agendar una demo a `demo` y enviar una
    propuesta a `proposal_sent` (solo avanza, nunca retrocede).
  - `won` no se elige a mano: se alcanza al convertir.
- **`sales_demos`**: `leadId`, `title`, `scheduledAt`, `url`, `notes`, `status`
  (`scheduled, done, cancelled, no_show`).
- **`sales_proposals`**: `leadId?`, `projectId?`, `dealId?`, `title`, `url` (la web de la
  propuesta), `amountCents?`, `status` (`draft, sent, accepted, rejected`), `area`
  (`commercial | operations`), `sentAt`, `decidedAt`. Se crean desde el lead (Comercial) o desde el
  proyecto (Operativa); la ligada a un deal queda como `proposalUrl` del deal.
- **`sales_customers`**: nacen al convertir. **Conversión** (`POST /api/sales/leads/:id/convert`):
  exige una propuesta aceptada (o acepta la indicada), crea el cliente y el proyecto operativo en
  Kick Off con esa propuesta, el equipo y sus responsables; el lead queda `won` (de forma atómica:
  no se convierte dos veces).
- **`sales_lead_updates`** y **`sales_meetings`**: novedades y reuniones del lead, con el mismo
  formato y procesamiento que las de Operativa.

**Ingesta** (`POST /api/ingest/leads/:sourceId`, pública): clave en `X-Ingest-Key` o
`Authorization: Bearer` (nunca en la URL, que se loguea). Acepta JSON u
`application/x-www-form-urlencoded`, hasta 256 KB, 120 envíos por minuto por source e IP. Source
inexistente y clave incorrecta dan el mismo 401. Si el mapeo incluye `externalId`, reenviar el
mismo lead no lo duplica.

### 3.2 Operativa (Fase 1, implementada)

- **`ops_projects`**: nombre, `customerName` (luego `customerId`), `teamId`, `leadUserId`,
  `developerUserId` (Team = 1 Team Leader + 1 Developer), `clientSlug?`, `proposalUrl?`,
  `stage`, `health`, `sentimentScore`, `priority`.
  - Etapas: `kickoff → structure → automation_layer → stabilization → maintenance →
    no_pending_items`, y `completed` para los que salen de la empresa.
  - Health: `champion, very_happy, happy, mixed, neutral, concerned, escalated, at_risk`.
  - Prioridad: `critical, high, medium, low`.
  - Sentiment score: entero de 0 a 100 (supuesto; ver §9).
- **`deals`**: `projectId`, `title`, `hours` vendidas, `rateCents` por hora, `amountCents`
  (= horas × tarifa, calculado en servidor), `status` (`draft, proposed, approved, in_progress,
  delivered, invoiced, paid, cancelled`), `proposalUrl?`. Un proyecto tiene varios deals.
- **`ops_tasks`**: `projectId`, `dealId?`, `title`, `assigneeUserId`, `estimatedHours`, `status`
  (`todo, in_progress, review, done`), `dueDate?`, `completedAt?`. La tarea ligada a un deal es la
  base de la comisión.
- **`vault_accounts`**: `projectId`, `label`, `kind`, `url?`, `username?`, `secret` cifrado con
  AES-256-GCM (contexto `vault:<projectId>:<id>`), `rotatedAt`. El valor **nunca** viaja en listados;
  se revela con `POST …/reveal` (auditado, sin caché, fuera de la redacción global vía `sendOnce`).
  Un pool por proyecto evita rotar claves entre personas.
- **`project_updates`**: bitácora de novedades del proyecto (autor, texto, fecha).
- **`meetings`**: `projectId`, `title`, `heldAt`, `source` (`read_ai | manual`), `transcript`,
  `summary`, `feedback[]`, `actionItems[]`, `sentimentSignal`, `status`
  (`pending | processing | processed | failed`).
  - **Procesamiento automático** (proyectos y leads): una reunión con transcripción y sin resumen se
    procesa sola con Claude (`claude-sonnet-5-5`, la misma clave de Anthropic del AI Developer):
    resumen, feedback del cliente, action items y sentimiento sugerido (0–100). La transcripción
    se trata como datos, no como instrucciones, y se corta a 200 000 caracteres (tope de gasto por
    reunión; salida máx. 4096 tokens). Se guardan los tokens usados.
  - El sentimiento sugerido **no** cambia el proyecto solo: el Team Leader lo aplica con un botón,
    y cada action item se puede convertir en tarea.
  - Sin clave de Anthropic las reuniones quedan `pending` y el reproceso responde 503. Si falla,
    queda `failed` con un mensaje genérico y se puede reintentar.

### 3.3 Financiera (Fase 3)

- **`invoices`**: `dealId`, `number`, `amountCents`, `issuedAt`, `dueAt`, `status`
  (`issued, partial, paid, overdue, void`).
- **`payments`**: `invoiceId`, `amountCents`, `paidAt`, `method`.
- **`commission_rules`**: `role` (`lead | developer`), `basis` (`percent_of_task_value |
  fixed_per_hour`), `value`.
- **`commission_entries`**: libro de comisiones. Se genera una entrada por tarea `done` cuando su
  deal queda `paid` (o al completar la tarea si el deal ya estaba pagado). Estados: `accrued →
  approved → paid_out`.
- Reportes: rentabilidad por trimestre (Q1–Q4) y **ventas vs cobros** (deals vendidos contra
  facturas pagadas), por deal, proyecto y equipo.

## 4. Flujos

1. **Comercial**: lead entra por un source → se asigna → contacto → demo → propuesta → aceptada →
   se convierte en cliente y se crea el proyecto operativo.
2. **Operativa**: Project Plan desde la propuesta → deals (por horas) → tareas por deal y
   persona → etapas hasta No Pending Items → Completed al salir de la empresa. Health, sentimiento
   y prioridad se actualizan en cualquier momento y cada cambio queda auditado y en updates.
3. **Financiera**: deal entregado → factura → pago → se liberan comisiones de las tareas
   completadas.

## 5. Integraciones

- **Leads multi-source**: endpoint de ingesta por source con clave propia (se guarda solo el
  hash), validación con Zod permisiva (objeto JSON libre con tope de tamaño), guardado de `raw` y
  aplicación del mapeo. Tolera campos desconocidos.
- **Read.ai** (pendiente): webhook de reunión finalizada → crea la reunión `pending` con el
  transcript y `externalId` (evita duplicados) → el procesamiento ya existente la deja
  `processed`. Falta verificar el formato del webhook y su autenticación con la documentación de
  Read.ai, y decidir cómo se asocia cada reunión a su proyecto o lead.
- **Claude**: se reutiliza la clave de Anthropic ya configurada para el AI Developer; límite de
  gasto por reunión.

## 6. Migración desde Monday (una sola vez)

Script `apps/api/src/scripts/import-monday.ts`: lee los boards con la integración de Monday ya
existente, mapea columnas a los campos de §3, genera un reporte de filas no mapeadas y corre en
modo `--dry-run` primero. Idempotente por `mondayItemId` guardado en cada documento. Se ejecuta
cuando termine la Fase 3; Monday se apaga después de validar el reporte.

## 7. Seguridad

- Todo lo nuevo pasa por `requireAuth` + permiso por rol + alcance por equipo (404 si no
  pertenece, igual que hoy).
- Valores con Zod `strict()`; el servidor calcula montos, no el navegador.
- El vault usa una clave AES propia (`ACCOUNT_VAULT_KEY_PATH`, 32 bytes en base64). Sin la
  clave, las rutas del vault responden 503 y el resto de la plataforma funciona.
- Auditoría de: creación/cambio de etapa, health, deals, reveal y rotación de cuentas.

## 8. Fases

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Roles nuevos, Operativa: proyectos, deals, tareas, vault, updates, reuniones (manual), menú por áreas | **Implementada** |
| 2 | Comercial completo, ingesta de leads, procesamiento de reuniones con Claude, conversión a proyecto, propuestas desde Operativa | **Implementada** (falta el webhook de Read.ai) |
| 3 | Financiera: facturas, pagos, comisiones, reportes Q1–Q4 y ventas vs cobros; importación de Monday | Pendiente |

## 9. Supuestos y preguntas abiertas

1. **Sentiment Score**: se asumió entero 0–100. Si se usa otra escala, cambia solo la validación.
2. **Comisión**: no se definió la fórmula. Se propone regla por rol (porcentaje del valor de la
   tarea o monto fijo por hora). Falta confirmar: ¿quién cobra qué porcentaje, y se paga al cobrar el
   deal completo o por factura parcial?
3. **Un Team = 1 TL + 1 Developer**: el equipo actual admite varios developers. El proyecto guarda
   los dos responsables concretos; no se restringe el tamaño del equipo existente.
4. **Moneda**: se guarda en centavos con `currency` por deal (por defecto USD).
5. **Facturación electrónica (SUNAT)**: fuera de alcance; `invoices` es un registro interno.
