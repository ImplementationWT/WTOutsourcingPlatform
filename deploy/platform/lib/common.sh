# shellcheck shell=bash
# shellcheck disable=SC2034  # constantes usadas por los scripts que cargan esta biblioteca
# Funciones comunes de los scripts de /opt/platform/bin.
#
# Se cargan desde una ruta fija propiedad de root. Ninguna función evalúa
# entradas: los valores externos (slug, clave pública, JSON) se validan con
# expresiones regulares o jq antes de usarse, y las plantillas se rellenan con
# sustitución de texto, nunca ejecutándolas.

# En bash ≥ 5.2, "&" en el reemplazo de ${var//patrón/reemplazo} inserta el texto
# encontrado: se desactiva para que los valores se copien literalmente.
shopt -u patsub_replacement 2>/dev/null || true

readonly PLATFORM_DIR=/opt/platform
readonly PLATFORM_CONF="$PLATFORM_DIR/etc/platform.conf"
readonly SLUG_RE='^[a-z0-9]+(-[a-z0-9]+)*$'
readonly SLUG_MAX=30
readonly APP_INTERNAL_PORT=3000 # contrato §6
readonly KEY_MARKER_PREFIX="platform-client:"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

valid_slug() {
  [[ ${#1} -le $SLUG_MAX && $1 =~ $SLUG_RE ]]
}

require_slug() {
  valid_slug "${1:-}" || die "slug inválido (minúsculas, números y guiones; máx. $SLUG_MAX caracteres)"
}

# ---- configuración ------------------------------------------------------------

# Valores por defecto; platform.conf los sobrescribe. Las variables del entorno
# no cuentan: todo sale de un archivo propiedad de root.
config_defaults() {
  GHCR_ORG=""
  APP_BASE_DOMAIN=""
  ACME_EMAIL=""
  ACME_CA=""
  NGINX_APPS_DIR=/etc/nginx/platform-apps
  NGINX_CONF=/etc/nginx/nginx.conf
  NGINX_RELOAD=systemctl
  CERTBOT_WEBROOT=/var/www/certbot
  LETSENCRYPT_LIVE=/etc/letsencrypt/live
  CUSTOMER_APPS_DIR=/srv/customer-apps
  PORT_RANGE_START=20000
  PORT_RANGE_END=29999
  APP_CPUS=0.5
  APP_MEMORY=512m
  DEPLOY_WAIT_SECONDS=180
  REGISTRY_HOST=ghcr.io
  # Vistas previas del AI Developer: origen del panel (frame-ancestors) y su API en loopback.
  PANEL_ORIGIN=""
  PANEL_UPSTREAM=http://127.0.0.1:3001
  PREVIEW_MONGO_IMAGE=mongo:8
}

# Lee KEY=valor línea a línea (sin source/eval) y valida cada clave conocida.
load_config() {
  local file=$PLATFORM_CONF line key value
  config_defaults
  [[ -r $file ]] || die "falta $file: copia platform.conf.example y complétalo"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || die "línea inválida en $file"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case $key in
      GHCR_ORG | APP_BASE_DOMAIN | ACME_EMAIL | ACME_CA | NGINX_APPS_DIR | NGINX_CONF | NGINX_RELOAD | \
        CERTBOT_WEBROOT | LETSENCRYPT_LIVE | CUSTOMER_APPS_DIR | PORT_RANGE_START | PORT_RANGE_END | \
        APP_CPUS | APP_MEMORY | DEPLOY_WAIT_SECONDS | REGISTRY_HOST | PANEL_ORIGIN | PANEL_UPSTREAM | PREVIEW_MONGO_IMAGE)
        printf -v "$key" '%s' "$value"
        ;;
      *) die "clave desconocida en $file: $key" ;;
    esac
  done <"$file"
  validate_config
}

validate_config() {
  local path_re='^/[A-Za-z0-9._/-]+$'
  [[ $GHCR_ORG =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "GHCR_ORG debe ser el owner de GHCR en minúsculas"
  [[ $APP_BASE_DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "APP_BASE_DOMAIN debe ser un dominio (p. ej. apps.example.com)"
  [[ -z $ACME_EMAIL || $ACME_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "ACME_EMAIL inválido"
  [[ -z $ACME_CA || $ACME_CA =~ ^https://[^[:space:]]+$ ]] || die "ACME_CA debe ser una URL https"
  local p
  for p in "$NGINX_APPS_DIR" "$NGINX_CONF" "$CERTBOT_WEBROOT" "$LETSENCRYPT_LIVE" "$CUSTOMER_APPS_DIR"; do
    [[ $p =~ $path_re ]] || die "ruta inválida en platform.conf: $p"
  done
  [[ $NGINX_RELOAD == systemctl || $NGINX_RELOAD == signal ]] || die "NGINX_RELOAD debe ser systemctl o signal"
  [[ $PORT_RANGE_START =~ ^[0-9]+$ && $PORT_RANGE_END =~ ^[0-9]+$ ]] || die "PORT_RANGE_START/END deben ser números"
  ((PORT_RANGE_START >= 1024 && PORT_RANGE_END <= 65535 && PORT_RANGE_START < PORT_RANGE_END)) || die "rango de puertos inválido"
  [[ $APP_CPUS =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "APP_CPUS inválido"
  [[ $APP_MEMORY =~ ^[0-9]+[kmg]$ ]] || die "APP_MEMORY inválido (p. ej. 512m)"
  [[ $DEPLOY_WAIT_SECONDS =~ ^[0-9]+$ ]] || die "DEPLOY_WAIT_SECONDS inválido"
  [[ $REGISTRY_HOST =~ ^[a-z0-9.-]+(:[0-9]+)?$ ]] || die "REGISTRY_HOST inválido"
  [[ -z $PANEL_ORIGIN || $PANEL_ORIGIN =~ ^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]+)?$ ]] ||
    die "PANEL_ORIGIN debe ser el origen https del panel, sin ruta (p. ej. https://launchpad.example.com)"
  # Solo loopback: nginx consulta a Launchpad en el mismo servidor.
  [[ $PANEL_UPSTREAM =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]] || die "PANEL_UPSTREAM debe ser http://127.0.0.1:<puerto>"
  [[ $PREVIEW_MONGO_IMAGE =~ ^[a-z0-9]([a-z0-9._/:-]*[a-z0-9])?$ ]] || die "PREVIEW_MONGO_IMAGE inválida"
}

client_host() { printf '%s.%s' "$1" "$APP_BASE_DOMAIN"; }
client_dir() { printf '%s/%s' "$CUSTOMER_APPS_DIR" "$1"; }
client_network() { printf 'app-%s' "$1"; }

# Vista previa del AI Developer. "preview-" está reservado para slugs, así que ni el host,
# ni la clave del registro de puertos, ni la config de nginx chocan con los de otro cliente.
preview_host() { printf 'preview-%s.%s' "$1" "$APP_BASE_DOMAIN"; }
preview_dir() { printf '%s/%s/preview' "$CUSTOMER_APPS_DIR" "$1"; }
preview_port_key() { printf 'preview-%s' "$1"; }

# ---- imagen y variables de entorno (contrato §5) --------------------------------

# Imagen del repo de ESE cliente, siempre por digest.
image_regex() {
  local registry=${REGISTRY_HOST//./\\.}
  printf '^%s/%s/%s-app@sha256:[a-f0-9]{64}$' "$registry" "$GHCR_ORG" "$1"
}

valid_image() {
  local re
  re=$(image_regex "$1")
  [[ $2 =~ $re ]]
}

# Lista cerrada del contrato del template (§5.1, 1.4.0). PORT, HOST, NODE_ENV y
# TRUST_PROXY_HOPS no se aceptan: los fija el compose generado.
readonly ALLOWED_ENV_KEYS=(
  MONGODB_URI MONGODB_DB SESSION_SECRET INITIAL_ADMIN_PASSWORD APP_DISPLAY_NAME MONDAY_API_TOKEN
)

env_key_allowed() {
  local key
  for key in "${ALLOWED_ENV_KEYS[@]}"; do
    [[ $1 == "$key" ]] && return 0
  done
  return 1
}

# ---- registro de puertos ----------------------------------------------------------

ports_file() { printf '%s/.ports' "$CUSTOMER_APPS_DIR"; }

port_of() {
  local file
  file=$(ports_file)
  [[ -f $file ]] || return 0
  awk -v s="$1" '$1 == s { print $2; exit }' "$file"
}

port_in_use() {
  command -v ss >/dev/null 2>&1 || return 1
  [[ -n $(ss -Hltn "sport = :$1" 2>/dev/null) ]]
}

# Puerto del cliente: el que ya tenga o el primero libre del rango. Todo bajo flock:
# dos instalaciones simultáneas nunca obtienen el mismo puerto.
assign_port() {
  local slug=$1 file lock port used
  file=$(ports_file)
  lock="$file.lock"
  touch "$file"
  exec {lock_fd}>"$lock"
  flock -w 60 "$lock_fd" || die "no se pudo bloquear el registro de puertos"
  port=$(awk -v s="$slug" '$1 == s { print $2; exit }' "$file")
  if [[ -z $port ]]; then
    used=" $(awk '{ print $2 }' "$file" | tr '\n' ' ') "
    for ((port = PORT_RANGE_START; port <= PORT_RANGE_END; port++)); do
      [[ $used == *" $port "* ]] && continue
      port_in_use "$port" && continue
      printf '%s %s\n' "$slug" "$port" >>"$file"
      break
    done
    ((port <= PORT_RANGE_END)) || die "no quedan puertos libres en $PORT_RANGE_START-$PORT_RANGE_END"
  fi
  flock -u "$lock_fd"
  exec {lock_fd}>&-
  printf '%s' "$port"
}

# ---- plantillas ---------------------------------------------------------------------

# render_template <archivo> CLAVE=valor... → sustituye @@CLAVE@@ por valor.
render_template() {
  local content pair key value
  content=$(<"$1")
  shift
  for pair in "$@"; do
    key=${pair%%=*}
    value=${pair#*=}
    content=${content//@@$key@@/$value}
  done
  [[ $content != *@@[A-Z_]*@@* ]] || die "plantilla con marcadores sin rellenar: $1"
  printf '%s\n' "$content"
}

# Línea de authorized_keys del usuario deploy para un cliente (contrato §5).
authorized_key_line() {
  local slug=$1 key=$2
  printf 'command="sudo %s/bin/deploy-client %s",restrict %s %s%s' "$PLATFORM_DIR" "$slug" "$key" "$KEY_MARKER_PREFIX" "$slug"
}

# Normaliza una clave pública ed25519 ("tipo base64 [comentario]") a "tipo base64".
normalize_pubkey() {
  local type b64 rest
  read -r type b64 rest <<<"$1"
  [[ $type == ssh-ed25519 && $b64 =~ ^AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}$ ]] || return 1
  printf '%s %s' "$type" "$b64"
}

# ---- nginx -----------------------------------------------------------------------------

nginx_reload() {
  if [[ $NGINX_RELOAD == signal ]]; then nginx -s reload; else systemctl reload nginx; fi
}

nginx_include_line() { printf 'include %s/*.conf;' "$NGINX_APPS_DIR"; }

nginx_include_active() {
  local dir=${NGINX_APPS_DIR//./\\.} dump
  # Entera antes de buscar: con pipefail, grep -q cortaría nginx -T (SIGPIPE) con muchos sitios.
  dump=$(nginx -T 2>/dev/null) || return 1
  grep -Eq "^[[:space:]]*include[[:space:]]+${dir}/\*\.conf;" <<<"$dump"
}

# Escribe la config de un cliente de forma segura: copia de la anterior, nginx -t
# y, si falla, restaura y sale con error sin recargar (los demás sitios no se tocan).
nginx_apply() {
  local target=$1 content=$2 backup="" tmp output
  exec {nginx_lock}>"$NGINX_APPS_DIR/.lock"
  flock -w 120 "$nginx_lock" || die "no se pudo bloquear la configuración de nginx"
  if [[ -e $target ]]; then
    backup=$(mktemp "$target.bak.XXXXXX")
    cp -p "$target" "$backup"
  fi
  tmp=$(mktemp "$NGINX_APPS_DIR/.tmp.XXXXXX")
  printf '%s\n' "$content" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$target"
  if ! output=$(nginx -t 2>&1); then
    if [[ -n $backup ]]; then mv -f "$backup" "$target"; else rm -f "$target"; fi
    printf '%s\n' "$output" >&2
    flock -u "$nginx_lock"
    local reason
    reason=$(grep -m1 -E '\[(emerg|crit|alert)\]' <<<"$output" | sed -E 's/^nginx: //' || true)
    die "nginx -t falló con la nueva configuración de $(basename "$target"); se restauró la anterior${reason:+ ($reason)}"
  fi
  [[ -z $backup ]] || rm -f "$backup"
  nginx_reload
  flock -u "$nginx_lock"
}
