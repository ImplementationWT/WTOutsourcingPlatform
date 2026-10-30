# Estructura base de la plataforma (Comercial · Operativa · Financiera)

Versión 2 · 30 de octubre de 2026 · Reemplaza a la v1 del 29 de octubre.

Este documento define **la estructura base**: qué tablas existen, cómo se conectan, qué catálogos
fijos usan y quién ve qué. Sobre esta base se construye área por área. Se calcó de los tableros
reales de Monday (workspaces *Sales* y *Operations*) y de lo que se definió en la conversación.

---

## 1. Principios

1. **Una tabla de primer nivel por entidad.** Leads, Deals, Contactos, Proyectos, Tasks, Reuniones y
   Cuentas son tablas propias, con su propia pantalla. Ninguna vive escondida dentro de otra.
2. **Conexiones reales.** Lo que en Monday es una *columna de conexión* aquí es una relación entre
   tablas: cada registro guarda el id del registro relacionado y la pantalla lo muestra como
   enlace navegable en ambos sentidos.
3. **Totales calculados en el servidor.** Lo que en Monday son *espejos* y *fórmulas* (horas
   vendidas, horas facturables, valor del deal, comisión, avance) se calcula en la API. El navegador
   nunca envía un monto calculado.
4. **Catálogos propios.** Etapas, Health, Prioridad y demás estados salen de la sección 3 y no se
   inventan por pantalla.
5. **Lo que no está estandarizado no se pierde.** Los leads guardan el payload original del source
   (`raw`) además de los campos ya mapeados.
6. **Secretos solo cifrados.** Ninguna contraseña ni token en texto plano, ni en base ni en logs.
7. **Todo cambio importante queda auditado**, con quién y cuándo, y deja una novedad en el proyecto
   cuando corresponde.
8. **Listas grandes desde el día uno.** Hoy hay ~375 leads, ~856 deals, ~1.577 tasks y ~747 reuniones.
   Las tablas paginan, ordenan y filtran en el servidor.

Se reutiliza lo que ya existe: usuarios, sesiones, equipos, auditoría, redacción de secretos y
cifrado AES-256-GCM. La infraestructura (apps de clientes) pasa a llamarse **Infraestructura** y se
enlaza desde el Proyecto.

---

## 2. Mapa de tablas y conexiones

```
COMERCIAL                                   OPERATIVA
─────────                                   ─────────
Source ──► Lead ──► Deal ◄───────────────── Proyecto ──► App (Infraestructura)
             │       │  ▲                     │  ▲
             │       │  └─ Cotización         │  ├── Task (épica) ── Subtarea ── Registro de horas
Contacto ◄───┤       │       └ Líneas         │  ├── Reunión ── Action items
Empresa  ◄───┘       │                        │  ├── Cuenta (vault)
Partner ─────────────┘                        │  ├── Sprint
Actividad ──► Lead / Deal                     │  └── Onboarding · Testimonio · Licencia
Demo ──► Lead

FINANCIERA
──────────
Deal ──► Factura ──► Pago          Subtarea + Deal pagado ──► Comisión
```

**Deal es la tabla puente.** Nace en Comercial (lead → propuesta → aceptada) y vive en Operativa
(sus Tasks, sus horas, su cobro). Un proyecto tiene varios deals; un deal pertenece a un proyecto
una vez ganado.

---

## 3. Catálogos fijos

### Etapas del proyecto (en orden)
`kickoff` Kick Off → `structure` Estructura → `automation_layer` Automation Layer →
`stabilization` Estabilización → `maintenance` Maintenance → `no_pending_items` No Pending Items →
`completed` Completed.
*Completed* es también el estado de los proyectos que salen de la empresa.

### Health y Sentiment Score
El **Sentiment Score se deriva del Health**, no se escribe a mano (así funciona hoy en Monday):

| Health | Sentiment |
|---|---|
| Champion | 100 |
| Very Happy | 90 |
| Happy | 80 |
| Mixed | 65 |
| Neutral | 55 |
| Concerned | 40 |
| At Risk | 20 |
| Escalated | 10 |

### Prioridad
`critical` Critical · `high` High · `medium` Medium · `low` Low.

