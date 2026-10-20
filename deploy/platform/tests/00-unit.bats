#!/usr/bin/env bats
# Funciones de lib/common.sh: validaciones, plantillas y registro de puertos.
load helpers

setup() {
  # shellcheck source=../lib/common.sh
  source "$SRC/lib/common.sh"
  config_defaults
  GHCR_ORG=testorg
  APP_BASE_DOMAIN=apps.test
  REGISTRY_HOST=ghcr.io
}

@test "slug: acepta el formato del panel y rechaza el resto" {
  for ok in acme acme-crm a1 x-2-y; do valid_slug "$ok"; done
  for bad in "" Acme acme_crm -acme acme- acme--crm "acme crm" "acme;id" ../x "$(printf 'a%.0s' {1..31})"; do
    run valid_slug "$bad"
    [ "$status" -ne 0 ]
  done
}

@test "PANEL_UPSTREAM: loopback (Launchpad aquí) o el origen https del panel (otro servidor)" {
  for ok in http://127.0.0.1:3001 http://localhost:3001 https://launchpad.example.com https://panel.example.com:8443; do
    PANEL_UPSTREAM=$ok validate_config
  done
  for bad in http://launchpad.example.com https://launchpad.example.com/api "https://x.com;id" http://10.0.0.5:3001 ftp://x.com; do
    PANEL_UPSTREAM=$bad run validate_config
    [ "$status" -ne 0 ]
  done
}

@test "imagen: solo ghcr.io/<org>/<slug>-app por digest" {
  digest=sha256:$(printf 'a%.0s' {1..64})
  valid_image acme "ghcr.io/testorg/acme-app@$digest"
  for bad in "ghcr.io/testorg/acme-app:latest" "ghcr.io/testorg/acme-app:sha-123" \
    "ghcr.io/otra/acme-app@$digest" "ghcr.io/testorg/beta-app@$digest" "docker.io/testorg/acme-app@$digest" \
    "ghcr.io/testorg/acme-app@sha256:abc" "ghcr.io/testorg/acme-app@$digest;id" "GHCR.IO/testorg/acme-app@$digest"; do
    run valid_image acme "$bad"
    [ "$status" -ne 0 ]
  done
}

@test "env: solo las 6 del contrato; cualquier otra se rechaza (PORT, HOST, NODE_ENV, TRUST_PROXY_HOPS…)" {
  for ok in MONGODB_URI MONGODB_DB SESSION_SECRET INITIAL_ADMIN_PASSWORD APP_DISPLAY_NAME MONDAY_API_TOKEN; do
    env_key_allowed "$ok"
  done
  for bad in PORT HOST NODE_ENV TRUST_PROXY_HOPS LOG_LEVEL SESSION_TTL_HOURS FORCE_ADMIN_PASSWORD_CHANGE MONDAY_MAX_BOARDS PATH LD_PRELOAD FOO monday_api_token; do
    run env_key_allowed "$bad"
    [ "$status" -ne 0 ]
  done
}

@test "authorized_keys: restrict y comando forzado con el slug" {
  key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
  [ "$(authorized_key_line acme "$key")" = "command=\"sudo /opt/platform/bin/deploy-client acme\",restrict $key platform-client:acme" ]
}

@test "clave pública: solo ssh-ed25519, sin opciones ni otros tipos" {
  normalize_pubkey "$(new_pubkey)"
  run normalize_pubkey 'command="id" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
  [ "$status" -ne 0 ]
  run normalize_pubkey "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ"
  [ "$status" -ne 0 ]
  run normalize_pubkey "ssh-ed25519 AAAA"
  [ "$status" -ne 0 ]
}

@test "nginx: la plantilla contiene exactamente el bloque location del contrato" {
  rendered=$(render_template "$SRC/templates/nginx-app.conf" HOST=acme.apps.test PORT=20007 WEBROOT=/var/www/certbot LIVE=/etc/letsencrypt/live)
  expected=$(contract_nginx_block 20007)
  [ -n "$expected" ]
  [[ $expected == *'proxy_set_header Host $host;'* ]]
  [[ $expected == *'proxy_set_header X-Forwarded-Proto $scheme;'* ]]
  [[ $rendered == *"$expected"* ]]
  [[ $rendered == *"return 301 https://\$host\$request_uri;"* ]]
  [[ $rendered == *"ssl_certificate     /etc/letsencrypt/live/acme.apps.test/fullchain.pem;"* ]]
}

