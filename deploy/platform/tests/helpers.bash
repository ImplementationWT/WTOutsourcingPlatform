# shellcheck shell=bash
# Utilidades compartidas por las pruebas bats (solo dentro del contenedor de pruebas).
SRC=/src/deploy/platform
CONTRACT=/src/docs/TEMPLATE_CONTRACT.md

write_test_config() {
  install -d -m 755 /opt/platform/etc
  cat >/opt/platform/etc/platform.conf <<CONF
GHCR_ORG=testorg
APP_BASE_DOMAIN=apps.test
ACME_EMAIL=ops@example.test
NGINX_CONF=/etc/nginx/nginx.conf
NGINX_RELOAD=signal
PORT_RANGE_START=20000
PORT_RANGE_END=20050
REGISTRY_HOST=localhost:5000
DEPLOY_WAIT_SECONDS=45
PANEL_ORIGIN=https://launchpad.test
PREVIEW_MONGO_IMAGE=localhost:5000/fake-mongo:8
${1:-}
CONF
}

# Clave pública ed25519 nueva (una línea).
new_pubkey() {
  local dir
  dir=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N "" -C "test" -f "$dir/key"
  cat "$dir/key.pub"
  rm -rf "$dir"
}

# Bloque nginx del contrato (§6) con el puerto dado e indentado como en el server.
contract_nginx_block() {
  awk '/^```nginx$/ { inside = 1; next } inside && /^```$/ { exit } inside { print }' "$CONTRACT" |
    sed -e "s/<puerto del cliente>/$1/" -e 's/^\(.\)/    \1/'
}

payload() { # <image> [env JSON extra]
  jq -cn --arg image "$1" --argjson extra "${2:-{\}}" '{
    image: $image,
    env: ({
      MONGODB_URI: "mongodb+srv://app_acme:s3cr3t-Pa55@cluster.example.test/?retryWrites=true&w=majority",
      MONGODB_DB: "client_acme",
      SESSION_SECRET: "session-secret-0123456789-abcdefghijkl",
      INITIAL_ADMIN_PASSWORD: "Init-Pa55word-xyz",
      APP_DISPLAY_NAME: "Acme $ \"CRM\" & Co"
    } + $extra),
    registryToken: "ghs_registryTokenForTests0123456789"
  }'
}
