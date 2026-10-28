# Contrato del template

Este documento es para quien construye o mantiene el **aprovisionador**: lo que
el template espera recibir, lo que expone y lo que deliberadamente no hace.

## 1. Identidad y versión

| Campo | Valor |
| --- | --- |
| Template | `node-typescript@1.7.0` |
| Dónde se define | `package.json` → `template.name` y `template.version` |

```json
"template": { "name": "node-typescript", "version": "1.7.0" }
```

`template.version` sigue SemVer y es independiente de `version` de
`package.json`. El aprovisionador lo escribe como `templateVersion` en el
documento de bootstrap (§8). Los repos ya generados quedan fijados a la versión
con la que se crearon: este cambio no les afecta.

### Cambios en 1.7.0 (respecto a 1.6.0): Will Doo, el co-pilot

**Will Doo** conversa con cada usuario de la app usando Claude (API de
Anthropic). Responde con datos vivos y entiende la pantalla abierta, siempre
dentro de los permisos de quien pregunta. Es **opcional**: sin clave, la app
funciona igual y Will no aparece. Esta versión solo consulta datos: no crea,
cambia ni borra nada.

- **Variables.**
  - Secreto opcional `ANTHROPIC_API_KEY` (§2, §3), uno por proyecto. El
    servidor debe aceptarlo en `env` (§5). Si el secreto no está definido,
    `deploy.sh` no lo envía, así que un VPS sin actualizar sigue desplegando.
  - Ajustes con valor por defecto: `WILL_DOO_MODEL` (`claude-sonnet-5-5`),
    `WILL_DOO_MONTHLY_BUDGET_USD`, `WILL_DOO_USER_DAILY_MESSAGES` y
    `WILL_DOO_RETENTION_DAYS`.
- **Datos y migración.** Permisos `willdoo.use` y `willdoo.audit`. La
  **migración 4** (esquema 4) los añade al catálogo y al rol `admin`, y crea
  las colecciones `willdoo_conversations` y `willdoo_usage` con TTL (§8).
- **Endpoints y features.**
  - `/api/willdoo/*` (§7).
  - `features` incluye `"willdoo"` con la clave configurada y el permiso
    `willdoo.use`.
  - El proveedor `anthropic` aparece en `/api/integrations`, con su prueba de
    conexión.
- **Permisos en la capa de datos.** Claude solo recibe las herramientas que el
  usuario tiene permiso de usar. Cada herramienta consulta con la identidad y
  el alcance de quien pregunta. La auditoría registra quién preguntó qué, qué
  herramientas se usaron y el costo.
- **Interfaz.** Botón y panel de chat 2D (pantalla completa en celular), con
  sugerencias según los permisos, historial y enlaces solo a rutas de la app o
  a monday.com.
- **Cómo lo adapta cada proyecto.**
  - La guía del sistema vive en `src/modules/willdoo/context.ts`.
  - Las herramientas de lectura propias van en `src/modules/willdoo/tools.ts`,
    cada una con su permiso.

### Cambios en 1.6.0 (respecto a 1.5.0): vista previa en vivo

La app no cambia (esquema 3, mismas variables). La vista previa del AI Developer
deja de construirse en GitHub Actions: la plataforma clona la rama en el servidor
y la arranca en modo desarrollo, con recarga en caliente (§5.3).

- Script nuevo `pnpm dev:preview` (`scripts/dev-preview.mjs`): backend con
  `tsx watch` y frontend con Vite, que con `LAUNCHPAD_PREVIEW=1` escucha en todas
  las interfaces del contenedor, acepta el host de la vista previa y sirve el HMR
  por `wss` en el 443 de nginx.
- `preview.yml` y `DEPLOY_TARGET=preview` (§5.2) se conservan para repos que aún no
  tienen `dev:preview`, pero la plataforma ya no los usa.
- Un repo 1.5.0 obtiene la vista en vivo copiando `scripts/dev-preview.mjs`, el
  script `dev:preview` de `package.json` y el bloque `livePreview` de
  `web/vite.config.ts`.

### Cambios en 1.5.0 (respecto a 1.4.0): vista previa del AI Developer

La app no cambia (esquema 3, mismas variables). Cambia lo que el repo trae para
que la plataforma enseñe una rama antes de fusionarla:

- Workflow nuevo `.github/workflows/preview.yml` (§4): lo lanza la plataforma
  con `workflow_dispatch` sobre una rama de trabajo; construye esa rama y la
  arranca como vista previa con su propia base temporal. Nunca despliega a
  producción ni lee los secrets de la app.
- `.github/scripts/deploy.sh` acepta `DEPLOY_TARGET=preview` y envía el
  documento de §5.2 (sin `env`).
- El comando del servidor debe aceptar `"target": "preview"` (§5.2).
- La plataforma detecta la vista previa por la existencia de `preview.yml`:
  un repo 1.4.0 la obtiene copiando ese workflow y el `deploy.sh` de 1.5.0.
- Ejecución local en un comando: `docker compose up --build` (§10).

### Cambios en 1.4.0 (respecto a 1.3.0): integraciones externas

- Capa genérica de integraciones (`src/integrations`) con un registro de
  proveedores. Primer proveedor: **Monday.com**, **opcional**: sin credencial
  la app funciona igual.
- Variable/secreto opcional `MONDAY_API_TOKEN` (§2, §3). El servidor debe
  aceptarla en `env` (§5).
- Permisos `integrations.read`, `integrations.manage` y `monday.read`;
  **migración 3** (esquema 3) que los añade al catálogo y al rol `admin`.
