# Seguridad: credenciales de clientes

Cómo maneja la plataforma las credenciales que un operador introduce para un cliente
(hoy, el token de Monday.com del template 1.4.0 y la clave de Anthropic de Will Doo, el
co-pilot del template 1.7.0). Las dos siguen el mismo recorrido.

## Recorrido de una credencial

1. **Navegador.** Vive solo en el estado del formulario: nunca en `localStorage`,
   `sessionStorage`, la URL, la caché de consultas ni los logs del navegador. Los
   campos son `type=password` con *mostrar/ocultar* y `autocomplete="off"`. Se borra
   del formulario al enviarla o al salir.
2. **Petición.** Viaja una vez, por HTTPS, a `POST /api/clients` (alta) o
   `PUT /api/clients/:id/integrations/:provider` (actualización). Al recibirla se
   registra para redacción: si apareciera en un error o log, se sustituye por
   `[REDACTED]`. Los errores 4xx se registran solo con su código (un JSON mal formado
   podría citar el cuerpo) y ninguna respuesta devuelve el cuerpo recibido.
3. **Validación.** "Probar conexión" y el PUT la comprueban contra el host fijo del
   catálogo (`https://api.monday.com/v2`), con timeout de 10 s y sin seguir
   redirecciones. Ningún host o URL procede del navegador. El resultado es `ok` o un
   código genérico (`auth_failed`, `timeout`, `unavailable`), nunca el mensaje del
   proveedor.
4. **Tránsito cifrado.** Mientras se aprovisiona se guarda en `provisioning_secrets`
   cifrada con **AES-256-GCM** y la clave del servidor; el AAD es `clientId:provider`,
   así que un texto cifrado no se puede mover a otro cliente ni a otro proveedor. Nunca
   hay texto plano en la base.
5. **Destino.** La etapa `github_secrets` (o el trabajo de integración) la escribe como
   secret del entorno `production` del repo del cliente (`MONDAY_API_TOKEN` o
   `ANTHROPIC_API_KEY`), cifrada
   con la clave pública del entorno, y **borra el documento transitorio** en ese mismo
   momento.
6. **Servidor.** El workflow del template la envía a `deploy-client`, que solo acepta
   las 8 variables del contrato y la escribe en el `.env` 0600 del cliente.

En el cliente de la base administrativa solo se guarda `{ enabled, requestedAt,
configuredAt, updatedAt }`. El panel muestra estado y fechas: nunca valores, ni
parciales, ni longitudes. La auditoría (`integration_enabled`, `integration_updated`,
`integration_removed`, `integration_validated`, `integration_credential_stored`) solo
lleva el proveedor y los nombres de las variables.

## TTL

Los documentos de `provisioning_secrets` caducan a las **24 h**
(`INTEGRATION_SECRET_TTL_HOURS`, 1–168) mediante un índice TTL de MongoDB; las lecturas
comprueban además `expiresAt`, porque el TTL tarda hasta ~60 s. Si un trabajo queda
detenido más que eso, `github_secrets` falla con `integration_credential_expired` y
pide volver a introducir la credencial desde el detalle del cliente
(Integraciones → Actualizar credencial); después se reintenta el trabajo.

## Clave de cifrado

`INTEGRATION_ENCRYPTION_KEY_SECRET_REF` es la **ruta** a un archivo con 32 bytes en
base64, no el valor. En producción la genera `deploy/activate.sh` una sola vez en
`/opt/wt-launchpad/integration.key` (root, 0400 para el uid del contenedor), nunca
sale del VPS y se monta de solo lectura en `/run/secrets/integration.key`. Sin la clave,
la plataforma rechaza activar integraciones (503) y el resto sigue funcionando.

## Usuarios, roles y equipos

Cada persona entra con **su propio usuario y contraseña** (sin SSO). Las cuentas las crea
un CEO/CCO en **Usuarios y equipos** (menú del usuario, arriba a la derecha → `/users`).
Al crear una cuenta se elige primero el rol y después el equipo; los CEO/CCO no tienen
equipo.

| Rol | Ve | Puede |
| --- | --- | --- |
| **CEO/CCO** (`boss`) | Todos los proyectos, incluidos los que aún no tienen equipo, y todos los costos | Todo: crear proyectos (eligiendo el equipo) y operarlos, AI Developer, servidores. Además administra usuarios y equipos y mueve proyectos entre equipos |
| **Team leader** (`lead`) | Los proyectos de su equipo y los costos del equipo | Crear y operar proyectos, integraciones y secretos, usar el AI Developer, crear PR y fusionar. También da de alta y verifica servidores |
| **Developer** (`developer`) | Los proyectos de su equipo y sus propias sesiones en Costos | Lo mismo que el team leader, salvo los servidores |

- **Un equipo por proyecto.** El proyecto queda en el equipo de quien lo crea. Un proyecto
  de otro equipo responde **404**, no 403, para no confirmar que existe. Esto vale para
  clientes, trabajos, AI Developer, integraciones, panel y listado de proyectos.
- **CEO/CCO.** Opera cualquier proyecto. Al crear uno elige el equipo (obligatorio); el
  resto crea siempre en su equipo, aunque envíe otro.
