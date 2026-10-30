#!/usr/bin/env bash
# Se ejecuta en el VPS (como root) desde .github/workflows/deploy.yml.
# Carga la imagen nueva, cambia el contenedor y, si /health no responde, vuelve al anterior.
# Uso: activate.sh <release-id>
set -euo pipefail

RELEASE="$1"
APP_DIR=/opt/wt-launchpad
WEB_DIR=/var/www/launchpad
INCOMING="$APP_DIR/incoming"
CONTAINER=launchpad-api
IMAGE=launchpad-api
PORT=3001

health() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

start() {
  docker run -d --name "$CONTAINER" \
    --restart unless-stopped \
    --network host \
    --env-file "$APP_DIR/api.env" \
    -v "$APP_DIR/github-app.pem:/run/secrets/github-app.pem:ro" \
    -v "$APP_DIR/initial-password.key:/run/secrets/initial-password.key:ro" \
    -v "$APP_DIR/provisioner_ed25519:/run/secrets/provisioner_ed25519:ro" \
    -v "$APP_DIR/integration.key:/run/secrets/integration.key:ro" \
    -v "$APP_DIR/server-keys.key:/run/secrets/server-keys.key:ro" \
    -v "$APP_DIR/account-vault.key:/run/secrets/account-vault.key:ro" \
    -v "$APP_DIR/anthropic.key:/run/secrets/anthropic.key:ro" \
    -v "$APP_DIR/read-ai.key:/run/secrets/read-ai.key:ro" \
    --log-opt max-size=10m --log-opt max-file=5 \
    "$IMAGE:$1" >/dev/null
}

umask 077
# rsync conserva el uid del runner, que en el VPS puede ser un usuario real: todo pasa a root
# y el directorio queda cerrado para el resto de usuarios.
chmod 700 "$APP_DIR"
# La configuración anterior se guarda: si hay que volver a la imagen anterior, vuelve con la suya
# (una versión nueva puede renombrar variables que la anterior necesita).
[ ! -f "$APP_DIR/api.env" ] || cp -p "$APP_DIR/api.env" "$APP_DIR/api.env.prev"
mv "$INCOMING/api.env" "$APP_DIR/api.env"
chown root:root "$APP_DIR/api.env"
mv "$INCOMING/github-app.pem" "$APP_DIR/github-app.pem"
# Clave de la API de Anthropic (AI Developer). Vacía si no está configurada en GitHub.
if [ -f "$INCOMING/anthropic.key" ]; then mv "$INCOMING/anthropic.key" "$APP_DIR/anthropic.key"; else : > "$APP_DIR/anthropic.key"; fi
# Signing key del webhook de Read.ai (reuniones). Vacía si no está configurada en GitHub.
if [ -f "$INCOMING/read-ai.key" ]; then mv "$INCOMING/read-ai.key" "$APP_DIR/read-ai.key"; else : > "$APP_DIR/read-ai.key"; fi
# Clave de la revelación única de contraseñas iniciales: se genera una vez en el servidor,
# nunca sale de él y se conserva entre despliegues.
[ -s "$APP_DIR/initial-password.key" ] || openssl rand -base64 32 > "$APP_DIR/initial-password.key"
# Clave que cifra las credenciales de integraciones de clientes mientras se aprovisiona.
[ -s "$APP_DIR/integration.key" ] || openssl rand -base64 32 > "$APP_DIR/integration.key"
# Clave que cifra las claves SSH del provisioner de los servidores dados de alta desde el panel.
# Si se pierde, esas claves no se pueden descifrar: hay que rotarlas desde Integraciones.
[ -s "$APP_DIR/server-keys.key" ] || openssl rand -base64 32 > "$APP_DIR/server-keys.key"
# Clave del vault de cuentas por proyecto (Operativa). Si se pierde, las cuentas guardadas no se
# pueden descifrar: hay que volver a cargar sus valores.
[ -s "$APP_DIR/account-vault.key" ] || openssl rand -base64 32 > "$APP_DIR/account-vault.key"
# Clave SSH del orquestador (usuario provisioner del VPS): también se genera aquí una vez. Su
# parte pública se instala con: bootstrap-vps.sh --provisioner-pubkey $APP_DIR/provisioner_ed25519.pub
[ -s "$APP_DIR/provisioner_ed25519" ] ||
  ssh-keygen -q -t ed25519 -N "" -C "launchpad-provisioner" -f "$APP_DIR/provisioner_ed25519"