- Endpoints `GET /api/integrations`, `POST /api/integrations/:provider/test`,
  `GET /api/monday/boards`; `/api/auth/me` y el login devuelven `features`.
- Interfaz: pantalla **Integraciones** (Configuración) y tab **Monday**
  (grupo Integraciones) visible solo si `features` incluye `monday`.
- Ninguna credencial ni dato de Monday se guarda en la base de la app.

### Cambios en 1.3.0 (respecto a 1.2.0): protocolo de despliegue

Cambia lo que el aprovisionador y el servidor deben hacer; la app no cambia.

- Despliegue en un VPS compartido detrás de **nginx**, en
  `<slug>.apps.<dominio>` (§5–§6).
- Secretos y variables renombrados (§3): `DEPLOY_SSH_KEY` (secret);
  `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_HOSTNAME` y `APP_DISPLAY_NAME`
  (variables). Desaparecen `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`,
  `DEPLOY_SSH_PRIVATE_KEY`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_SSH_PORT` y
  `APP_BASE_URL`. El usuario SSH es siempre `deploy`.
- El payload pasa de líneas `CLAVE=valor` a un **JSON** con `image`, `env` y
  `registryToken`; el workflow no envía comando remoto y el servidor responde
  con `DEPLOY_OK` o `DEPLOY_FAILED <motivo>` (§5).
- `deploy.yml` se divide en los jobs `build` y `deploy` (§4).
- `compose.yaml` es solo para desarrollo local; el de producción lo genera la
  plataforma (§6).

### Cambios en 1.2.0 (respecto a 1.1.0)

- Interfaz: el menú queda en **Dashboards** (General) y **Usuarios** y
  **Roles** (Configuración). Se retiran de la interfaz las pantallas de
  Notificaciones, Auditoría y Permisos y la campana del header; `/permisos`
  redirige a `/usuarios`.
- **Permisos por usuario**: además de los de sus roles, a un usuario se le
  pueden añadir o quitar permisos (`grantedPermissionKeys`,
  `revokedPermissionKeys`). Permisos efectivos = (roles ∪ añadidos) − quitados.
  Los administradores conservan siempre todos. Nuevos endpoints
  `GET/PUT /api/users/:id/permissions` y acción de auditoría
  `user.permissions.update`.
- Nuevo permiso `dashboard.read` (migración 2; se añade al rol `admin`, no al
  rol `user`) y nuevo endpoint `GET /api/dashboard`.
- Las APIs de notificaciones y auditoría **siguen existiendo** sin cambios: la
  auditoría se sigue registrando y alimenta el dashboard.

### Cambios en 1.1.0 (respecto a 1.0.0)

- Incluye frontend (SPA en `web/`) servido por el mismo backend, login,
  usuarios, roles, permisos, notificaciones y auditoría.
- **La app ahora crea colecciones e índices** (migraciones al arrancar). El
  usuario de base necesita `readWrite` sobre su base (incluye `createIndex`).
- Nueva variable obligatoria `SESSION_SECRET` (y secreto homónimo en GitHub).
- `GET /api/meta` cambia de forma: siempre devuelve un objeto con `appName` y
  `schemaVersion` (de las migraciones); `clientId`/`templateVersion` son
  `null` si no hay bootstrap. El campo `schemaVersion` del documento de
  bootstrap ya no se usa.
- `/health/ready` responde 503 hasta que las migraciones terminan.

## 2. Variables de entorno de la app

Se validan con Zod al arrancar (`src/config/env.ts`). Si falta una obligatoria
o alguna es inválida, el proceso termina con código 1 y un mensaje que solo
nombra la variable y la regla, nunca su valor. Una variable vacía (`VAR=`)
cuenta como no definida.

| Variable | Obligatoria | Formato / valores | Por defecto |
| --- | --- | --- | --- |
| `MONGODB_URI` | **Sí** | `mongodb://…` o `mongodb+srv://…`. Usuario `app_<slug>` con `readWrite` solo sobre su base. | — |
| `MONGODB_DB` | **Sí** | `^client_[a-z0-9_]+$` | — |
| `SESSION_SECRET` | **Sí** | ≥ 32 caracteres aleatorios, **uno por cliente**. Clave HMAC de los identificadores de sesión. | — |
| `INITIAL_ADMIN_PASSWORD` | No (recomendada) | 10–128 caracteres. Solo se usa si el usuario `admin` no existe. | `admin123` |
| `FORCE_ADMIN_PASSWORD_CHANGE` | No | `true` · `false` (`false` prohibido con `NODE_ENV=production`) | `true` |
| `APP_DISPLAY_NAME` | No | Una línea, ≤ 80 caracteres. Se muestra en la UI vía `/api/meta`. | `Aplicación` |
| `MONDAY_API_TOKEN` | No | Token de la API de Monday.com (sin espacios). Activa la integración. Nunca se registra ni se devuelve | — |
| `MONDAY_MAX_BOARDS` | No | Máximo de tableros que se listan (1–5000; se piden de 100 en 100) | `500` |
| `ANTHROPIC_API_KEY` | No | Clave de la API de Anthropic **de este proyecto** (sin espacios). Activa Will Doo. Nunca se registra ni se devuelve | — |
| `WILL_DOO_MODEL` | No | Id del modelo de Claude (`claude-…`) | `claude-sonnet-5-5` |
| `WILL_DOO_MONTHLY_BUDGET_USD` | No | Tope de gasto mensual de toda la app, a precio de lista (1–100000). Al alcanzarlo, Will responde `429 willdoo_budget_exhausted` hasta el mes siguiente (UTC) | `50` |
| `WILL_DOO_USER_DAILY_MESSAGES` | No | Preguntas por usuario y día UTC (1–10000) | `100` |
| `WILL_DOO_RETENTION_DAYS` | No | Días que se guarda una conversación después del último mensaje (1–3650). El consumo se guarda el mismo tiempo | `90` |
| `SESSION_TTL_HOURS` | No | Expiración absoluta de la sesión (1–720) | `12` |
| `SESSION_IDLE_MINUTES` | No | Expiración por inactividad (1–1440) | `30` |
| `LOGIN_MAX_ATTEMPTS` | No | Intentos fallidos antes del bloqueo temporal | `5` |
| `LOGIN_LOCK_MINUTES` | No | Duración del bloqueo | `15` |
| `TRUST_PROXY_HOPS` | No | Proxies de confianza delante de la app (nginx del VPS = 1; 0 = ninguno). Con 1, la IP del cliente es la que nginx añade al final de `X-Forwarded-For` y el protocolo sale de `X-Forwarded-Proto` | `1` |
| `MONGODB_STARTUP_RETRIES` | No | Intentos de conexión al arrancar (backoff 1 s, 2 s, 4 s… máx. 30 s) | `8` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | No | Entero 1–120000 | `5000` |
| `MONGODB_CONNECT_TIMEOUT_MS` | No | Entero 1–120000 | `10000` |
| `MONGODB_MAX_POOL_SIZE` | No | Entero 1–100 | `10` |
| `PORT` · `HOST` · `NODE_ENV` · `LOG_LEVEL` | No | Servidor HTTP y logs | `3000` · `0.0.0.0` · `development` · `info` |

