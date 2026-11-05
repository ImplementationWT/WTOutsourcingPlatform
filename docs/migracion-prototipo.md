# Migración del prototipo «Sistema interactivo · Leads y Proyectos»

El prototipo (`Sistema.dc.html`) es una demo con datos en memoria. Se usa como referencia de
interfaz, flujos y reglas; no se importan sus datos de ejemplo (Team M/A/E, Manuel, Ariana, etc.).
Todo lo nuevo lee y guarda contra los usuarios, equipos y roles reales.

## Zonas protegidas

No se tocan: Infraestructura (Apps y Repositorios), el Dashboard existente (con Costos),
Integraciones, Meetings con la automatización de Read.ai (solo cambia su lugar en el menú) y el
badge del usuario. `scripts/check-protected.sh [base]` lo verifica en cada rama: falla si cambia un
archivo protegido, una ruta protegida del router o un ítem protegido del menú.

## Acceso (D1)

No se inventan reglas nuevas. Cada módulo usa el acceso del grupo del menú donde vive y se define en
un solo lugar: `src/lib/access.ts` (menú, buscador, rutas) y su espejo `apps/api/src/auth/modules.ts`.

| Grupo | Roles |
|---|---|
| Dashboards, Operativa (Mi trabajo, Proyectos, Tasks, Backlog) | todos, con el alcance por equipo de `projectScope` |
| Comercial (incluye Comunicaciones) | boss, commercial, finance — Meetings: todos, como antes |
| Financiera (Invoices, Pagos / Comisiones) | boss, finance |
| Infraestructura | boss, lead, developer (sin cambios) |

Tareas, sprints y comunicaciones de un proyecto heredan `projectScope`.

**Pantallas que conviene restringir más adelante:** Pagos / Comisiones (muestra básicos y
comisiones por persona; hoy la ven boss y finance), Invoices, Dashboard Financiero (lo ven todos
por estar en Dashboards) y el selector «Ver como» de Mi trabajo y Tasks.

## Menú (orden final)

1. **Dashboards:** Financiero, Comercial, Operativo (`/tableros/…`). No hay otros dashboards además
   de estos tres y el de Infraestructura, que queda intacto.
2. **Comercial:** Contactos, Leads, Propuestas, Meetings, Comunicaciones. Actividades y Demos
   salen del menú: viven en el detalle del lead y sus rutas siguen activas.
3. **Operativa:** Mi trabajo, Proyectos, Tasks.
4. **Financiera:** Invoices, Pagos / Comisiones.
5. **Infraestructura:** sin cambios.
6. **Backlog / Sprints**, al final de todo.

Deals sale del menú (D2): el deal se gestiona en la pestaña Deals del proyecto. `/deals` y su
detalle siguen accesibles por ruta.

## Decisiones tomadas

- **D3** `seniority` en el usuario (Intern, Junior, Semi Senior, Senior Developer), separado del rol
  de permisos. Team Leader sigue siendo `role=lead`.
- **D4** Solo boss cambia rol, seniority o team desde Pagos. Cambiar el team de un Team Leader
  también actualiza `teams.leadUserId`.
- **D5** Hasta 2 developers por proyecto (`developerUserIds[]`).
- **D6** Propuestas como sitios HTML alojados: fase aparte. Se conservan las propuestas actuales.
- **D7** Se conservan las pestañas Propuestas y Updates del proyecto.
- **D9** Plazos por etapa en Settings, solo boss.
- **D10** Comisiones a mano; no se implementa la regla calculada.

## Pendientes de decisión (no se cambian)

1. La regla «Comercial edita deals solo hasta *propuesto*» (`apps/api/src/core/access.ts`).
2. La pestaña **Deals** del lead.
3. **Conversión lead → proyecto.** Verificado, sin cambios: hoy no hay conversión automática. El
   deal se crea desde el lead («Crear deal» en la vista rápida y el detalle, `useCreateDeal`), con
   su `leadId` y el contacto; luego se enlaza a un proyecto editando el deal (`projectId`). El
   proyecto se crea aparte (boss o el Team Leader). El deal se sigue creando ahí.
4. **Dashboard Comercial:** el KPI «Pipeline abierto» y el gráfico «Pipeline por stage» dependen de
   deals; no se implementan hasta decidir.

## Solo en producción (se conserva)

Pantalla Deals y su detalle (por ruta), Actividades y Demos, las pestañas Demos, Deals y Datos del
source del lead, Propuestas y Updates del proyecto, prioridad `critical`, estado de lead
`unqualified`, etapas de deal `demo`, `confirmed` y `ghosted`, change orders, AI Developer, Usuarios
y Settings.

## Migración de datos