# El contenedor corre como el usuario "node" (uid 1000) de la imagen, no como root.
chown 1000:1000 "$APP_DIR/github-app.pem" "$APP_DIR/initial-password.key" "$APP_DIR/provisioner_ed25519" "$APP_DIR/integration.key" "$APP_DIR/server-keys.key" "$APP_DIR/account-vault.key" "$APP_DIR/anthropic.key" "$APP_DIR/read-ai.key"
chmod 400 "$APP_DIR/github-app.pem" "$APP_DIR/initial-password.key" "$APP_DIR/provisioner_ed25519" "$APP_DIR/integration.key" "$APP_DIR/server-keys.key" "$APP_DIR/account-vault.key" "$APP_DIR/anthropic.key" "$APP_DIR/read-ai.key"

echo "Cargando imagen $IMAGE:$RELEASE…"
gunzip -c "$INCOMING/api-image.tar.gz" | docker load
rm -f "$INCOMING/api-image.tar.gz"

PREVIOUS="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null | sed 's/.*://' || true)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
start "$RELEASE"

if ! health; then
  echo "::error::La API no respondió en /health."
  # Estado de salida (código, falta de memoria, reinicios) y logs, incluidos los de stderr.
  docker inspect --format 'Contenedor: {{.State.Status}} · código de salida {{.State.ExitCode}} · sin memoria (OOM) {{.State.OOMKilled}} · reinicios {{.RestartCount}} {{.State.Error}}' "$CONTAINER" || true
  echo "Logs (últimas 80 líneas):"
  docker logs --tail 80 "$CONTAINER" 2>&1 || true
  # El contenedor fallido se conserva parado para inspeccionarlo (docker logs launchpad-api-failed),
  # con la configuración con la que falló en api.env.failed. El siguiente despliegue sano los borra.
  docker rm -f "$CONTAINER-failed" >/dev/null 2>&1 || true
  docker update --restart no "$CONTAINER" >/dev/null 2>&1 || true
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rename "$CONTAINER" "$CONTAINER-failed" >/dev/null 2>&1 || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  cp -p "$APP_DIR/api.env" "$APP_DIR/api.env.failed"
  if [ -n "$PREVIOUS" ] && docker image inspect "$IMAGE:$PREVIOUS" >/dev/null 2>&1; then
    echo "Restaurando $IMAGE:$PREVIOUS con su configuración…"
    [ ! -f "$APP_DIR/api.env.prev" ] || mv -f "$APP_DIR/api.env.prev" "$APP_DIR/api.env"
    start "$PREVIOUS"
    health || echo "::error::La versión anterior tampoco responde."
  fi
  exit 1
fi

# API sana: se publica el frontend de este release.
rm -f "$APP_DIR/api.env.prev" "$APP_DIR/api.env.failed"
docker rm -f "$CONTAINER-failed" >/dev/null 2>&1 || true
ln -sfn "$WEB_DIR/releases/$RELEASE" "$WEB_DIR/current.tmp"
mv -T "$WEB_DIR/current.tmp" "$WEB_DIR/current"

# Limpieza: se conservan los 5 últimos releases (web e imágenes) para poder volver atrás.
ls -1dt "$WEB_DIR"/releases/*/ | tail -n +6 | xargs -r rm -rf
docker images "$IMAGE" --format '{{.Tag}}' | grep -vx "$RELEASE" | tail -n +5 | xargs -r -I{} docker rmi "$IMAGE:{}" >/dev/null 2>&1 || true

echo "Release $RELEASE activo."
