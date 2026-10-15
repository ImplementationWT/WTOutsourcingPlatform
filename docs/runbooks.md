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

## Revertir un cliente a mano

Quita su sitio de nginx sin afectar a los demás:

```bash
mv /etc/nginx/platform-apps/<slug>.conf /root/<slug>.conf.retirado
nginx -t && systemctl reload nginx
```

Si además quieres parar la app: `docker compose -p app-<slug> -f /srv/customer-apps/<slug>/compose.yaml down`.
Para volver a la imagen anterior, redespliega desde el panel ("Redesplegar") o lanza
el workflow Deploy de un commit anterior. La baja automática de clientes (borrar
carpeta, puerto, certificado y red) queda fuera de este alcance.