Ninguna de estas variables llega al frontend: el bundle no usa variables
`VITE_` y CI comprueba que no contiene `MONGODB_*`, `SESSION_SECRET` ni URIs.

Cambiar `SESSION_SECRET` invalida todas las sesiones abiertas (los usuarios
deben volver a entrar); no afecta a las contraseñas.

## 3. Configuración de GitHub que debe escribir el aprovisionador

Todo va en el **entorno `production`** del repo generado (Settings →
Environments). Nombres exactos, sensibles a mayúsculas:

### Secrets del entorno `production`

| Secret | Obligatorio | Contenido |
| --- | --- | --- |
| `DEPLOY_SSH_KEY` | Sí | Clave privada SSH **de este cliente** (una por repo), cuya pública está en el `authorized_keys` del usuario `deploy` del VPS con *forced command* (§5) |
| `MONGODB_URI` | Sí | Cadena de conexión del usuario `app_<slug>` |
| `MONGODB_DB` | Sí | `client_<slug>` |
| `SESSION_SECRET` | Sí | ≥ 32 caracteres aleatorios, generado por cliente (p. ej. 32 bytes en base64url) |
| `INITIAL_ADMIN_PASSWORD` | No, **muy recomendado** | Contraseña inicial del `admin` (≥ 10 caracteres). Entregarla al cliente por un canal seguro |
| `MONDAY_API_TOKEN` | No | Token de la API de Monday.com del cliente. Hereda los permisos de su dueño: la app solo ve los tableros que esa persona ve. Mejor un usuario de servicio con acceso de solo lectura a los tableros que deban mostrarse |
| `ANTHROPIC_API_KEY` | No | Clave de la API de Anthropic del proyecto (una por proyecto, para separar el gasto). Activa Will Doo (desde 1.7.0) |

### Variables del entorno `production`

| Variable | Obligatoria | Contenido |
| --- | --- | --- |
| `DEPLOY_HOST` | Sí | Nombre del VPS (solo el host, p. ej. `vps1.example.com`; sin usuario ni puerto) |
| `DEPLOY_KNOWN_HOSTS` | Sí | Línea(s) `known_hosts` del VPS (p. ej. salida de `ssh-keyscan -t ed25519 <host>` verificada). La clave del host se comprueba siempre |
| `APP_HOSTNAME` | Sí | Subdominio público, solo el host: `<slug>.apps.<dominio>` (sin `https://` ni ruta) |
| `APP_DISPLAY_NAME` | No | Nombre visible de la app (una línea, ≤ 80 caracteres) |

El workflow usa además el `GITHUB_TOKEN` automático del job (no hay que crearlo).

> **Seguridad del primer acceso.** Sin `INITIAL_ADMIN_PASSWORD`, el `admin`
> se crea con `admin123`. Aunque el cambio es obligatorio en el primer
> ingreso, quien llegue primero al subdominio podría fijar la contraseña. En
> producción el aprovisionador debe definir siempre `INITIAL_ADMIN_PASSWORD`;
> la app registra un aviso (`warn`) al arrancar si no está definida.

## 4. Workflows

| Archivo | Nombre | Disparadores | Necesita secretos |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | `CI` | `pull_request`, `push` a `main` | No |
| `.github/workflows/deploy.yml` | `Deploy` | `workflow_dispatch`, `push` a `main` | Sí (entorno `production`) |
| `.github/workflows/preview.yml` | `Preview` | `workflow_dispatch` en una rama distinta de `main` | Solo `DEPLOY_SSH_KEY` y las variables del servidor |

`CI` ejecuta lint, typecheck, tests (backend con `mongodb-memory-server`,
frontend con Testing Library y la simulación del deploy) y build de ambos, y
verifica que el bundle del frontend no contiene configuración del servidor.

`Deploy` tiene dos jobs; el workflow parte de `permissions: {}` y cada job
pide solo lo suyo:

| Job | Permisos | Entorno | Qué hace |
| --- | --- | --- | --- |
| `build` | `contents: read`, `packages: write` | — | Construye la imagen, la publica en `ghcr.io/<owner>/<repo>` y expone el **digest** (`sha256:…`) como output. La etiqueta `sha-<commit>` es solo informativa |
| `deploy` | `contents: read`, `packages: read` | `production` | Comprueba la configuración, envía el despliegue por SSH (§5) y hace el health check. `concurrency: deploy-<owner>/<repo>` sin cancelar el que está en curso |

`packages: read` en `deploy` es lo que permite que el `GITHUB_TOKEN` enviado
como `registryToken` pueda descargar la imagen.

| Situación | Resultado |
| --- | --- |
| Commit inicial del repo generado | Ningún job se ejecuta |
| Rama distinta de `main` | No se ejecuta |
| `push` a `main` sin todos los obligatorios de §3 | `build` publica la imagen; `deploy` termina en verde con aviso *Deployment skipped* (nombres que faltan, nunca valores) |
| `workflow_dispatch` sin los obligatorios | `deploy` falla indicando qué nombres faltan |
| `SESSION_SECRET` < 32 caracteres o `APP_HOSTNAME` con esquema/ruta | Falla |
| El servidor responde `DEPLOY_FAILED <motivo>` o no responde con el protocolo | Falla con el motivo |
| Todo correcto | `DEPLOY_OK` y luego `https://$APP_HOSTNAME/health/ready` debe dar `200` en ~3 minutos (36 intentos cada 5 s); si no, falla |

Primer despliegue (sin inputs):

```bash
gh workflow run deploy.yml --repo <owner>/<repo> --ref main
```

La lógica del envío está en `.github/scripts/deploy.sh` (el job la ejecuta) y
se prueba sin credenciales en `tests/deploy-workflow.test.ts`.

`Preview` (desde 1.5.0) también tiene dos jobs y parte de `permissions: {}`:

| Job | Permisos | Entorno | Qué hace |
| --- | --- | --- | --- |
| `build` | `contents: read`, `packages: write` | — | Construye la rama y publica `ghcr.io/<owner>/<repo>:preview-<commit>`; expone el **digest**. Nunca en `main` |
| `preview` | `contents: read`, `packages: read` | `production` | Saca `.github/scripts` de la **rama por defecto** (el código en revisión no puede cambiar lo que se ejecuta con la clave) y envía el documento de §5.2 con `DEPLOY_TARGET=preview` |

El entorno `production` no debe restringir ramas de despliegue: el job
`preview` corre en la rama de trabajo. Solo lee `DEPLOY_SSH_KEY`,
`DEPLOY_HOST` y `DEPLOY_KNOWN_HOSTS`. `concurrency: preview-<owner>/<repo>`
cancela la vista previa anterior que siga en curso.

```bash
gh workflow run preview.yml --repo <owner>/<repo> --ref claude-develop
```

## 5. Protocolo con el servidor

**Conexión.** `ssh -T -i <clave> deploy@$DEPLOY_HOST` (puerto 22) con
`StrictHostKeyChecking=yes`, `UserKnownHostsFile` = `DEPLOY_KNOWN_HOSTS`,
`BatchMode=yes` e `IdentitiesOnly=yes`. La clave y el `known_hosts` se
escriben en un directorio temporal con permisos `600` que se borra al
terminar. **No se envía comando remoto.**

La clave de cada cliente va en `~deploy/.ssh/authorized_keys` con un comando
forzado que ignora lo que pida el cliente:

```text
command="/usr/local/bin/<despliegue> <slug>",restrict ssh-ed25519 AAAA… <owner>/<repo>
```

El runner no obtiene shell, root ni socket de Docker: solo puede hablar con
ese comando, y el comando sabe por su argumento a qué cliente corresponde.

**Entrada.** Un único documento JSON por **stdin** (nunca en argumentos):

```json
{
  "image": "ghcr.io/<owner>/<repo>@sha256:<64 hex>",
  "env": {
    "MONGODB_URI": "…",
    "MONGODB_DB": "client_<slug>",
    "SESSION_SECRET": "…",
    "INITIAL_ADMIN_PASSWORD": "…",
    "APP_DISPLAY_NAME": "…",
    "MONDAY_API_TOKEN": "…",
    "ANTHROPIC_API_KEY": "…"
  },
  "registryToken": "<GITHUB_TOKEN del job>"
}
```

- `env` contiene **solo las variables definidas**: `INITIAL_ADMIN_PASSWORD`,
  `APP_DISPLAY_NAME`, `MONDAY_API_TOKEN` y `ANTHROPIC_API_KEY` no aparecen si no existen. El JSON se construye con `jq`
  leyendo el entorno (los secretos no pasan por argumentos) y cada valor se
  enmascara con `::add-mask::` antes de usarse; nunca se imprime.
- `registryToken` caduca cuando termina el job: el servidor debe hacer
  `docker login ghcr.io` (usuario cualquiera, p. ej. `deploy`) y el `pull`
  **durante** la sesión SSH, y no debe guardarlo.

**Qué debe hacer el comando del servidor:**

1. Leer stdin completo y parsearlo como JSON; rechazar claves desconocidas en
   `env`. Lista de claves aceptadas: `MONGODB_URI`, `MONGODB_DB`,
   `SESSION_SECRET`, `INITIAL_ADMIN_PASSWORD`, `APP_DISPLAY_NAME` y
   **`MONDAY_API_TOKEN`** (desde 1.4.0) y **`ANTHROPIC_API_KEY`** (desde 1.7.0).
2. Validar `image` contra `^ghcr\.io/<owner>/<repo>@sha256:[a-f0-9]{64}$`
   (el repo de **ese** cliente) y `env.MONGODB_DB` contra `^client_[a-z0-9_]+$`.
