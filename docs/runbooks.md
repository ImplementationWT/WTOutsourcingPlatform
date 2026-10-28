# Runbooks del VPS compartido

Comandos en el VPS como root salvo que se indique otra cosa. Contexto en
[deployment.md](deployment.md).

## Ejecutar o repetir el bootstrap

```bash
rsync -a --delete deploy/platform/ whatever-vps:/root/platform-src/   # desde el repo (tu equipo)
bash /root/platform-src/bin/bootstrap-vps.sh                           # en el VPS; idempotente
```

Reinstala los scripts en `/opt/platform` (root:root) sin tocar `platform.conf`, el
registro de puertos ni los clientes. Úsalo también para actualizar los scripts.

## Añadir el include de nginx

Automático (copia `nginx.conf.platform-bak.<fecha>`, `nginx -t` y restaura si falla):

```bash
bash /root/platform-src/bin/bootstrap-vps.sh --wire-nginx
```

A mano: dentro del bloque `http { … }` de `/etc/nginx/nginx.conf` añade

```nginx
include /etc/nginx/platform-apps/*.conf;
```

y ejecuta `nginx -t && systemctl reload nginx`. Comprobación:
`nginx -T 2>/dev/null | grep 'platform-apps/\*.conf'`.

## Verificar la renovación de certificados

```bash
certbot renew --dry-run
ls /etc/letsencrypt/renewal-hooks/deploy/      # platform-reload-nginx (nginx -t && systemctl reload nginx)
certbot certificates | grep -A3 apps.          # caducidad de los de clientes
```

## Ver el registro de puertos

```bash
cat /srv/customer-apps/.ports                  # "slug puerto", uno por cliente
ss -ltnp | grep '127.0.0.1:2'                  # puertos de clientes escuchando (solo loopback)
```

No lo edites a mano mientras haya instalaciones en curso (usa `flock /srv/customer-apps/.ports.lock`).

## Estado de un cliente

```bash
/opt/platform/bin/client-status <slug> | jq .
docker compose -p app-<slug> ps
tail -n 50 /srv/customer-apps/<slug>/deploy.log
```

## Rotar la clave del orquestador (provisioner)

1. En el VPS: `rm /opt/wt-launchpad/provisioner_ed25519 /opt/wt-launchpad/provisioner_ed25519.pub`.
2. Relanza el despliegue de la plataforma (Actions → Deploy → Run workflow): `activate.sh` genera un par nuevo.
3. Instala la pública nueva (reemplaza la anterior, no la duplica):
   `bash /root/platform-src/bin/bootstrap-vps.sh --provisioner-pubkey /opt/wt-launchpad/provisioner_ed25519.pub`

## Rotar la clave de un cliente

En el VPS (la clave privada solo pasa por un archivo temporal de root):

```bash
umask 077
ssh-keygen -q -t ed25519 -N "" -C "implementationwt/<slug>-app" -f /root/rotar-<slug>
/opt/platform/bin/install-client <slug> < /root/rotar-<slug>.pub   # reemplaza la línea platform-client:<slug>
cat /root/rotar-<slug>                                              # cópiala al paso siguiente
```

1. En GitHub, repo `<slug>-app` → Settings → Environments → production → `DEPLOY_SSH_KEY`
   → *Update*: pega la clave privada completa (de `-----BEGIN` a `-----END`).
2. Borra los archivos: `shred -u /root/rotar-<slug> /root/rotar-<slug>.pub`.
3. Comprueba que solo hay una clave: `grep -c 'platform-client:<slug>$' /home/deploy/.ssh/authorized_keys` → `1`.
4. En el panel, "Redesplegar" en el detalle del cliente para verificarla.

La plataforma no deshace la rotación: si el secret existe, `server_prepare` llama a
`install-client` sin clave y el servidor conserva la instalada.

Para revocar de inmediato (el cliente deja de poder desplegar):
`sed -i '/ platform-client:<slug>$/d' /home/deploy/.ssh/authorized_keys`.

## Actualizar el servidor con la lista de variables permitida

`deploy-client` acepta exactamente las 8 variables del contrato (`MONGODB_URI`,
`MONGODB_DB`, `SESSION_SECRET`, `INITIAL_ADMIN_PASSWORD`, `APP_DISPLAY_NAME`,
`MONDAY_API_TOKEN` desde el template 1.4.0, y `ANTHROPIC_API_KEY` y `WILL_DOO_MODE` de
Will Doo desde el 1.7.0) y rechaza cualquier otra. Para instalar la
versión nueva de los scripts:

```bash
rsync -a --delete deploy/platform/ whatever-vps:/root/platform-src/   # desde el repo (tu equipo)
bash /root/platform-src/bin/bootstrap-vps.sh                           # en el VPS; idempotente
grep -A2 'ALLOWED_ENV_KEYS=(' /opt/platform/lib/common.sh               # comprobar la lista
```

No hace falta reiniciar nada: cada despliegue usa la versión instalada.

## Rotar la credencial de integración de un cliente