@test "compose: endurecido, variables fijadas y publicado solo en 127.0.0.1" {
  out=$(render_template "$SRC/templates/compose.yaml" SLUG=acme IMAGE=ghcr.io/testorg/acme-app@sha256:abc ENV_FILE=/srv/customer-apps/acme/.env \
    PORT=20001 INTERNAL_PORT=3000 CPUS=0.5 MEMORY=512m NETWORK=app-acme HOST=acme.apps.test)
  for expected in '"127.0.0.1:20001:3000"' 'NODE_ENV: production' 'TRUST_PROXY_HOPS: "1"' 'PORT: "3000"' 'HOST: 0.0.0.0' \
    'user: node' 'read_only: true' '- /tmp' '- ALL' 'no-new-privileges:true' 'cpus: "0.5"' 'mem_limit: 512m' \
    'driver: json-file' 'max-size: "10m"' 'max-file: "3"' 'format: raw' 'name: app-acme' 'pull_policy: never'; do
    [[ $out == *"$expected"* ]] || { echo "falta: $expected"; return 1; }
  done
  [[ $out != *"0.0.0.0:20001"* ]]
  # Compose lo acepta.
  dir=$(mktemp -d)
  : >"$dir/.env"
  docker network create app-acme-unit >/dev/null
  sed -e "s#/srv/customer-apps/acme/.env#$dir/.env#" -e 's/name: app-acme$/name: app-acme-unit/' <<<"$out" >"$dir/compose.yaml"
  docker compose -f "$dir/compose.yaml" config >/dev/null
  docker network rm app-acme-unit >/dev/null
}

@test "plantilla: falla si queda un marcador sin rellenar" {
  run render_template "$SRC/templates/nginx-app.conf" HOST=acme.apps.test
  [ "$status" -ne 0 ]
}

@test "puertos: asignación concurrente sin colisiones y reutilización por cliente" {
  CUSTOMER_APPS_DIR=$(mktemp -d)
  PORT_RANGE_START=21000
  PORT_RANGE_END=21099
  for i in $(seq 1 25); do (assign_port "c$i" >"$CUSTOMER_APPS_DIR/out.$i") & done
  wait
  ports=$(for f in "$CUSTOMER_APPS_DIR"/out.*; do cat "$f"; echo; done | sort)
  [ "$(wc -l <<<"$ports")" -eq 25 ]
  [ "$(sort -u <<<"$ports" | wc -l)" -eq 25 ]
  [ "$(wc -l <"$CUSTOMER_APPS_DIR/.ports")" -eq 25 ]
  first=$(cat "$CUSTOMER_APPS_DIR/out.1")
  [ "$(assign_port c1)" = "$first" ]
  [ "$(wc -l <"$CUSTOMER_APPS_DIR/.ports")" -eq 25 ]
  # Nunca se reutiliza el de otro cliente.
  new=$(assign_port nuevo)
  ! grep -qx "$new" <<<"$ports"
}

@test "puertos: error claro si se agota el rango" {
  CUSTOMER_APPS_DIR=$(mktemp -d)
  PORT_RANGE_START=21500
  PORT_RANGE_END=21501
  assign_port a >/dev/null
  assign_port b >/dev/null
  run assign_port c
  [ "$status" -ne 0 ]
  [[ $output == *"no quedan puertos libres"* ]]
}

@test "nginx_apply: una config inválida se revierte y los demás sitios siguen funcionando" {
  config_defaults
  NGINX_RELOAD=signal
  install -d "$NGINX_APPS_DIR"
  printf 'server { listen 18081; return 200 "other\\n"; }\n' >/etc/nginx/http.d/other.conf
  nginx -s reload
  sleep 1
  [ "$(curl -s http://127.0.0.1:18081/)" = "other" ]

  # Un archivo que nginx sí incluye (el include de la plataforma aún no está activo aquí).
  target=/etc/nginx/http.d/unit.conf
  printf '# anterior\n' >"$target"
  run nginx_apply "$target" "esto no es { configuración válida"
  [ "$status" -ne 0 ]
  [[ $output == *"se restauró la anterior"* ]]
  [ "$(cat "$target")" = "# anterior" ]
  nginx -t
  [ "$(curl -s http://127.0.0.1:18081/)" = "other" ]
  rm -f "$target"
}
