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
2. **Comercial:** Contactos, Leads, Propuestas, Meetings, Comunicaciones, Actividades, Demos.
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
