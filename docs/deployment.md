# Despliegue de apps de clientes en el VPS compartido

Cada cliente se publica en `https://<slug>.<APP_BASE_DOMAIN>` (por ejemplo
`https://acme.apps.whatever.tech`), detrás del **nginx que ya tiene el VPS**, con un
certificado de Let's Encrypt por subdominio emitido por **Certbot**. El protocolo
entre el repo del cliente y el servidor es el del contrato del template
(`docs/TEMPLATE_CONTRACT.md`, `node-typescript@1.3.0`, §3–§6).

## Qué hace cada pieza

```
Panel / orquestador (launchpad)              VPS compartido
──────────────────────────────               ─────────────────────────────────────────────
github_secrets  → MONGODB_*, SESSION_SECRET,
                  INITIAL_ADMIN_PASSWORD, APP_DISPLAY_NAME
dns_https       → <slug>.<dominio> resuelve a VPS_PUBLIC_IP (comodín *.<dominio>)
server_prepare  ─ssh provisioner→ provisioner-dispatch ─sudo→ install-client <slug>
                  (clave pública por stdin)       puerto, carpeta, red, certificado, nginx,
                                                  clave del cliente en ~deploy (comando forzado)
                → DEPLOY_SSH_KEY (secret), DEPLOY_HOST, DEPLOY_KNOWN_HOSTS, APP_HOSTNAME
deploy          → workflow_dispatch del repo ──── runner ─ssh deploy→ sudo deploy-client <slug>
                                                  (JSON por stdin: image, env, registryToken)
health_check    → https://<slug>.<dominio>/health/ready, /api/meta y / (certificado válido)
```

Ninguna etapa borra recursos ante un fallo: el panel muestra el motivo y se reintenta.

## Rutas propias en el servidor

| Ruta | Contenido |
| --- | --- |
| `/opt/platform/bin` | `bootstrap-vps.sh`, `install-client`, `deploy-client`, `client-status`, `uninstall-client`, `provisioner-dispatch` (root:root, 755) |
| `/opt/platform/lib`, `/opt/platform/templates` | Biblioteca común y plantillas de nginx y compose |
| `/opt/platform/etc/platform.conf` | Configuración (`GHCR_ORG`, `APP_BASE_DOMAIN`, `ACME_EMAIL`, …). Se lee clave a clave, no se ejecuta |
| `/srv/customer-apps/<slug>` | `.env` (0600), `compose.yaml`, `state.json` (imagen y fecha del último despliegue), `deploy.log` |
| `/srv/customer-apps/.ports` | Registro de puertos `slug puerto` (con `flock`) |
| `/etc/nginx/platform-apps/<slug>.conf` | `server` del cliente (80 → 443 y proxy a `127.0.0.1:<puerto>`) |
| `/var/www/certbot` | Webroot de los desafíos ACME |

No se modifican Docker (`/etc/docker/daemon.json`), el firewall, `sshd_config`, las
actualizaciones automáticas ni los sitios, contenedores o certificados existentes.
`nginx.conf` solo se toca con `bootstrap-vps.sh --wire-nginx` (una línea `include`).

## Seguridad

- **Usuarios.** `deploy` y `provisioner` tienen shell `/bin/sh` (sshd ejecuta el
  comando forzado a través de ella) y contraseña `*` (sin login por contraseña). Sus
  claves llevan `restrict` (sin PTY ni reenvíos) y un comando forzado.
- **Cliente → servidor.** Una clave ed25519 por cliente en `~deploy/.ssh/authorized_keys`:
  `command="sudo /opt/platform/bin/deploy-client <slug>",restrict ssh-ed25519 … platform-client:<slug>`.
  El slug lo fija el servidor: un repo no puede desplegar en otro cliente.
- **Orquestador → servidor.** Una clave en `~provisioner/.ssh/authorized_keys` con
  `command="/opt/platform/bin/provisioner-dispatch",restrict`. El dispatch solo acepta
  exactamente `install-client <slug>`, `client-status <slug>` o `uninstall-client <slug>`; cualquier otra cosa
  sale con 126. El adaptador fija la huella del servidor (`DEPLOY_HOST_KEY`), como
  `StrictHostKeyChecking yes`.
- **sudoers** (`/etc/sudoers.d/platform-apps`): `deploy` solo puede ejecutar
  `deploy-client`; `provisioner`, solo `install-client`, `client-status` y `uninstall-client`.
- **Imagen.** `deploy-client` solo acepta `ghcr.io/<GHCR_ORG>/<slug>-app@sha256:<64 hex>`.
  Hace `docker login` con el `registryToken` (el `GITHUB_TOKEN` del job, de vida corta)
  en un directorio temporal que borra al terminar: en el VPS no queda ningún token.