### Estado de un Deal
`draft` Borrador → `proposed` Propuesto → `approved` Aprobado → `in_progress` En curso →
`delivered` Entregado → `invoiced` Facturado → `paid` Cobrado; y `cancelled` Cancelado.

### Estado de una Task
`todo` · `in_progress` · `review` · `done`. (Monday tiene 17 estados; se dejan estos 4 más
`blocked` "Bloqueada por cliente" si hace falta. *Por confirmar al construir Tasks.*)

### Estado de la comisión
`pending` Pendiente → `released` Liberada → `paid` Pagada.

### Estado de un lead (propuesto, se afina al construir Comercial)
`new` → `contacted` → `demo` → `proposal_sent` → `won` | `lost`, más `nurturing` y `unqualified`.
Cada funnel de origen (LHT, Upwork, Guía, Outreach…) puede tener sus sub-etapas propias, pero todas
caen en esta etapa común, como la columna *Etapa* transversal de Monday.

---

## 4. Tablas por área

Convención: `id` (uuid) y `createdAt/updatedAt` en todas; `mondayId` en las que se migran.
Las columnas marcadas **(calc)** las calcula el servidor.

### 4.1 Comercial

**Leads** (Active Leads + Cold Leads: una sola tabla; "Cold" es un estado o vista)

| Campo | Tipo / nota |
|---|---|
| empresa, contacto | texto · enlace a Contacto y Empresa |
| source | relación a *Source* (web, ads, Upwork, referido, evento…) |
| funnel | LHT · Upwork · Guía · Outreach · AITP · otro |
| estado, temperatura | catálogo de leads · Hot / Warm / Nurturing |
| responsable | Setter y Closer (dos personas) |
| fechaSubmission, fechaReunion | fechas (respuesta en días **(calc)**) |
| fields | pares clave/valor ya mapeados (preguntas del formulario, UTM, industria, tamaño…) |
| raw | payload original del source, sin tocar |
| dealId, propuestaUrl | relación a Deal · enlace a la propuesta |

**Sources** — `nombre`, `tipo` (webhook / formulario / manual / import), `claveIngesta` (solo hash),
`mapeo` (campo origen → campo lead). Cada source declara su mapeo; lo que no se mapea queda en `raw`.

**Partners** — `nombre`, `tipo`, `comisión %` por defecto, relación a Deals que originó.

**Contactos** — `nombre`, `correos`, `teléfono`, `cargo`, `LinkedIn`, relación a Empresa, Leads, Deals,
Proyectos y Reuniones (asistentes).

**Empresas** — `nombre`, `dominio`, `industria`, `tamaño`, `país/ubicación`, Contactos y Proyectos.

**Deals** (compartida con Operativa)

| Campo | Tipo / nota |
|---|---|
| dealCode | `DL-0001` autoincremental |
| nombre, descripción | texto |
| proyectoId | relación a Proyecto (opcional hasta que se gana) |
| leadId, partnerId, contactos | relaciones |
| responsable | persona |
| estadoVenta | etapa comercial: nuevo, discovery, demo, propuesta, negociación, confirmado, ganado, perdido, ghosted, en espera |
| estado | catálogo de Deal (sección 3) |
| horas, tarifa | numéricos |
| valor | **(calc)** horas × tarifa |
| probabilidad, valorProyectado | % · **(calc)** valor × probabilidad |
| cierreEstimado, cierreReal | fechas |
| tipoVenta, producto, canal | Nuevo proyecto / Upsell / Change order · producto · canal |
| razónPerdida | si se pierde |
| comisiónPartner % | si hay partner |
| propuestaUrl, sow | enlace · archivo |
| **change orders** | subregistros del deal: horas, tarifa, estado (draft / proposed / approved / rejected / canceled), fecha de aprobación, firma |

**Actividades comerciales** (las "Commercial Tasks") — `título`, `tipo`, `responsable`, `vence`,
`estado`, relación a Lead o Deal.

**Demos** — `lead`, `url` (la web demo), `fecha`, `notas`. **Aprendizajes de demos**: texto ligado a
la demo.