1. Genera la credencial nueva en el proveedor (Monday.com: avatar → Developers → My access tokens).
2. En el panel: detalle del cliente → **Integraciones** → *Actualizar credencial* → pega
   el valor → *Probar conexión* → *Guardar*.
   - Cliente listo: se escribe `MONDAY_API_TOKEN` en el entorno `production` y se
     redespliega (el progreso aparece en *Aprovisionamiento*).
   - Cliente con el aprovisionamiento fallido: se guarda (o escribe) y se aplica al
     pulsar *Reintentar*.
3. Revoca la credencial anterior en el proveedor.

Para quitar la integración: *Desactivar* (borra el secret y redespliega). Detalles en
[security.md](security.md).

## Will Doo (co-pilot) en un proyecto

Will Doo vive en la app del cliente, desde la plantilla 1.7.0. Cada proyecto tiene una de
tres opciones, que se elige en la tarjeta **Will Doo** de su detalle:

| Opción | Qué hace | Requiere |
| --- | --- | --- |
| **Will Doo + Claude** | Chat libre: responde con datos vivos, entiende la pantalla y analiza | Clave de Anthropic de la cuenta del cliente |
| **Will Doo solo** (por defecto) | Informativo, sin IA ni costo: consultas rápidas sobre los datos que existen y la guía de uso | — |
| **Sin Will Doo** | No aparece | — |

Al guardar, Launchpad escribe la variable `WILL_DOO_MODE` en el entorno `production` del
repo y redespliega. Un proyecto sin la variable funciona como «Will Doo solo».

**Antes de empezar:** el VPS del proyecto debe aceptar `WILL_DOO_MODE` y
`ANTHROPIC_API_KEY` (ver [Actualizar el servidor con la lista de variables permitida](#actualizar-el-servidor-con-la-lista-de-variables-permitida)).
Con un servidor sin actualizar, el despliegue falla con `DEPLOY_FAILED` en cuanto se elige
una opción.

**Pasar a «Will Doo + Claude»:**

1. **Clave del cliente.** El cliente crea la clave en **su** cuenta de Anthropic
   (console.anthropic.com → Settings → API keys), y el consumo se le factura a él. Lo mejor
   es una clave solo para este proyecto.
2. **Guardar la clave.** Detalle del proyecto → **Integraciones** → **Will Doo + Claude** →
   *Activar* → pega la clave → *Probar conexión* → *Guardar*. Se escribe `ANTHROPIC_API_KEY`
   y se redespliega.
3. **Elegir la opción.** Tarjeta **Will Doo** → «Will Doo + Claude» → *Guardar*.
4. **Permisos en la app del cliente.** El rol `admin` ya tiene `willdoo.use`; dalo a los
   roles que deban usar Will, en cualquiera de las opciones.

Si se *Desactiva* la clave, el proyecto pasa solo a «Will Doo solo». Los proyectos
anteriores a 1.7.0 necesitan primero el cambio del template: hasta entonces la opción se
guarda, pero Will no aparece. El tope de gasto de «Will Doo + Claude» es de 50 USD al mes por
defecto (`WILL_DOO_MONTHLY_BUDGET_USD` en la app; ver el contrato §2).

## Borrar un cliente

Desde el panel: detalle del proyecto → **Zona de peligro** → *Eliminar proyecto* (hay que
escribir el identificador). Borra, en este orden y solo lo que la plataforma creó para ese
cliente:

1. Comprobación previa: si el usuario de Atlas no está etiquetado como de ese cliente, no se borra nada.
2. Servidor (`uninstall-client`): contenedor e imágenes, red, sitio de nginx (con `nginx -t`;
   si fallara se restaura), certificado, clave en `~deploy`, puerto y `/srv/customer-apps/<slug>`.
3. GitHub: el repositorio `<slug>-app` y su imagen en GHCR. En cuentas personales GitHub no deja
   a la App borrar paquetes: el panel avisa con el enlace para borrarla a mano.
4. MongoDB: las colecciones de `client_<slug>` (con el usuario del cliente) y el usuario `app_<slug>`.
5. Registros de la plataforma (la auditoría se conserva). El DNS no se toca: el comodín es compartido.

Si un paso falla, *Reintentar el borrado* continúa: lo ya borrado no se repite.

Requiere `uninstall-client` en el VPS (bootstrap actualizado):

```bash
rsync -a --delete deploy/platform/ whatever-vps:/root/platform-src/   # desde el repo (tu equipo)
bash /root/platform-src/bin/bootstrap-vps.sh                           # en el VPS: instala el script y actualiza sudoers
```

A mano en el VPS (solo la parte del servidor): `/opt/platform/bin/uninstall-client <slug>`.

## Revertir un cliente a mano

Quita su sitio de nginx sin afectar a los demás:

```bash
mv /etc/nginx/platform-apps/<slug>.conf /root/<slug>.conf.retirado
nginx -t && systemctl reload nginx
```

Si además quieres parar la app: `docker compose -p app-<slug> -f /srv/customer-apps/<slug>/compose.yaml down`.
Para volver a la imagen anterior, redespliega desde el panel ("Redesplegar") o lanza
el workflow Deploy de un commit anterior.