Aditiva e idempotente al arrancar (patrón de `core/migrate.ts`): campos opcionales con valor por
defecto, colecciones nuevas y valores nuevos en los enums; no se renombra ni se borra nada. Antes
de desplegar, `mongodump` completo. Rollback: volver a la imagen anterior (ignora lo nuevo); si se
usaron valores nuevos de enums, correr el script de reversa de cada paso antes de bajar de versión.

## Paso 2 · Proyectos

- **Datos:** `ops_projects` suma `stageSince`, `stageHistory[]` y `developerUserIds[]` (hasta 2). Los
  plazos por etapa viven en `settings` (`_id: "stage-sla"`); sin documento se usan los iniciales
  (Kick Off 7, Structural Build 30, Automation Layer 21, Stabilization 14, Maintenance 60, No
  Pending Items 14, Completed sin límite). Las vistas guardadas, en `ui_views`, por usuario.
- **Migración** (`core/migrate-prototype.ts`): a cada proyecto sin `stageSince` le pone la fecha de
  su última actualización, marcada como *estimada* en el historial, y su developer en la lista.
- **Rollback:** no hay valores nuevos en enums; la versión anterior ignora los campos y colecciones
  nuevos. Para limpiar: `db.ops_projects.updateMany({}, {$unset: {stageSince: "", stageHistory: "",
  developerUserIds: ""}})`, `db.settings.deleteOne({_id: "stage-sla"})` y `db.ui_views.drop()`.
- **Pendiente para pasos siguientes:** la pestaña Comunicaciones (paso 5), las horas pagadas en los
  KPIs (paso 6) y los gráficos de ventas del proyecto (paso 8).

## Paso 3 · Tasks

- **Datos:** en `ops_tasks`, las subtareas son tareas con `parentTaskId` (un solo nivel). Campos nuevos
  opcionales: `sprintId`, `startDate`, `investedHours`, `billableHours`, `details`, `deletedAt` y
  `deletedWith` (borrado con «Deshacer»). `estimatedHours` son las horas proyectadas y `dueDate` el
  fin del timeline. Colecciones nuevas: `ops_sprints` (número fijo por proyecto, no se reutiliza) y
  `ops_task_updates`. Status nuevo: `stuck` (Pending, Working on it, In Review, Stuck, Completed).
- **Reglas:** la tarea padre con subtareas es de solo lectura (owners, status, timeline y horas se
  calculan); sin subtareas dice «Sin tareas». Crear y asignar: CEO/CCO y Team Leader del equipo. El
  developer solo cambia status y horas de lo suyo (como antes). Todo hereda `projectScope`.
- **Tareas anteriores:** quedan como tareas sin subtareas («Sin tareas»). Su status guardado se
  conserva y sigue contando para el avance del proyecto.
- **Rollback:** antes de volver a la versión anterior, `db.ops_tasks.updateMany({status: "stuck"},
  {$set: {status: "in_progress"}})`. Para limpiar del todo: borrar las subtareas
  (`{parentTaskId: {$type: "string"}}`) y las tareas con `deletedAt` de tipo fecha, y quitar
  `ops_sprints` y `ops_task_updates`. Los campos nuevos los ignora la versión anterior.

## Paso 4 · Mi trabajo y Backlog / Sprints

- **Mi trabajo** (`/operativa/mi-trabajo`): tareas y subtareas abiertas de una persona agrupadas en
  Vencidas, Esta semana, Próximas, Sin fecha y Completadas (las 5 últimas). «Ver como» elige a otra
  persona de los equipos visibles. Status y horas invertidas se cambian ahí mismo, con las reglas de
  Tasks (el developer, solo lo suyo).
- **Backlog / Sprints** (`/operativa/backlog`): tareas sin sprint con owner y sprint; capacidad por
  sprint = developers del proyecto × días hábiles × 6 h, con alerta de sobrecarga general y por
  persona; disponibilidad de developers (los que no tienen tareas, primero).
- **Menú:** Backlog / Sprints al final, con el contador de tareas sin sprint
  (`GET /api/tasks/backlog-count`). En el celular, los roles de equipo ven Mi trabajo en la barra.
- **Datos:** no hay cambios de esquema: todo sale de Tasks. **Rollback:** volver a la imagen anterior.

## Paso 5 · Comunicaciones

- **Datos:** colección nueva `core_communications` (tipo, dirección, asunto, resumen, responsable,
  contacto en texto, fecha, proyecto **o** lead, seguimiento opcional, borrado con «Deshacer»).
  Registro manual: no hay integración con Gmail.
- **Acceso** (sin reglas nuevas): las de un lead, como Leads (escriben boss y commercial, finance
  lee); las de un proyecto las ve quien ve el proyecto (`projectScope`) y escriben boss, commercial y
  el equipo. La pantalla vive en Comercial (boss, commercial, finance).
