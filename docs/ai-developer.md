# AI Developer

Claude modifica la app de un cliente a partir de instrucciones en lenguaje
natural, muestra los cambios en una vista previa y solo se despliegan cuando
una persona los aprueba.

Se abre desde el detalle de un proyecto listo: **AI Developer**
(`/projects/<slug>/ai`).

## Cómo funciona

1. **Sesión.** Al empezar, la plataforma crea la rama `ai/<fecha>-<id>` desde
   `main` y una sesión de [Claude Managed Agents](https://platform.claude.com)
   con el repo montado en esa rama. Una sesión activa por proyecto.
2. **Chat.** Las instrucciones llegan al agente; el panel muestra en vivo sus
   mensajes, cada archivo que lee o edita y cada comando que ejecuta. Si el
   agente intenta algo dudoso, se pausa y pide **Permitir / Denegar**.
3. **Código.** Claude edita, ejecuta `pnpm lint`, `typecheck`, `test` y `build`,
   hace commit y push **solo a su rama**.
4. **Vista previa.** *Ver vista previa* lanza el workflow `preview.yml` del repo
   sobre la rama y la arranca en `https://preview-<slug>.apps.whatever.tech`,
   embebida junto al chat, con una **base de datos vacía y temporal**
   (`admin` / `admin123`). Se apaga sola tras una hora sin visitas.
5. **Publicar.** *Crear Pull Request* → GitHub ejecuta el CI del repo →
   *Aprobar y desplegar* (solo con todas las validaciones en verde) fusiona en
   `main` y el workflow `Deploy` del repo despliega a producción.

## Aislamiento y seguridad

- **El código lo ejecuta Anthropic, no el VPS.** Cada sesión corre en un
  contenedor aislado de Anthropic con red limitada a los registros de paquetes
  (npm) y a la descarga de MongoDB de los tests.
- **Token del repo mínimo.** Para cada sesión la plataforma emite un token de
  la GitHub App limitado **a ese repositorio** y a *Contents* (sin permiso de
  workflows: el agente no puede tocar `.github/workflows/`). Caduca en una hora
  y se renueva antes de cada mensaje. Anthropic lo inyecta en su proxy de git:
  nunca entra en el contenedor.
- **Nunca toca producción directamente.** El agente no tiene acceso a la base
  ni a los secrets de producción. Si aun así hiciera push a `main`, el panel lo
  avisa en *Publicar*. Para impedirlo del todo, añade en GitHub una regla
  (*Settings → Rules*) que exija Pull Request en `main`; la plataforma fusiona
  por PR, así que sigue funcionando.
- **Vista previa privada.** nginx solo la sirve con un pase firmado por
  Launchpad (de un solo uso, 2 minutos) que se canjea por una cookie de 8 h de
  ese host; cada petición se valida contra la API del panel. Solo el panel
  puede embeberla y no se indexa. Usa su propia MongoDB en el VPS, borrada en
  cada arranque.
- **El job que entra al servidor usa los scripts de `main`.** En `preview.yml`
  la rama del agente solo se ejecuta dentro del `docker build`, sin acceso al
  entorno `production`.
- **Auditoría.** Inicio de sesión, mensajes (solo longitud), permisos
  concedidos o denegados, PR, merge y vistas previas quedan en la auditoría.

## Costes

Cada sesión tiene un **tope de gasto** (`AI_SESSION_BUDGET_USD`, 10 USD por
defecto, a precio de lista de Anthropic). Al alcanzarlo el agente se pausa y el
chat ofrece *Ampliar presupuesto* (suma otro tramo igual). El gasto se ve en la
cabecera del chat y el detalle completo en *Rastro* (consola de Anthropic).

Modelo: Claude Opus 5.5 con esfuerzo alto (`apps/api/src/ai/agent-definition.ts`).

## Configuración

### 1. Clave de la API de Anthropic (cuenta de la empresa)

En la consola de Anthropic de la cuenta empresarial: *Settings → API keys* →
crea una clave para Launchpad. En GitHub, repo de la plataforma → *Settings →
Environments → production*:

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Secret | `ANTHROPIC_API_KEY` | La clave (`sk-ant-…`) |
| Variable (opcional) | `ANTHROPIC_WORKSPACE` | ID del workspace de la clave, si no es el *Default* (para los enlaces de *Rastro*) |
| Variable (opcional) | `AI_SESSION_BUDGET_USD` | Tope por sesión en USD (por defecto 10) |

Relanza el despliegue de la plataforma. No hay que crear nada más en Anthropic:
el agente y su entorno se crean solos la primera vez que se abre una sesión
(sus IDs quedan en la colección `settings`) y se actualizan si cambia su
definición.

### 2. Permisos de la GitHub App

Además de los del aprovisionamiento, el AI Developer necesita:

| Permiso | Nivel | Para qué |
| --- | --- | --- |
| Contents | **Read and write** | Crear la rama, que Claude haga push y fusionar el PR |
| Pull requests | **Read and write** | Crear y consultar el Pull Request |
| Checks | **Read-only** | Ver las validaciones del CI antes de fusionar |

GitHub → *Settings → Developer settings → GitHub Apps* → la App → *Permissions
& events* → cambia esos tres y guarda. Después acepta la solicitud de permisos
en la instalación (*Settings → Applications → Installed GitHub Apps* → la App →
*Review request*). El panel del AI Developer avisa mientras falte alguno.

### 3. Vista previa en el VPS

Requiere los scripts del servidor actualizados y una línea en
`/opt/platform/etc/platform.conf`:

```bash
rsync -a --delete deploy/platform/ whatever-vps:/root/platform-src/   # desde el repo
bash /root/platform-src/bin/bootstrap-vps.sh                           # en el VPS
echo 'PANEL_ORIGIN=https://launchpad.whatever.tech' >> /opt/platform/etc/platform.conf
```

### 4. Repos de clientes

La vista previa necesita `.github/workflows/preview.yml` y el
`.github/scripts/deploy.sh` de la plantilla **1.5.0**. Los proyectos nuevos ya
los traen. Para uno anterior, copia esos dos archivos de la plantilla al repo
del cliente (el resto del AI Developer funciona sin ellos).

El entorno `production` de los repos no debe restringir ramas de despliegue
(la plataforma lo crea así): el job de vista previa corre en la rama de trabajo.

## Problemas frecuentes

| Síntoma | Causa |
| --- | --- |
| "A la GitHub App le faltan permisos" | Paso 2: cambiar los permisos y aceptarlos en la instalación |
| "El AI Developer no está configurado" | Falta el secret `ANTHROPIC_API_KEY` o no se ha relanzado el despliegue |
| "Anthropic rechazó la clave" | Clave revocada o de otra organización |
| "Anthropic rechazó la petición: …" | El texto tras los dos puntos es el motivo que da Anthropic (p. ej. Managed Agents o el modelo no habilitados en la cuenta). También queda en el log de la API con su `requestId` |
| "La cuenta de Anthropic no tiene saldo" (en el chat) | Facturación de la cuenta empresarial |
| Vista previa: "no tiene el workflow" | Repo con plantilla < 1.5.0 (ver paso 3) |
| Vista previa fallida | El enlace *Ver el log en GitHub Actions* muestra el paso; a menudo es el build: pide a Claude que lo arregle |
| Vista previa "privada" al abrirla en otra pestaña | Normal: solo se entra desde el panel (el pase caduca en 2 minutos) |