**Cotizaciones / Propuestas** — `título`, `url`, `estado` (borrador / enviada / aceptada / rechazada),
`monto`, `fechaEnvío`, relación a Lead o Deal. Con **líneas** (producto, horas, tarifa, subtotal
**(calc)**), un catálogo de **Productos** y de **Casos de uso**. Se crean desde Comercial o Operativa.

**Updates del proyecto comercial** — bitácora de novedades por lead/deal (autor, texto, fecha).

**Reuniones comerciales** — mismo mecanismo que las operativas (ver 4.2), ligadas a Lead o Deal.

### 4.2 Operativa

**Proyectos** (Projects Overview)

| Campo | Tipo / nota |
|---|---|
| nombre, cliente | texto · enlace a Empresa |
| equipo | Team Leader + 1 Developer (`leadUserId`, `developerUserId`), dentro de un `teamId` |
| etapa, health, prioridad | catálogos (sección 3) |
| sentiment | **(calc)** del Health |
| kickoff, propuestaUrl, projectPlan, sow | fecha · enlace · archivos |
| contactos, deals, appSlug | relaciones; `appSlug` enlaza la app de Infraestructura |
| horasVendidas | **(calc)** suma de horas de sus deals aprobados |
| horasFacturables | **(calc)** suma de horas facturables de sus subtareas |
| facturableVsDeals | **(calc)** horasFacturables − horasVendidas |
| avance | **(calc)** tareas hechas / tareas totales |
| tipoPago | Upwork · Stripe · Directo Perú · Directo USA · PayPal · Revolut |
| siguienteAcción | catálogo corto (contactar, follow-up, preparar propuesta, revisión interna…) |

**Tasks** (Tasks Master): tarea **épica** ligada a un Deal y a un Proyecto

| Campo | Tipo / nota |
|---|---|
| título, historiaDeUsuario, detalle | texto |
| proyectoId, dealId, sprintId | relaciones |
| estado | catálogo de Task |
| horasVendidas | **(calc)** del Deal |
| horasProyectadas, horasInvertidas, horasFacturables | **(calc)** suma de las subtareas |
| avance % | **(calc)** facturables / vendidas |

**Subtareas** (por persona, con la comisión): `título`, `responsable`, `estado`, `lineaBase`
(inicio–fin), `horasProyectadas`, `horasInvertidas`, `horasFacturables`, `comisiónPorHora`,
`horasProrrateadas` **(calc)** (facturables ÷ número de responsables), `comisiónTotal` **(calc)**,
`estadoComisión`, `fechaLiberación`, `fechaPago`.

**Registro de horas** (Tasks Log) — `subtarea`, `fecha`, `horas`, `nota`; alimenta las horas
invertidas.

**Reuniones** (Meetings, con procesamiento automático)

| Campo | Tipo / nota |
|---|---|
| título, tipo, fecha, duración, url | Discovery · Kickoff · Sprint Review · Alineación · Resolución de issues · Change discussion · Ad-hoc · Training |
| proyectoId, dealId, asistentes | relaciones (asistentes = Contactos) |
| origen, externalId | `read_ai` / `manual` · id en Read.ai (evita duplicados) |
| transcript | texto o archivo |
| estadoProceso | Nueva sin procesar → Revisada → Accionada → No necesaria |
| resumen, feedback[], sentimientoCliente | salida del procesamiento (Excelente / Bien / Neutral / Fricción) |
| **action items** | subregistros: tarea, tipo (admin rápido, trabajo interno, dependencia del cliente, candidato a construir, riesgo de alcance), responsable, horas proyectadas, fase, estado |

Flujo: llega el webhook de Read.ai → reunión *Nueva sin procesar* → se procesa con Claude (resumen,
feedback, action items, sentimiento) → una persona revisa → los action items pasan a Tasks o a un
Change Order. Claude **propone**, nunca crea tareas ni cambia el Health solo.

**Cuentas** (Customer Accounts, vault) — `proyecto`, `plataforma`, `etiqueta`, `usuario`, `url`,
`notas`, `estadoCredenciales` (Pendiente / OK / Login fallido), `rotadaEn`. El valor se guarda
**cifrado**; revelarlo queda auditado (quién y cuándo) y la respuesta no se cachea.