- **Variables.** Se aceptan las de la tabla de §5 y las opcionales de la app (§2).
  `PORT`, `HOST`, `NODE_ENV` y `TRUST_PROXY_HOPS` se rechazan: las fija el compose
  (`NODE_ENV=production`, `TRUST_PROXY_HOPS=1`, `PORT=3000`, `HOST=0.0.0.0` dentro del
  contenedor). El `.env` es 0600 y nunca se imprime.
- **Contenedor.** Usuario `node`, `read_only`, `tmpfs /tmp`, `cap_drop: ALL`,
  `no-new-privileges`, CPU y memoria limitadas, healthcheck de `/health`, red propia
  `app-<slug>`, logs `json-file` con rotación (10m × 3) y publicado **solo** en
  `127.0.0.1:<puerto>:3000`. Un cliente no alcanza el puerto ni el contenedor de otro.
- **Salidas.** `deploy-client` imprime solo `DEPLOY_OK` o `DEPLOY_FAILED <motivo>`.
  Logs, eventos y API de la plataforma no contienen claves, tokens ni variables.

## Diferencias con el contrato del template

- **Ruta del comando forzado.** El contrato (§5) muestra
  `command="/usr/local/bin/<despliegue> <slug>",restrict`. El nombre es un marcador
  libre; aquí se usa `command="sudo /opt/platform/bin/deploy-client <slug>",restrict`
  para que todo quede en las rutas de la plataforma. El workflow del template no
  envía comando remoto, así que no le afecta. El template no se modifica desde este repo.
- **Variables rechazadas.** §5.1 acepta "las opcionales de §2"; de ellas se rechazan
  `PORT`, `HOST`, `NODE_ENV` y `TRUST_PROXY_HOPS`, que fija el servidor (§5.3).
- **Rollback.** Si la imagen nueva no queda sana, `deploy-client` vuelve al digest
  anterior (el contrato no lo exige) y responde `DEPLOY_FAILED unhealthy (rolled back…)`.

## Configuración

**Orquestador** (`apps/api/.env`, o variables del entorno `production` del repo de la
plataforma): `DEPLOY_ENABLED=true`, `DEPLOY_HOST`, `DEPLOY_SSH_PORT` (22),
`DEPLOY_HOST_KEY` (línea `known_hosts` verificada), `PROVISIONER_SSH_KEY_SECRET_REF`
(ruta a la clave privada; en producción la genera `deploy/activate.sh` en
`/opt/wt-launchpad/provisioner_ed25519`), `GHCR_ORG`, `APP_BASE_DOMAIN`, `VPS_PUBLIC_IP`
y, solo para pruebas, `ACME_CA`.

**Servidor** (`/opt/platform/etc/platform.conf`): `GHCR_ORG`, `APP_BASE_DOMAIN`,
`ACME_EMAIL`, `ACME_CA` (staging, solo pruebas), `NGINX_APPS_DIR`
(`/etc/nginx/platform-apps`), `CERTBOT_WEBROOT` (`/var/www/certbot`),
`PORT_RANGE_START`/`PORT_RANGE_END` (20000–29999), `APP_CPUS`, `APP_MEMORY`,
`DEPLOY_WAIT_SECONDS`. Estos valores viven en el servidor porque los scripts calculan
host, puerto y rutas allí, nunca a partir de lo que envía el orquestador.

## Instalación (una vez)

1. Copia los scripts al VPS desde la raíz del repo:
   `rsync -a --delete deploy/platform/ whatever-vps:/root/platform-src/`
2. En el VPS: `bash /root/platform-src/bin/bootstrap-vps.sh`. Comprueba Docker, nginx,
   certbot y jq (si falta algo, lo dice y se detiene), crea usuarios, rutas, sudoers,
   registro de puertos y el hook de renovación, y crea `platform.conf` si no existe.
   Sin `--wire-nginx` **no toca nginx.conf** e imprime la línea que falta.
3. Completa `/opt/platform/etc/platform.conf` (`GHCR_ORG`, `APP_BASE_DOMAIN`, `ACME_EMAIL`).
4. Añade el `include` de nginx, a mano o con `--wire-nginx` (copia de seguridad,
   `nginx -t` y restauración si falla), e instala la clave del orquestador:
   `bash /root/platform-src/bin/bootstrap-vps.sh --wire-nginx --provisioner-pubkey /opt/wt-launchpad/provisioner_ed25519.pub`
5. Línea a añadir a mano, dentro de `http { … }` de `/etc/nginx/nginx.conf`:
   `include /etc/nginx/platform-apps/*.conf;` y después `nginx -t && systemctl reload nginx`.
6. Comprueba la renovación: `certbot renew --dry-run`.

## Pruebas

- Scripts del servidor: `deploy/platform/tests/run.sh` (contenedor local con Docker
  propio, nginx, certbot simulado y registro local; no se conecta a ningún servidor).
  También corre en CI (job `server-scripts`), junto con shellcheck.
- Orquestador: `pnpm test` en `apps/api` (adaptadores simulados y un sshd en proceso).
