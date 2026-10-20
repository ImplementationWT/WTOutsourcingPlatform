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
   **Archivos .md:** con *Adjuntar .md* (o soltándolos sobre el cuadro de texto) se
   envían especificaciones, textos o guías en Markdown junto al mensaje, también al
   empezar la sesión. Claude los recibe como documentos, con su nombre como título;
   no se guardan en el repo salvo que se le pida. Hasta 5 por mensaje, 200 KB cada
   uno y 600 KB en total. El chat y la auditoría solo muestran el nombre.
3. **Código.** Claude edita, ejecuta `pnpm lint`, `typecheck`, `test` y `build`,
   hace commit y push **solo a su rama**.
4. **Vista previa en vivo.** En cuanto Claude sube su primer cambio, la vista previa
   arranca sola en `https://preview-<slug>.<dominio>`, embebida junto al chat. El
   servidor del proyecto clona la rama y la ejecuta en modo desarrollo
   (`pnpm dev:preview`, con Vite en caliente), sin pasar por GitHub Actions.
   - Cada commit nuevo de Claude se trae solo y se ve en segundos, sin recargar ni
     reconstruir. El primer arranque tarda 1–2 minutos porque instala dependencias.
   - Usa una **base de datos vacía y temporal** (`admin` / `admin123`, sin cambio
     obligatorio).
   - Se apaga sola tras una hora sin visitas y se vuelve a levantar al abrir el panel.
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
- **La vista en vivo ejecuta la rama del agente en el servidor**, en un contenedor
  aislado:
  - usuario `node`, sin capacidades ni escalada de privilegios, con límites de CPU,
    memoria y procesos;
  - publicado solo en loopback, detrás del nginx con pase;
  - sin la red ni los secretos de producción.

  El clon lo hace un usuario sin privilegios (uid 1000) con un token de **solo
  lectura** de ese repo que caduca en una hora. El token viaja solo en variables de
  entorno: no aparece en los procesos ni se guarda en el clon.
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
| Variable | `ANTHROPIC_WORKSPACE` | ID del workspace (`wrkspc_…`, en *Settings → Workspaces*). **Obligatoria** si la clave no está ligada a un workspace (claves de organización); opcional si la clave es del workspace *Default* |
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

La vista en vivo necesita `pnpm dev:preview`, de la plantilla **1.6.0**. Los
proyectos nuevos ya lo traen. Para un repo anterior, copia de la plantilla:

- `scripts/dev-preview.mjs`;
- el script `dev:preview` de `package.json`;
- el bloque `livePreview` de `web/vite.config.ts`.

El resto del AI Developer funciona sin ellos. `preview.yml` ya no se usa.

## Problemas frecuentes

| Síntoma | Causa |
| --- | --- |
| "A la GitHub App le faltan permisos" | Paso 2: cambiar los permisos y aceptarlos en la instalación |
| "El AI Developer no está configurado" | Falta el secret `ANTHROPIC_API_KEY` o no se ha relanzado el despliegue |
| "Anthropic rechazó la clave" | Clave revocada o de otra organización |
| "…not scoped to a workspace…anthropic-workspace-id…" | Clave de organización: define la variable `ANTHROPIC_WORKSPACE` (paso 1) y relanza el despliegue |
| "Anthropic rechazó la petición: …" | El texto tras los dos puntos es el motivo que da Anthropic (p. ej. Managed Agents o el modelo no habilitados en la cuenta). También queda en el log de la API con su `requestId` |
| "La cuenta de Anthropic no tiene saldo" (en el chat) | Facturación de la cuenta empresarial |
| Vista previa: "nginx -t falló … server_names_hash_bucket_size" | Host de vista previa largo: vuelve a ejecutar `bootstrap-vps.sh` (paso 3), que lo sube a 128 en `/etc/nginx/platform-apps/_platform-http.conf` |
| Vista previa: "el repo no tiene pnpm dev:preview" | Repo con plantilla < 1.6.0 (ver paso 4) |
| Vista previa fallida | El aviso trae las últimas líneas de la app (instalación o arranque): pide a Claude que lo arregle |
| Vista previa "privada" al abrirla en otra pestaña | Normal: solo se entra desde el panel (el pase caduca en 2 minutos) |