**Updates** — bitácora del proyecto: manuales y automáticas (cambio de etapa, health, prioridad…).

**Sprints** — `nombre`, `fechas`, `proyecto`, Tasks del sprint.

**Otras (se construyen al final de Operativa):** Siguientes acciones, Checklist de onboarding,
Testimonios (solicitud y autorización), Licencias, Apps (clientes).

### 4.3 Financiera

**Facturas** — `número`, `dealId`, `monto`, `moneda`, `emisión`, `vence`, `estado`
(emitida / parcial / pagada / vencida / anulada).
**Pagos** — `facturaId`, `monto`, `fecha`, `medio`.
**Comisiones** — vista del libro de comisiones por persona, mes y proyecto, con el estado
Pendiente / Liberada / Pagada.

**Reportes:** rentabilidad de la empresa por trimestre (Q1–Q4), **ventas vs cobros** (deals
vendidos contra facturas pagadas), cobros pendientes por deal/proyecto/equipo, y costo de
AI Developer (ya existe) dentro de la rentabilidad por proyecto.

---

## 5. Reglas de negocio

1. **Valor del deal** = horas × tarifa. Una vez `invoiced` o `paid`, horas y tarifa quedan bloqueadas;
   los cambios van como *change order*.
2. **Comisión** (sale de Monday):
   - nace en cada **subtarea**: horas facturables × comisión por hora de la persona;
   - si la subtarea tiene varios responsables, se **prorratean** las horas;
   - estado **Pendiente** mientras no haya factura pagada del deal **o** el trabajo no esté terminado;
   - pasa a **Liberada** cuando se cumplen ambas cosas (queda la fecha de liberación);
   - se marca **Pagada** al liquidarse, normalmente el último día hábil del mes de cierre.
   - La comisión del partner es aparte: `comisión % × valor del deal`, con saldo = comisión − pagado.
3. **Lead → cliente.** Cuando una propuesta se acepta: el lead pasa a `won`, el deal a `approved`, y se
   crea el Proyecto en *Kick Off* con la propuesta enlazada. Se pregunta antes de crear.
4. **Project Plan.** Se genera a partir de la propuesta y se guarda como archivo del proyecto.
5. **Health y Sentiment.** Cambiar el Health recalcula el Sentiment y deja una novedad automática.
6. **Cuentas.** Un pool de cuentas por proyecto; nadie comparte claves por chat. Rotar actualiza la
   fecha. Sin clave de cifrado en el servidor, el vault responde 503 y el resto sigue funcionando.
7. **Equipo.** Un proyecto = 1 Team Leader + 1 Developer. Ambos tienen Tasks.

---

## 6. Permisos por rol

| | CEO/CCO | Comercial | Financiera | Team Leader | Developer |
|---|---|---|---|---|---|
| Leads, Contactos, Partners, Demos, Cotizaciones | todo | todo | solo lectura | — | — |
| Deals | todo | crea y edita hasta *propuesto* | lectura y cobro | su equipo, edita | su equipo, lectura |
| Proyectos | todo | lectura | lectura | su equipo, edita | su equipo, lectura |
| Tasks y subtareas | todo | lectura | lectura | su equipo, crea y asigna | sus tareas: solo cambia estado y horas |
| Reuniones | todo | las comerciales | lectura | su equipo | su equipo |
| Cuentas (vault) | todo | **sin acceso** | **sin acceso** | su equipo (crea, rota) | su equipo (solo ver) |
| Facturas, Pagos | todo | lectura | todo | lectura de sus deals | — |
| Comisiones | todas | — | todas | las suyas | las suyas |
| Usuarios y equipos | todo | — | — | — | — |

Los proyectos de un equipo no los ve otro equipo (404, sin confirmar que existen).

---

## 7. Interfaz base

Todas las tablas usan el mismo componente `DataTable`:

- columnas con **encabezado**, orden por columna, estados de carga y vacío;
- **edición en la celda** (estado, responsable, prioridad, horas) sin abrir el detalle; clic en la fila abre el detalle;
- **celda de relación** (enlace navegable a Deal, Proyecto, Contacto…) y **celda de total** (horas, monto);
- **totales al pie** (horas y monto en Deals, horas estimadas e invertidas en Tasks, montos en Propuestas);
- **filtros y búsqueda en la URL**, para compartir una vista con un link;
- **agrupación por estado** con contador (leads por etapa, proyectos por etapa);
- en el celular, cada fila es una **tarjeta**;
- paginación y filtro **en el servidor**.

Menú: **Comercial · Operativa · Financiera · Infraestructura**, cada área con sus tablas.

---

## 8. Migración desde Monday (una sola vez)

| Tablero de Monday | Tabla nueva |
|---|---|
| Active Leads, Cold Leads | Leads |
| Partners Funnel | Partners |
| Contacts, Companies | Contactos, Empresas |
| Deals y Subitems of Deals | Deals y change orders |
| Activities | Actividades comerciales |
| Demos, Aprendizajes de demos | Demos |
| Cotis, Cotis Line Items, Products DB, Use Cases | Cotizaciones, líneas, productos, casos de uso |
| Projects (Overview) | Proyectos |
| Tasks Master y sus subitems | Tasks y subtareas |
| Tasks Log | Registro de horas |
| Meetings y sus subitems | Reuniones y action items |
| Customer Accounts | Cuentas (vault) |
| Sprints, Siguientes Acciones, Onboarding Checklist, Testimonials, Licensing Tracker, Apps (Clientes) | tablas de la sección 4.2 |
| Quotes & Invoices | Facturas |

- Cada registro guarda su `mondayId`, así el script es **idempotente** (se puede repetir sin duplicar).
- Primero corre en modo `--dry-run` y entrega un reporte de lo que no se pudo mapear.
- Las columnas de conexión de Monday se convierten en relaciones; los espejos y fórmulas se descartan
  porque se recalculan.
- **Aviso de seguridad:** Customer Accounts guarda contraseñas en texto plano. La migración las
  cifra directo hacia el vault y no las escribe en logs; conviene **rotarlas** después.
- Las etapas y estados de Monday que no existan en la sección 3 (Debriefing, App Buildout,
  Structural Build, Offboarding, Churn, etc.) se asignan con una tabla de equivalencias que se
  revisa antes de importar.

---

## 9. Qué cambia respecto a la Fase 1 ya entregada

**Se conserva:** roles `commercial` y `finance`, aislamiento por equipo, el vault cifrado, la
auditoría, la novedad automática por cambio de etapa y el menú por áreas.

**Se rehace:**
- Deals, Tasks, Reuniones y Cuentas pasan de pestañas del proyecto a **tablas de primer nivel**
  (el proyecto las muestra como vistas filtradas).
- Sentiment deja de ser un número libre y pasa a derivarse del Health.
- Tasks pasa a **épica + subtareas** con comisión por persona.
- Se agregan Contactos y Empresas, que no existían.

---

## 10. Orden de construcción

| Paso | Contenido |
|---|---|
| 0 | `DataTable` base, celdas de relación y de total, filtros en la URL |
| 1 | **Núcleo compartido:** Contactos, Empresas, Deals, Proyectos |
| 2 | **Operativa:** Tasks y subtareas, Registro de horas, Reuniones, Cuentas, Updates |
| 3 | **Comercial:** Sources e ingesta de leads, Leads, Partners, Actividades, Demos, Cotizaciones |
| 4 | **Procesamiento de reuniones** con Read.ai y Claude |
| 5 | **Financiera:** Facturas, Pagos, Comisiones, reportes Q1–Q4 y ventas vs cobros |
| 6 | Importación desde Monday y apagado de los tableros |

---

## 11. Pendientes por confirmar

1. **Estados de lead y de Sales Stage**: los de la sección 3 son una propuesta basada en Monday.
2. **Comisión por hora**: ¿es un valor fijo por persona o lo define el Deal/Task? En Monday es un
   número por subtarea.
3. **Tipo de cambio y moneda**: hoy todo está en USD; ¿se necesita PEN?
4. **Read.ai**: formato del webhook y método de autenticación (se confirma con su documentación al
   construir el paso 4).
5. **Facturación electrónica (SUNAT)**: fuera de alcance; las facturas son un registro interno.