3. Escribir `env` en un archivo de entorno con permisos `0600` (más
   `NODE_ENV=production` y `TRUST_PROXY_HOPS=1`) y no imprimir nunca valores.
4. `docker login ghcr.io` con `registryToken` por stdin
   (`--password-stdin`), `docker pull <image>` y `docker logout ghcr.io`.
5. Arrancar el servicio con el compose que genera la plataforma (§6):
   publica `127.0.0.1:<puerto del cliente>:3000`, nunca en `0.0.0.0`.
6. Esperar a que el contenedor esté sano (`docker compose up -d --wait` o el
   healthcheck de `/health`).
7. Terminar con **una línea final** en stdout:
   - `DEPLOY_OK` si todo fue bien;
   - `DEPLOY_FAILED <motivo>` si no (motivo breve y sin secretos, p. ej.
     `invalid image`, `pull failed`, `unhealthy`).
   Puede imprimir líneas de progreso antes; el workflow las muestra en el log.

El workflow falla si la última línea no es `DEPLOY_OK`, aunque `ssh` termine
con código 0. Después comprueba `https://$APP_HOSTNAME/health/ready` desde el
runner, a través de nginx.

### 5.2 Vista previa (desde 1.5.0)

Misma conexión, misma clave y mismo comando forzado. Documento:

```json
{ "target": "preview", "image": "ghcr.io/<owner>/<repo>@sha256:<64 hex>", "registryToken": "<GITHUB_TOKEN del job>" }
```

Sin `target` el documento es el de producción. Con `"target": "preview"` el
comando del servidor:

1. Rechaza el documento si trae `env` (`DEPLOY_FAILED preview takes no env`)
   o un `target` distinto (`invalid target`). La imagen se valida igual que en
   producción (repo de **ese** cliente, por digest).
2. Exige que la plataforma haya preparado antes la vista previa (puerto,
   certificado y `server` de nginx de `preview-<slug>.<dominio>`); si no,
   `DEPLOY_FAILED preview not installed`.
3. Genera él mismo el entorno: una MongoDB temporal propia (replica set de un
   nodo, borrada en cada arranque), `MONGODB_DB=client_<slug>_preview` y un
   `SESSION_SECRET` aleatorio. Nunca usa la base ni los secrets de producción.
   Sin `INITIAL_ADMIN_PASSWORD`: se entra con `admin` / `admin123` y la app
   obliga a cambiarla.
4. Descarga la imagen con `registryToken` como en producción y arranca la app
   en un puerto de loopback distinto del de producción, esperando a que esté
   sana. Responde `DEPLOY_OK` o `DEPLOY_FAILED <motivo>`.

La vista previa es privada: nginx solo la sirve a quien trae un pase firmado
por el panel de la plataforma (validado en cada petición), solo el panel puede
mostrarla embebida (`frame-ancestors`) y responde con `X-Robots-Tag: noindex`.
`/health` queda libre para comprobar que el contenedor vive.

### 5.3 Vista previa en vivo (desde 1.6.0)

Sustituye a §5.2. La plataforma, por el comando forzado del orquestador:

1. Prepara `preview-<slug>.<dominio>` (puerto, certificado y nginx con acceso solo
   desde el panel; el nginx deja pasar el WebSocket del HMR).
2. Clona la rama de trabajo en el servidor con un token de **solo lectura** de ese
   repo, que caduca en una hora y no se guarda en el clon.
3. Arranca un contenedor `node` sin privilegios con el clon montado:
   `pnpm install --frozen-lockfile` y `pnpm dev:preview`. Su entorno es el de §5.2
   (MongoDB temporal propia, `SESSION_SECRET` aleatorio y ningún valor de
   producción), más `NODE_ENV=development` y `FORCE_ADMIN_PASSWORD_CHANGE=false`.
4. Con cada commit nuevo en la rama, trae el commit al clon (`git fetch` y
   `reset`). Vite y `tsx watch` lo aplican en segundos; si cambió `pnpm-lock.yaml`,
   reinstala primero.

El repo solo tiene que traer `pnpm dev:preview`. Si no lo trae, la plataforma lo
indica (plantilla anterior a 1.6.0). Privacidad, `frame-ancestors` y `/health`,
como en §5.2.

## 6. Contenedor, nginx y compose

| Campo | Valor |
| --- | --- |
| Servicio (compose) | `app` |
| Puerto interno | `3000`: API y frontend en el mismo puerto y origen |
| Publicación en producción | Solo `127.0.0.1:<puerto del cliente>:3000`; nginx lo expone en `<slug>.apps.<dominio>` con TLS |
| Usuario | `node` (no root) |
| Healthcheck | `GET /health` (liveness, no toca la base) |
| Readiness | `GET /health/ready` (503 hasta terminar migraciones) |
| Límites | CPU y memoria configurables (en local, `APP_CPUS` = `0.5` y `APP_MEMORY` = `512m`) |
| Endurecimiento | `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges` |
| Arranque | Escucha → espera a MongoDB con backoff → migraciones → listo. Si MongoDB no responde tras los reintentos o falla una migración, sale con código 1 (el contenedor se reinicia) |
| Parada | `SIGTERM` → cierre ordenado de HTTP y del pool de MongoDB (máx. 10 s) |

**nginx (obligatorio).** La app confía en un salto de proxy
(`TRUST_PROXY_HOPS=1`) para la IP del cliente, el protocolo y el host. El
`server` de cada cliente debe incluir:

```nginx
location / {
    proxy_pass http://127.0.0.1:<puerto del cliente>;
    proxy_set_header Host $host;                                   # obligatorio
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- Sin `proxy_set_header Host $host`, nginx envía `127.0.0.1:<puerto>` como
  `Host` y la protección CSRF **rechaza todos los POST/PATCH/PUT/DELETE**
  (incluido el login) porque el `Origin` del navegador no coincide.
- Sin `X-Forwarded-Proto`, la app cree que la petición es HTTP y también
  rechaza las escrituras. La cookie de sesión es siempre `Secure` y
  `__Host-sid` con `NODE_ENV=production`: el sitio debe servirse por HTTPS.
- nginx no debe ser alcanzable saltándose el proxy: el contenedor solo
  escucha en `127.0.0.1`.

**`compose.yaml` del repo es solo para desarrollo local** (publica en
`127.0.0.1:3000`, `TRUST_PROXY_HOPS=0`). El despliegue no lo usa: la
plataforma genera su propio compose en el servidor con la imagen por digest,
el archivo de entorno del paso 3 de §5 y la publicación en `127.0.0.1`.

## 7. API

Todas las rutas `/api` requieren sesión salvo `POST /api/auth/login`,
`POST /api/auth/logout` y `GET /api/meta`. Mientras `mustChangePassword` es
`true` solo se permiten `/api/auth/me`, `/api/auth/change-password` y
`/api/auth/logout` (el resto responde `403 password_change_required`).

**Requisitos para clientes de la API** (CSRF): en `POST`/`PATCH`/`DELETE`,
`Content-Type: application/json` (si no, `415`) y cabecera `Origin` (o
`Referer`) del mismo origen (si no, `403 invalid_origin`). La cookie de sesión
es `httpOnly`, `SameSite=Strict`, y en producción `Secure` con nombre `__Host-sid`.

| Método y ruta | Permiso | Descripción |
| --- | --- | --- |
| `GET /health` | — | Liveness: `200 {"status":"ok"}` |
| `GET /health/ready` | — | `200 {"status":"ok"}` · `503 {"status":"unavailable"}` |
| `GET /api/meta` | — | `{ appName, clientId, templateVersion, schemaVersion }` |
| `POST /api/auth/login` | — | `{ username, password }` → `{ user, permissions, features }` + cookie. Rate limit: 10 por IP cada 5 min |
| `POST /api/auth/logout` | — | Cierra la sesión actual |
| `GET /api/auth/me` | sesión | `{ user, permissions, features }`. `features: string[]` contiene `"monday"` solo si `MONDAY_API_TOKEN` está configurado **y** el usuario tiene `monday.read`, y `"willdoo"` solo si `ANTHROPIC_API_KEY` está configurada **y** el usuario tiene `willdoo.use` |
| `POST /api/auth/change-password` | sesión | `{ currentPassword, newPassword }`. Cierra las demás sesiones |
| `GET /api/users` | `users.read` | Paginado; `q`, `sort` (`username`, `displayName`, `email`, `status`, `createdAt`, `lastLoginAt`), `status` |
| `POST /api/users` | `users.create` | `{ username, displayName, password, email?, roleIds?, status? }` → `201` |
| `GET /api/users/:id` | `users.read` | |
| `PATCH /api/users/:id` | `users.update` | `{ displayName?, email?, status?, roleIds? }` |
| `POST /api/users/:id/reset-password` | `users.update` | `{ password }` temporal; obliga a cambiarla y cierra sus sesiones |
| `DELETE /api/users/:id` | `users.delete` | |
| `GET /api/users/:id/permissions` | `users.read` | `{ user, isAdmin, isSelf, editable, permissions: [{ key, module, description, fromRoles[], granted, revoked, effective, grantable }] }` (catálogo completo) |
| `PUT /api/users/:id/permissions` | `users.update` | `{ permissionKeys[] }` = conjunto efectivo deseado; el servidor guarda la diferencia con los roles. 409 si es uno mismo (`cannot_edit_own_permissions`) o un administrador (`admin_has_all_permissions`); 403 si concede algo que el actor no tiene |
| `GET /api/roles` | `roles.read` | Paginado; `q`, `sort` (`key`, `name`, `createdAt`); incluye `userCount` |
| `POST /api/roles` | `roles.create` | `{ key, name, description?, permissionKeys? }` |
| `GET /api/roles/:id` | `roles.read` | |
| `PATCH /api/roles/:id` | `roles.update` | `{ name?, description?, permissionKeys? }` |
| `DELETE /api/roles/:id` | `roles.delete` | Solo si no está asignado |
| `GET /api/permissions` | `permissions.read` | Catálogo (solo lectura) |
| `GET /api/notifications` | `notifications.read` | Propias, paginado, `unread=true`; incluye `unreadCount` |
| `POST /api/notifications/:id/read` | `notifications.read` | |
| `POST /api/notifications/read-all` | `notifications.read` | |
| `POST /api/notifications` | `notifications.manage` | `{ userIds[], title, body?, type? }` |
| `GET /api/audit` | `audit.read` | Paginado; `action`, `entityType`, `actorId`, `from`, `to`, `sort` (`createdAt`, `action`) |
| `GET /api/integrations` | `integrations.read` | `{ items: [{ id, label, configured }] }`, sin valores de credenciales |
| `POST /api/integrations/:provider/test` | `integrations.manage` | Prueba de conexión (Monday: consulta `me`). `:provider` debe existir en el registro (si no, 404); 409 `not_configured` si falta la credencial. → `200 { ok: true }` o `200 { ok: false, error }`. Rate limit 10/min por IP. Auditada (`integration.test`) sin valores |
| `GET /api/monday/boards` | `monday.read` | `{ items: [{ id, name, workspaceName, url }], total }`. 404 si Monday no está configurado. Errores: `502 auth_failed`, `504 timeout`, `503 rate_limited`, `503 unavailable` (nunca el mensaje del proveedor). Rate limit 30/min por IP. Auditada (`integration.monday.boards`) solo con el número de tableros |
| `POST /api/willdoo/messages` | `willdoo.use` | `{ text (1–4000), conversationId?, screen?: { path, title?, recordId? }, timeZone? }`. Responde `application/x-ndjson`: un JSON por línea, `start` → `tool`* / `text`* → `done` o `error`. Antes de llamar a Claude: `429 willdoo_budget_exhausted` (presupuesto del mes agotado), `429 willdoo_daily_limit` (límite del usuario) y `404` si la conversación no es suya. Rate limit 20/min por IP. 404 si Will Doo no está configurado. Auditada (`willdoo.ask`): pregunta (≤ 500 caracteres), pantalla, herramientas con su entrada, consumo y costo. Nunca guarda en la auditoría la respuesta ni los datos consultados |
| `GET /api/willdoo/conversations` | `willdoo.use` | Las 30 más recientes del usuario; `?userId=` exige `willdoo.audit` |
| `GET /api/willdoo/conversations/:id` | `willdoo.use` | `{ id, title, createdAt, updatedAt, turns: [{ role, text, tools, at }] }`. Solo las propias, salvo con `willdoo.audit` (si no, 404) |
| `DELETE /api/willdoo/conversations/:id` | `willdoo.use` | Solo las propias. Auditada (`willdoo.conversation.delete`) |
| `GET /api/willdoo/usage` | `willdoo.audit` | Gasto del mes (UTC, precio de lista) frente al presupuesto, por persona |
| `GET /api/dashboard` | `dashboard.read` | `?days=7\|14\|30` (14 por defecto) y `?tz=<zona IANA>` (UTC por defecto) → `{ range, kpis: { activeUsers, disabledUsers, roles, logins, failedLogins, uniqueUsers }, series: [{ date, logins, failures }] }`. Solo conteos agregados; días sin actividad en 0 |

**Paginación**: `?page=&pageSize=&q=&sort=` (`pageSize` ≤ 100; `sort=-campo`
para descendente) → `{ items, total, page, pageSize }`.

**Errores**: `{ "error": "<código>", "message"?: "<texto en español>", "issues"?: [{ path, message }] }`.
Códigos: `validation_error`, `invalid_credentials`, `unauthorized`,
`forbidden`, `password_change_required`, `invalid_origin`, `not_found`,
`too_many_requests`, `weak_password`, `last_admin`, `system_role`,
`role_in_use`, `username_taken`, `email_taken`, `service_unavailable`,
`internal_error`, entre otros. Nunca hay stack traces, mensajes del driver,
`passwordHash` ni identificadores de sesión en las respuestas.

**Reglas de negocio genéricas**:
- No se puede eliminar, desactivar ni quitar el rol `admin` al último
  administrador activo, ni quitarse a uno mismo el rol `admin`, desactivarse o
  eliminarse.
- Nadie puede asignar roles, crear/editar roles, conceder permisos ni
  gestionar usuarios con permisos (efectivos) que él mismo no tiene (evita
  escaladas de privilegio). Nadie cambia sus propios permisos.
- Política de contraseña: 10–128 caracteres, distinta de `admin123` y del usuario.
- Bloqueo temporal de la cuenta tras `LOGIN_MAX_ATTEMPTS` fallos; rate limit
  por IP en login. Mismo mensaje para usuario inexistente, contraseña
  incorrecta, cuenta bloqueada o desactivada.

## 8. Datos y migraciones

Las migraciones (`src/db/migrations`) se ejecutan al arrancar, son
idempotentes y registran la versión en
`app_metadata { key: "schema", version, appliedAt }`. No usan `collMod` ni
validadores (el usuario solo tiene `readWrite`); la validación es con Zod en la app.

| Colección | Contenido | Índices |
| --- | --- | --- |
| `users` | `username`, `email?`, `displayName`, `passwordHash` (scrypt), `roleIds[]`, `grantedPermissionKeys[]?`, `revokedPermissionKeys[]?`, `status`, `mustChangePassword`, `lastLoginAt`, `failedLoginCount`, `lockedUntil`, `createdAt`, `updatedAt` | `username` único; `email` único (parcial); `roleIds+status` |
| `roles` | `key`, `name`, `description`, `permissionKeys[]`, `isSystem`, fechas | `key` único |
| `permissions` | `key`, `module`, `description` | `key` único |
| `notifications` | `userId`, `type`, `title`, `body`, `readAt`, `createdAt` | `userId+readAt+createdAt` |
| `audit_logs` | `actorId`, `action`, `entityType`, `entityId`, `metadata` (sin secretos), `ip`, `createdAt` | `createdAt`; `actorId+createdAt` |
| `sessions` | `sessionIdHash` (HMAC), `userId`, `createdAt`, `lastSeenAt`, `expiresAt`, `absoluteExpiresAt` | `sessionIdHash` único; `userId`; TTL en `expiresAt` |
| `willdoo_conversations` | `userId`, `title`, `messages` (transcripción para Claude, solo se añade), `turns` (lo que ve el panel), `costMicros`, fechas, `expiresAt` | `userId+updatedAt`; TTL en `expiresAt` |
| `willdoo_usage` | `userId`, `conversationId`, `model`, `usage` (tokens), `costMicros`, `toolCalls`, `createdAt`, `expiresAt` | `createdAt`; `userId+createdAt`; TTL en `expiresAt` |
| `app_metadata` | `bootstrap` (aprovisionador) y `schema` (app) | — |

Datos sembrados por la migración 1: catálogo de 12 permisos
(`users.*`, `roles.*`, `permissions.read`, `notifications.read/manage`,
`audit.read`); rol `admin` (sistema, todos los permisos, no editable ni
eliminable); rol `user` (`notifications.read`, editable); usuario `admin`
con rol `admin` y `mustChangePassword` según `FORCE_ADMIN_PASSWORD_CHANGE`.
Nunca se recrea ni se sobrescribe un `admin` existente.

Migración 2: añade `dashboard.read` al catálogo (13 permisos) y al rol
`admin`. No toca el rol `user` ni otros roles. Las migraciones aplicadas no se
editan: el catálogo de la migración 1 está congelado en su archivo.

Migración 3 (esquema **3**): añade `integrations.read`,
`integrations.manage` y `monday.read` al catálogo (16 permisos) y al rol
`admin` con `$addToSet` (sin duplicar ni tocar roles editados). `app_metadata`
queda en `{ key: "schema", version: 3 }` y `/api/meta` devuelve
`schemaVersion: 3`.

Migración 4 (esquema **4**): añade `willdoo.use` y `willdoo.audit` al
catálogo (18 permisos) y al rol `admin` con `$addToSet`, y crea los índices de
`willdoo_conversations` y `willdoo_usage`. Las dos colecciones caducan por su
propio `expiresAt` (TTL 0), así que la retención cambia sin rehacer índices.

## 9. Responsabilidades

### Lo hace el aprovisionador

- Crear la base `client_<slug>` y el usuario `app_<slug>` con rol
  `readWrite` solo sobre esa base.
- Crear el documento de bootstrap (no crear las colecciones de §8: las crea la app):

  ```js
  db.app_metadata.insertOne({
    key: "bootstrap",
    clientId: "<slug>",            // string no vacío
    templateVersion: "1.7.0"       // template.version de package.json
  })
  ```

- Generar un `SESSION_SECRET` por cliente y, en producción, un
  `INITIAL_ADMIN_PASSWORD`; escribirlos con el resto de secrets (§3).
- Generar una clave SSH por cliente (privada en `DEPLOY_SSH_KEY`, pública en
  `~deploy/.ssh/authorized_keys` del VPS con el comando forzado de §5) y
  escribir `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` y `APP_HOSTNAME`.
- En el VPS: el comando de despliegue (§5), el compose de producción que
  publica en `127.0.0.1`, el `server` de nginx con TLS para
  `<slug>.apps.<dominio>` y las cabeceras de §6, y el DNS del subdominio.
- Opcional: si el cliente usa Monday.com, guardar su token como secret
  `MONDAY_API_TOKEN` del entorno `production` y aceptar esa clave en el
  comando del servidor (§5). Para quitar la integración, borrar el secret y
  redesplegar.
- Opcional: para Will Doo, guardar la clave de Anthropic del proyecto como
  secret `ANTHROPIC_API_KEY` del entorno `production` y aceptar esa clave en el
  comando del servidor (§5). Para apagarlo, borrar el secret y redesplegar.
- Disparar el primer `Deploy`.
- Vista previa (opcional): preparar `preview-<slug>.<dominio>` en el VPS (puerto,
  certificado y nginx con acceso solo desde el panel), arrancar la rama en modo
  desarrollo y actualizarla con cada commit (§5.3, desde 1.6.0; antes, `Preview`
  y §5.2), y apagarla cuando ya no se use.

### Lo hace el template

- Migraciones, catálogo de permisos, roles de sistema y usuario `admin`.
- Login, sesiones, autorización, dashboard de actividad y registro de auditoría.
- Las APIs de notificaciones y auditoría existen aunque la interfaz no las muestre.
- Integraciones (hoy Monday.com): estado, prueba de conexión y lista de
  tableros con enlace. Peticiones solo a `https://api.monday.com/v2`, sin
  seguir redirecciones, con timeout de 10 s y caché en memoria de 60 s. Nada se
  conecta al arrancar: un token inválido no impide arrancar. Los enlaces se
  validan (https y host `*.monday.com`) en el servidor y en el navegador.