- **Servidores.** Son infraestructura compartida entre equipos: los ve cualquier sesión y
  solo CEO/CCO y team leaders los añaden, verifican, rotan o quitan.
- **Repos de GitHub sin proyecto de la plataforma** (por ejemplo, creados a mano) no
  tienen equipo: en *Proyectos* solo los ven los CEO/CCO.

**Sesión.** Es una cookie HttpOnly firmada (HMAC, 8 h) con el id de usuario, el usuario,
el rol y el equipo. En cada petición el usuario se relee de la base, así que desactivar
una cuenta o cambiarle el rol o el equipo tiene efecto al momento, sin esperar a que la
cookie caduque.

**Contraseñas.** Se guardan con scrypt y deben tener entre 10 y 128 caracteres, distintas
del usuario. El CEO/CCO nunca elige la contraseña: al crear o restablecer una cuenta, la
plataforma genera una **temporal** que se muestra **una sola vez** en la respuesta y no se
guarda en logs ni en la auditoría. Con una contraseña temporal, la API solo deja usar
`/api/auth/*` (403 `password_change_required`) hasta cambiarla en el primer ingreso. En la
API el indicador se llama `mustChangeCredentials`: la redacción global oculta cualquier
clave que contenga `password`.

**Migración.** En el primer arranque, la cuenta de la configuración
(`PANEL_ADMIN_USERNAME` / `PANEL_ADMIN_PASSWORD_HASH`) se copia como usuario **CEO/CCO**, con
la misma contraseña. Es idempotente: si ya hay usuarios no hace nada. Mientras la
colección `users` esté vacía, la cuenta de la configuración sigue entrando como antes.
Los proyectos existentes quedan **sin equipo**: solo los ven los CEO/CCO hasta que uno los
asigne desde el detalle del proyecto (tarjeta *Equipo*).

**Auditoría.** Cada evento guarda el usuario (`actor`), su nombre real (`actorName`) y su
equipo (`actorTeamId`), también los del AI Developer (`ai.*`). Las altas, cambios de rol o
equipo, desactivaciones, restablecimientos, bloqueos y movimientos de proyecto quedan
registrados (`user.*`, `team.*`, `client.team_changed`).

## Acceso al panel: límite de intentos

El login cuenta los fallos en ventanas de 15 minutos:

- **Por IP:** 10 fallos bloquean esa IP.
- **Por usuario:** 30 fallos, desde cualquier IP, bloquean ese usuario. Frena ataques
  repartidos entre muchas IPs, y una sola IP no basta para dejar fuera a todos.

Durante el bloqueo, la contraseña ni se comprueba: el panel responde 429 con
`Retry-After` aunque sea correcta. Un acierto borra los fallos de esa IP y ese usuario.
Cada bloqueo queda en el log (`Login blocked after repeated failures`).

Además, cada cuenta se **bloquea 15 minutos tras 5 contraseñas incorrectas seguidas**,
aunque después acierte. El bloqueo se guarda en la base (sobrevive a reinicios), queda
auditado (`user.locked`) y se levanta antes si un CEO/CCO restablece la contraseña.

La IP es la que ve el nginx del panel. La API solo confía en el salto local
(`trustProxy` 127.0.0.1), así que lo que el cliente añada a `X-Forwarded-For` no
cuenta. Los contadores viven en memoria y se reinician con la API.

## Claves de los servidores de despliegue

`SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF` apunta a `/opt/wt-launchpad/server-keys.key`, que
genera `deploy/activate.sh` igual que la anterior y se monta en `/run/secrets/server-keys.key`.
Cifra la clave privada del provisioner de cada servidor dado de alta desde el panel (las genera
Launchpad; nunca se muestran ni se registran). Detalles, huella fijada y rotación en
[servers.md](servers.md).

## Vault de cuentas e ingesta de leads

`ACCOUNT_VAULT_KEY_PATH` apunta a `/opt/wt-launchpad/account-vault.key`, que genera
`deploy/activate.sh` una vez y se monta en `/run/secrets/account-vault.key`. Cifra las cuentas de
cada proyecto de Operativa (AES-256-GCM, contexto `vault:<proyecto>:<cuenta>`). Cada vista queda
en la auditoría, nunca el valor. Si la clave se pierde, hay que volver a cargar las cuentas.

Las claves de ingesta de leads (`/api/ingest/leads/:sourceId`) se guardan solo como SHA-256 y se
muestran una vez al crearlas o rotarlas. Van en una cabecera, nunca en la URL, porque la URL se
registra en los logs. Ver [rework-plataforma.md](rework-plataforma.md).

## Rotación

- **Clave de cifrado:** solo afecta a credenciales en tránsito (minutos). En el VPS:
  `rm /opt/wt-launchpad/integration.key` y redesplegar la plataforma; las credenciales
  pendientes cifradas con la clave anterior dejan de poder leerse y el trabajo afectado
  pedirá introducirlas de nuevo.
- **Credencial de un cliente:** desde el detalle del cliente → Integraciones →
  *Actualizar credencial*. Con el cliente listo se escribe el secret y se redespliega;
  ver [runbooks.md](runbooks.md#rotar-la-credencial-de-integración-de-un-cliente).
- **Quitar una integración:** *Desactivar* borra el secret del repo y redespliega para
  que la variable desaparezca del contenedor.
