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
    --log-opt max-size=10m --log-opt max-file=5 \
    "$IMAGE:$1" >/dev/null
}

umask 077
mv "$INCOMING/api.env" "$APP_DIR/api.env"
mv "$INCOMING/github-app.pem" "$APP_DIR/github-app.pem"
# El contenedor corre como el usuario "node" (uid 1000) de la imagen, no como root.
chown 1000:1000 "$APP_DIR/github-app.pem"
chmod 400 "$APP_DIR/github-app.pem"

echo "Cargando imagen $IMAGE:$RELEASE…"
gunzip -c "$INCOMING/api-image.tar.gz" | docker load
rm -f "$INCOMING/api-image.tar.gz"

PREVIOUS="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null | sed 's/.*://' || true)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
start "$RELEASE"

if ! health; then
  echo "::error::La API no respondió en /health. Logs:"
  docker logs --tail 80 "$CONTAINER" || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$PREVIOUS" ] && docker image inspect "$IMAGE:$PREVIOUS" >/dev/null 2>&1; then
    echo "Restaurando $IMAGE:$PREVIOUS…"
    start "$PREVIOUS"
    health || echo "::error::La versión anterior tampoco responde."
  fi
  exit 1
fi

# API sana: se publica el frontend de este release.
ln -sfn "$WEB_DIR/releases/$RELEASE" "$WEB_DIR/current.tmp"
mv -T "$WEB_DIR/current.tmp" "$WEB_DIR/current"

# Limpieza: se conservan los 5 últimos releases (web e imágenes) para poder volver atrás.
ls -1dt "$WEB_DIR"/releases/*/ | tail -n +6 | xargs -r rm -rf
docker images "$IMAGE" --format '{{.Tag}}' | grep -vx "$RELEASE" | tail -n +5 | xargs -r -I{} docker rmi "$IMAGE:{}" >/dev/null 2>&1 || true

echo "Release $RELEASE activo."