- Will Doo: el bucle con Claude (SDK oficial, streaming, caché del prompt y
  fallback del servidor ante rechazos), las herramientas de lectura con el
  permiso y el alcance del usuario, la memoria con retención, el tope de
  gasto, los límites y la auditoría. Las peticiones van solo a
  `https://api.anthropic.com`. Lo que devuelven las herramientas y el contexto
  de pantalla se tratan como datos, nunca como instrucciones.

### NO lo hace el template

- No incluye datos, nombres, lógica ni permisos de ningún cliente o negocio.
- No contiene secretos, URIs ni dominios.
- El frontend nunca se conecta a MongoDB ni recibe variables del servidor:
  solo consume la API del mismo origen.
- Integraciones: no hay lógica de negocio sobre los datos del proveedor, no se
  guardan credenciales ni datos de Monday en la base de la app, y ningún
  endpoint recibe o devuelve credenciales (solo se configuran por entorno).

## 10. Ejecución local

Solo con Docker (MongoDB incluida, sin `.env`):

```bash
docker compose up --build      # http://localhost:3000
```

Para desarrollar (Node 24 y pnpm), con recarga en caliente:

```bash
pnpm dev:local                 # crea .env si falta, arranca MongoDB y lanza API + SPA (http://localhost:5173)
```

La MongoDB local es un replica set de un nodo (como Atlas) en `127.0.0.1:27027`.
Entrar con `admin` / `admin123` (solo desarrollo) y cambiar la contraseña.
Comprobaciones sin credenciales: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