- **Pantalla** `/comercial/comunicaciones`: KPIs, aviso de proyectos sin contacto hace más de 7 días
  y leads activos sin respuesta hace más de 2 (desde su llegada si nunca se les escribió), pestañas
  por tipo y seguimientos, búsqueda. Badge en el menú con los seguimientos vencidos o de hoy.
- **Pestañas** «Comunicaciones» en el proyecto y en el lead (en producción el lead no tenía pestaña
  Emails; se agrega sin quitar ninguna).
- **Rollback:** volver a la imagen anterior; para limpiar, `db.core_communications.drop()`.

## Paso 6 · Invoices

- **Datos:** colección nueva `fin_invoices` (número INV-0001 de la secuencia `invoice`, mes, stage,
  fechas de factura y pago, sustained, proyecto, deal, horas, fee en centavos, borrado con
  «Deshacer»). Rate = el del deal; monto bruto = horas × rate; total = bruto + fee. Team leader y
  tipo de pago se leen del proyecto.
- **Stages:** Overdue, Follow Up, Due, Pending, Invoiced, Upcoming y Paid. Una Pending de un mes
  futuro se muestra como Upcoming. Pasar a un stage facturado pone la fecha de factura; a Paid, la
  de pago.
- **Acceso:** Financiera (boss y finance). El proyecto muestra «Horas pagadas» y «Pagado vs deals»
  solo a esos roles (la API no las envía al resto).
- **No se toca el deal:** cambiar el stage de una invoice no cambia el estado del deal
  (`invoiced`/`paid`). Queda como decisión pendiente si deben sincronizarse.
- **Rollback:** volver a la imagen anterior; para limpiar, `db.fin_invoices.drop()` y
  `db.counters.deleteOne({_id: "invoice"})`.

## Paso 7 · Pagos / Comisiones

- **Datos:** `users.seniority` (opcional: intern, junior, semi_senior, senior), aparte del rol de
  permisos (D3); colección nueva `fin_payouts` (una por persona y mes: básico y comisión en centavos,
  estado Pendiente o Pagado y fecha de pago). Índice único por persona y mes.
- **Personas:** los Team Leaders y developers activos reales. Rol (Team Leader o nivel de developer)
  y team se editan desde Pagos solo por boss (D4) y se guardan en el usuario con la misma lógica de
  Usuarios y equipos. Si un Team Leader cambia de team, el equipo anterior queda sin líder y el
  nuevo lo toma; si ese equipo ya tenía otro Team Leader, se reemplaza y se avisa en pantalla.
- **Comisiones a mano** (D10): no se implementa la regla calculada del doc §5.2.
- **Horas del mes:** referenciales; cada ítem reparte sus horas por igual entre los días de su
  timeline (`ops/hours.ts`).
- **Acceso:** Financiera (boss y finance). Es la pantalla más sensible: muestra básicos y comisiones
  por persona.
- **Índices:** los de vistas, comunicaciones, invoices y pagos se crean en `AdminStore.init` junto
  con los demás (en paralelo), no al registrar cada ruta.
- **Rollback:** volver a la imagen anterior (ignora `seniority`); para limpiar,
  `db.fin_payouts.drop()` y `db.users.updateMany({}, {$unset: {seniority: ""}})`.

## Paso 8 · Dashboards Financiero, Comercial y Operativo

- **Rutas:** `/tableros/financiero`, `/tableros/comercial` y `/tableros/operativo`, en el grupo
  Dashboards arriba del menú (D8). El Dashboard de Infraestructura (`/dashboard`) no cambia.
- **Datos (sin reglas nuevas):** el Financiero lee Invoices (solo boss y finance); el Comercial,
  `GET /api/tableros/comercial` (quienes leen Leads); el Operativo, Tasks y Proyectos con el alcance
  por equipo. Quien entra a un dashboard sin acceso a sus datos ve un aviso y no se piden datos.
- **Comercial sin pipeline:** «Pipeline abierto», «Ganado» y «Pipeline por stage» no se implementan
  hasta decidir cómo se relacionan los deals con Comercial (pendiente 4).
- **Gráficos** (`src/components/charts`): barras verticales (apiladas por serie), barras horizontales,
  donas y la cuadrícula de horas por persona (Días, Semanas o Meses; Invertidas, Facturables o
  Proyectadas). Tooltip CSS al pasar el mouse y «Ver como tabla» en cada tarjeta.
- **Colores:** tokens `--viz-1…5` (azul, amarillo, violeta, verde, rojo) con los tonos de la marca,
  validados en claro y oscuro con el validador de dataviz contra la superficie de las tarjetas. Más
  de 5 series se agrupan en «Otros» (no se ciclan colores). Los estados (tareas, stages, tiempo en
  etapa) usan los tonos de estado.
- **Rollback:** volver a la imagen anterior; no hay datos nuevos.

## Paso 9 · Leads, Actividades, Contactos y Propuestas al estilo del prototipo

