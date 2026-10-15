#!/usr/bin/env bash
# Configuración única del CD. Ejecutar desde la raíz del repo, en una máquina con:
#   - acceso root al VPS por el alias SSH "whatever-vps"
#   - gh autenticado (gh auth login) con permisos de admin sobre el repo
#   - apps/api/.env con los valores de producción
#
#   scripts/setup-deploy.sh server    # autoriza la clave de Actions, crea directorios, Nginx y certificado
#   scripts/setup-deploy.sh secrets   # sube variables y secrets al entorno "production" de GitHub
#   scripts/setup-deploy.sh all       # ambos
set -euo pipefail

SSH_ALIAS=whatever-vps
DEPLOY_USER=root
DEPLOY_KEY="$HOME/.ssh/launchpad_deploy"
ENV_FILE=apps/api/.env
GH_ENV=production

ensure_key() {
  [ -f "$DEPLOY_KEY" ] || ssh-keygen -t ed25519 -N "" -C "github-actions@launchpad" -f "$DEPLOY_KEY" >/dev/null
}

server() {
  ensure_key
  scp -q deploy/bootstrap-server.sh deploy/nginx/launchpad.whatever.tech.conf "$SSH_ALIAS:/tmp/"
  ssh "$SSH_ALIAS" "bash /tmp/bootstrap-server.sh '$(cat "$DEPLOY_KEY.pub")' /tmp/launchpad.whatever.tech.conf && rm -f /tmp/bootstrap-server.sh"
}

# Lee KEY=valor de .env sin interpretar el valor (los hashes scrypt llevan '$').
env_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1)" || { echo "Falta $1 en $ENV_FILE" >&2; return 1; }
  printf '%s' "${line#*=}"
}

secrets() {
  ensure_key
  command -v gh >/dev/null || { echo "Instala gh: brew install gh && gh auth login" >&2; exit 1; }
  local repo host
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  host="$(ssh -G "$SSH_ALIAS" | awk '/^hostname /{print $2}')"

  gh api -X PUT "repos/$repo/environments/$GH_ENV" --silent

  local var secret
  # GitHub no admite nombres que empiecen por GITHUB_: se guardan como GH_* y deploy.yml los traduce.
  for var in APP_ID INSTALLATION_ID TEMPLATE_OWNER TEMPLATE_REPO TARGET_OWNER; do
    env_value "GITHUB_$var" | gh variable set "GH_$var" --env "$GH_ENV" --repo "$repo"
  done
  for var in ATLAS_PROJECT_ID ATLAS_CLIENT_ID ATLAS_CLUSTER_NAME ATLAS_CLUSTER_SRV_HOST APPS_DOMAIN PANEL_ADMIN_USERNAME DEPLOY_ENABLED; do
    env_value "$var" | gh variable set "$var" --env "$GH_ENV" --repo "$repo"
  done
  for secret in ATLAS_CLIENT_SECRET ADMIN_MONGODB_URI PANEL_ADMIN_PASSWORD_HASH SESSION_SECRET; do
    env_value "$secret" | gh secret set "$secret" --env "$GH_ENV" --repo "$repo"
  done
  gh secret set GH_APP_PRIVATE_KEY --env "$GH_ENV" --repo "$repo" < "$(env_value GITHUB_PRIVATE_KEY_PATH)"

  printf '%s' "$host" | gh secret set SERVER_SSH_HOST --env "$GH_ENV" --repo "$repo"
  printf '%s' "$DEPLOY_USER" | gh secret set SERVER_SSH_USER --env "$GH_ENV" --repo "$repo"
  gh secret set SERVER_SSH_PRIVATE_KEY --env "$GH_ENV" --repo "$repo" < "$DEPLOY_KEY"
  # Huella tomada de known_hosts local (ya verificada al conectar), no de un keyscan a ciegas.
  ssh-keygen -F "$host" | grep -v '^#' | gh secret set SERVER_SSH_KNOWN_HOSTS --env "$GH_ENV" --repo "$repo"

  echo "Entorno $GH_ENV de $repo configurado."
}

case "${1:-}" in
  server) server ;;
  secrets) secrets ;;
  all) server; secrets ;;
  *) echo "Uso: $0 server|secrets|all" >&2; exit 1 ;;
esac
