# Contrato del template

Este documento es para quien construye o mantiene el **aprovisionador**: lo que
el template espera recibir, lo que expone y lo que deliberadamente no hace.

## 1. Identidad y versión

| Campo | Valor |
| --- | --- |
| Template | `node-typescript@1.3.0` |
| Dónde se define | `package.json` → `template.name` y `template.version` |

```json
"template": { "name": "node-typescript", "version": "1.3.0" }
```

`template.version` sigue SemVer y es independiente de `version` de
`package.json`. El aprovisionador lo escribe como `templateVersion` en el
documento de bootstrap (§8). Los repos ya generados quedan fijados a la versión
con la que se crearon: este cambio no les afecta.

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
    "APP_DISPLAY_NAME": "…"
  },
  "registryToken": "<GITHUB_TOKEN del job>"
}
```

- `env` contiene **solo las variables definidas**: `INITIAL_ADMIN_PASSWORD` y
  `APP_DISPLAY_NAME` no aparecen si no existen. El JSON se construye con `jq`
  leyendo el entorno (los secretos no pasan por argumentos) y cada valor se
  enmascara con `::add-mask::` antes de usarse; nunca se imprime.
- `registryToken` caduca cuando termina el job: el servidor debe hacer
  `docker login ghcr.io` (usuario cualquiera, p. ej. `deploy`) y el `pull`
  **durante** la sesión SSH, y no debe guardarlo.

**Qué debe hacer el comando del servidor:**

1. Leer stdin completo y parsearlo como JSON; rechazar claves desconocidas en
   `env` (aceptar solo las de esta tabla y las opcionales de §2).
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
| `POST /api/auth/login` | — | `{ username, password }` → `{ user, permissions }` + cookie. Rate limit: 10 por IP cada 5 min |
| `POST /api/auth/logout` | — | Cierra la sesión actual |
| `GET /api/auth/me` | sesión | `{ user, permissions }` |
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

## 9. Responsabilidades

### Lo hace el aprovisionador

- Crear la base `client_<slug>` y el usuario `app_<slug>` con rol
  `readWrite` solo sobre esa base.
- Crear el documento de bootstrap (no crear las colecciones de §8: las crea la app):

  ```js
  db.app_metadata.insertOne({
    key: "bootstrap",
    clientId: "<slug>",            // string no vacío
    templateVersion: "1.3.0"       // template.version de package.json
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
- Disparar el primer `Deploy`.

### Lo hace el template

- Migraciones, catálogo de permisos, roles de sistema y usuario `admin`.
- Login, sesiones, autorización, dashboard de actividad y registro de auditoría.
- Las APIs de notificaciones y auditoría existen aunque la interfaz no las muestre.

### NO lo hace el template

- No incluye datos, nombres, lógica ni permisos de ningún cliente o negocio.
- No contiene secretos, URIs ni dominios.
- El frontend nunca se conecta a MongoDB ni recibe variables del servidor:
  solo consume la API del mismo origen.

## 10. Ejecución local

```bash
docker run -d --name mongo-local -p 27017:27017 mongo:8
cp .env.example .env
# MONGODB_URI=mongodb://localhost:27017
# MONGODB_DB=client_local
# SESSION_SECRET=<32+ caracteres aleatorios>

pnpm install
pnpm dev        # API en http://localhost:3000
pnpm dev:web    # SPA en http://localhost:5173 (proxy de /api al backend)
```

Entrar con `admin` / `admin123` (solo desarrollo) y cambiar la contraseña.
Comprobaciones sin credenciales: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