- **Leads:** estado nuevo `ghosted` (frío: una demo o una propuesta lo devuelve al embudo, como
  Nurturing). La temperatura guardada como `nurturing` se muestra como **Cold**; el valor no cambia.
- **Actividades:** se suman los tipos comerciales del prototipo (Triage Call, Crear Demo, Reunión
  Demo, Crear Propuesta, Enviar Propuesta, Reunión de Cierre, Enviar Onboarding; Follow Up ya
  existía) sin quitar los anteriores. Estados Open y Closed (Overdue se calcula: Open con la fecha
  pasada). Inicio automático al crearla y **tiempo invertido** hasta el cierre.
- **Contactos:** columna Tipo (calc): Cliente si está en algún proyecto, Lead si solo está en leads.
- **Propuestas (D6):** se conservan las actuales con el estilo del panel; los sitios HTML alojados
  quedan para una fase aparte.
- **Rollback:** antes de bajar de versión, `db.sales_leads.updateMany({status: "ghosted"}, {$set:
  {status: "lost"}})` y `db.sales_activities.updateMany({kind: {$in: ["triage_call",
  "create_demo", "demo_meeting", "create_proposal", "send_proposal", "closing_meeting",
  "send_onboarding"]}}, {$set: {kind: "other"}})`.

## Paso 10 · Estilo del prototipo, Leads, Proyectos y Propuestas

- **Estilo:**
  - paleta de `Sistema.dc.html` como tokens (claro y oscuro) en `src/index.css`;
  - Inter, chips `chip-*`, formularios `proto-form`, KPIs y botón Claro/Oscuro.
  - Tipografía: títulos en Bricolage Grotesque, texto y subtítulos en Geist, código en Geist Mono, en toda la app. Las pantallas protegidas y la insignia del usuario usan la misma fuente (autorizado expresamente el 2026-11-05; solo la fuente, `--font-legacy`), el resto de su estilo no cambia (`skin-legacy`).
- **Leads y Proyectos:** lista agrupada (grupos plegables) y detalle en ventana grande, como en el
  prototipo. `/comercial/leads/:id` y `/operativa/:id` abren la lista con el detalle encima.
- **Propuestas (decisión: conectar con WTProposalPlatform):**
  - Las pantallas son las del prototipo: tarjetas, subir (archivo, ZIP o código), actualizar,
    ver, estadísticas, copiar, personalizar (subdominio, contraseña, inicio), descargar ZIP,
    archivar, papelera y eliminar.
  - Los archivos y el sitio público siguen en WTProposalPlatform (`<nombre>.sites.whatever.tech`);
    esta API la llama en `/api/sites/*` con una llave de servidor. No se toca la infraestructura
    del VPS.
  - Cada sitio queda ligado a su lead o proyecto (`ProposalDoc.siteId`). Las propuestas antiguas,
    que solo tenían enlace, se ligan por su URL.
  - Las cotizaciones con líneas siguen en `/comercial/cotizaciones`.
  - **Para activarlo:**
    1. En WTProposalPlatform, fusionar el PR «Llave de servidor». Crear el secret
       `PLATFORM_API_KEY` (32+ caracteres aleatorios). Volver a ejecutar `deploy/setup-server.sh`
       (cambió `app-deploy`) y luego el Deploy.
    2. En esta API:
       - `PROPOSAL_SITES_URL=https://panel.sites.whatever.tech`;
       - `PROPOSAL_SITES_KEY_PATH=<archivo con la misma llave>` (montado como los demás secretos).
       Sin ellas, Propuestas muestra un aviso y `/api/sites` responde 503.
    3. nginx: el bloque `location /api/sites/` (subidas de hasta 50 MB) está en
       `deploy/nginx/launchpad.whatever.tech.conf`; recargar nginx al desplegar.
  - **Rollback:**
    - quitar las dos variables: la pantalla muestra el aviso, sin tocar datos;
    - las propuestas creadas aquí guardan su URL, así que siguen visibles en el lead como enlaces.

## Lead ganado → proyecto (decidido)

Al pasar un lead a **Ganado** se crea su proyecto automáticamente (`apps/api/src/sales/win-lead.ts`), una sola vez por lead:

- **Datos del lead:**
  - **Nombre:** el del lead, o su empresa si no tiene.
  - **Cliente:** su contacto. Si solo estaba escrito, se crea en Contactos con su correo, teléfono y empresa, y se enlaza al lead.
  - **Account:** la empresa del contacto.
- **Valores iniciales:** Priority **Medium**, Stage **Kick Off** y Sentiment **Happy** (health `happy`).
- **Equipo:** el que tiene menos proyectos activos, con su Team Leader. El CEO/CCO lo cambia en el detalle.
- **Deals y propuestas del lead:** pasan al proyecto.
- **Bitácora:** queda una nota en el lead y otra en el proyecto, más un registro en la auditoría.
