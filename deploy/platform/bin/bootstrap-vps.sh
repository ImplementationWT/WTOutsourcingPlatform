#!/usr/bin/env bash
# bootstrap-vps.sh [--wire-nginx] [--provisioner-pubkey <archivo.pub>]
#
# Preparación del VPS compartido para las apps de clientes. Idempotente y
# conservador: no instala ni reconfigura Docker, nginx, certbot, firewall ni sshd;
# solo crea lo propio de la plataforma:
#   - usuarios deploy y provisioner (shell /bin/sh, sin contraseña utilizable)
#   - /opt/platform (scripts, propiedad de root), /srv/customer-apps,
#     /etc/nginx/platform-apps y /var/www/certbot
#   - registro de puertos /srv/customer-apps/.ports
#   - sudoers limitado a los scripts de /opt/platform/bin
#   - hook de renovación de certbot que recarga nginx (si no hay ninguno)
# nginx.conf solo se modifica con --wire-nginx (copia de seguridad + nginx -t).
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../lib/common.sh
source "$src/lib/common.sh"

wire_nginx=false
provisioner_pubkey=""
while (($#)); do
  case $1 in
    --wire-nginx) wire_nginx=true ;;
    --provisioner-pubkey)
      [[ $# -ge 2 ]] || die "--provisioner-pubkey necesita un archivo"
      provisioner_pubkey=$2
      shift
      ;;
    -h | --help)
      sed -n '2,14p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "opción desconocida: $1" ;;
  esac
  shift
done

[[ $(id -u) -eq 0 ]] || die "ejecútalo como root (sudo)"
info() { printf '==> %s\n' "$*"; }

# ---- 1. requisitos (se informan; no se instalan) ------------------------------------
missing=()
for cmd in docker nginx certbot jq flock openssl visudo useradd usermod; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
docker compose version >/dev/null 2>&1 || missing+=("docker compose (plugin v2)")
if ((${#missing[@]})); then
  printf 'Faltan requisitos: %s\n' "${missing[*]}" >&2
  printf 'Instálalos tú (este script no instala ni reconfigura nada del sistema) y vuelve a ejecutarlo.\n' >&2
  exit 1
fi
info "Docker, nginx y certbot detectados."

# ---- 2. scripts en /opt/platform ------------------------------------------------------
install -d -m 755 -o root -g root "$PLATFORM_DIR" "$PLATFORM_DIR/bin" "$PLATFORM_DIR/lib" "$PLATFORM_DIR/templates" "$PLATFORM_DIR/etc"
for file in "$src"/bin/*; do install -m 755 -o root -g root "$file" "$PLATFORM_DIR/bin/"; done
install -m 644 -o root -g root "$src/lib/common.sh" "$PLATFORM_DIR/lib/common.sh"
for file in "$src"/templates/*; do install -m 644 -o root -g root "$file" "$PLATFORM_DIR/templates/"; done
install -m 644 -o root -g root "$src/etc/platform.conf.example" "$PLATFORM_DIR/etc/platform.conf.example"
if [[ ! -f $PLATFORM_CONF ]]; then
  install -m 644 -o root -g root "$src/etc/platform.conf.example" "$PLATFORM_CONF"
  info "Creado $PLATFORM_CONF: complétalo (GHCR_ORG, APP_BASE_DOMAIN, ACME_EMAIL)."
fi
info "Scripts instalados en $PLATFORM_DIR/bin (root:root, 755)."

# Rutas: las de platform.conf si ya está completo; si no, las de por defecto.
if (load_config) >/dev/null 2>&1; then
  load_config
  config_complete=true
else
  config_defaults
  config_complete=false
fi

# ---- 3. usuarios ----------------------------------------------------------------------
# /bin/sh porque sshd ejecuta el comando forzado a través de la shell del usuario;
# "*" como contraseña: no hay login por contraseña. Sin PTY: lo impide "restrict".
ensure_user() {
  id "$1" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$1"
  usermod --shell /bin/sh --password '*' "$1"
  local home
  home=$(getent passwd "$1" | cut -d: -f6)
  install -d -m 700 -o "$1" -g "$1" "$home/.ssh"
  [[ -f "$home/.ssh/authorized_keys" ]] || install -m 600 -o "$1" -g "$1" /dev/null "$home/.ssh/authorized_keys"
}
ensure_user deploy
ensure_user provisioner
info "Usuarios deploy y provisioner listos (sin contraseña, shell /bin/sh)."

# ---- 4. directorios propios y registro de puertos --------------------------------------
install -d -m 755 -o root -g root "$NGINX_APPS_DIR" "$CERTBOT_WEBROOT"
install -d -m 711 -o root -g root "$CUSTOMER_APPS_DIR"
ports=$(ports_file)
exec {ports_lock}>"$ports.lock"
flock -w 60 "$ports_lock"
[[ -f $ports ]] || install -m 600 -o root -g root /dev/null "$ports"
flock -u "$ports_lock"
info "Directorios: $CUSTOMER_APPS_DIR, $NGINX_APPS_DIR, $CERTBOT_WEBROOT. Registro de puertos: $ports."

# ---- 5. sudoers --------------------------------------------------------------------------
sudoers_tmp=$(mktemp)
cat >"$sudoers_tmp" <<EOF
# Generado por bootstrap-vps.sh: solo los scripts de la plataforma.
deploy ALL=(root) NOPASSWD: $PLATFORM_DIR/bin/deploy-client
provisioner ALL=(root) NOPASSWD: $PLATFORM_DIR/bin/install-client, $PLATFORM_DIR/bin/client-status, $PLATFORM_DIR/bin/uninstall-client, $PLATFORM_DIR/bin/preview-install, $PLATFORM_DIR/bin/preview-stop
EOF
visudo -cf "$sudoers_tmp" >/dev/null || {
  rm -f "$sudoers_tmp"
  die "sudoers generado inválido"
}
install -m 440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/platform-apps
rm -f "$sudoers_tmp"
info "sudoers: /etc/sudoers.d/platform-apps."

# ---- 6. clave del orquestador (provisioner) -----------------------------------------------
if [[ -n $provisioner_pubkey ]]; then
  key=$(normalize_pubkey "$(head -c 1024 "$provisioner_pubkey")") || die "$provisioner_pubkey no es una clave pública ssh-ed25519"
  home=$(getent passwd provisioner | cut -d: -f6)
  tmp=$(mktemp "$home/.ssh/.authorized_keys.XXXXXX")
  awk '$NF != "platform-provisioner"' "$home/.ssh/authorized_keys" >"$tmp"
  printf 'command="%s/bin/provisioner-dispatch",restrict %s platform-provisioner\n' "$PLATFORM_DIR" "$key" >>"$tmp"
  chown provisioner:provisioner "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$home/.ssh/authorized_keys"
  info "Clave del orquestador instalada para provisioner (comando forzado provisioner-dispatch)."
fi

# ---- 7. include de nginx ---------------------------------------------------------------------
include_line=$(nginx_include_line)
if nginx_include_active; then
  info "nginx ya incluye $NGINX_APPS_DIR."
elif [[ $wire_nginx == true ]]; then
  backup="$NGINX_CONF.platform-bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$NGINX_CONF" "$backup"
  tmp=$(mktemp)
  awk -v line="$include_line" '
    !done && /^[[:space:]]*http[[:space:]]*\{/ { print; print "\t" line; done = 1; next }
    { print }
    END { if (!done) exit 1 }
  ' "$NGINX_CONF" >"$tmp" || {
    rm -f "$tmp"
    die "no se encontró el bloque http en $NGINX_CONF; no se modificó"
  }
  cat "$tmp" >"$NGINX_CONF"
  rm -f "$tmp"
  if ! nginx -t >/dev/null 2>&1; then
    cp -p "$backup" "$NGINX_CONF"
    die "nginx -t falló tras añadir el include; se restauró $NGINX_CONF desde $backup"
  fi
  nginx_reload
  info "Añadida a $NGINX_CONF la línea: $include_line (copia: $backup)."
else
  printf '\nFALTA el include de nginx. Añade dentro del bloque http { … } de %s:\n\n    %s\n\n' "$NGINX_CONF" "$include_line"
  printf 'y ejecuta: nginx -t && systemctl reload nginx\n(o vuelve a ejecutar este script con --wire-nginx).\n\n'
fi

# ---- 7b. nombres de host largos -------------------------------------------------------------------
# Con el valor por defecto en x86 (64), nginx -t rechaza hosts de más de ~46 caracteres
# (preview-<slug>.<dominio> llega enseguida). Se sube en un archivo propio del directorio
# incluido, salvo que la configuración ya lo defina (repetirlo invalidaría nginx).
http_conf="$NGINX_APPS_DIR/_platform-http.conf"
# Se lee entera antes de buscar: con pipefail, grep -q cortaría nginx -T (SIGPIPE) y daría falso.
nginx_dump=$(nginx -T 2>/dev/null || true)
if [[ ! -f $http_conf ]] && grep -Eq '^[^#]*server_names_hash_bucket_size' <<<"$nginx_dump"; then
  info "nginx ya define server_names_hash_bucket_size; asegúrate de que sea >= 128 para los hosts de vista previa."
else
  printf '# Generado por bootstrap-vps.sh: hosts largos (preview-<slug>.<dominio>).\nserver_names_hash_bucket_size 128;\n' >"$http_conf"
  chmod 644 "$http_conf"
  if ! nginx -t >/dev/null 2>&1; then
    rm -f "$http_conf"
    info "AVISO: nginx -t rechazó $http_conf; no se aplicó. Sube server_names_hash_bucket_size a 128 en el bloque http de $NGINX_CONF."
  elif nginx_include_active; then
    nginx_reload
    info "nginx: server_names_hash_bucket_size 128 ($http_conf)."
  fi
fi

# ---- 8. hook de renovación de certbot ------------------------------------------------------------
hooks=/etc/letsencrypt/renewal-hooks/deploy
install -d -m 755 "$hooks"
if grep -Eqs 'systemctl (reload|restart) nginx|nginx -s reload|service nginx (reload|restart)' "$hooks"/* 2>/dev/null; then
  info "Ya hay un hook de renovación que recarga nginx en $hooks."
else
  if [[ $NGINX_RELOAD == signal ]]; then reload_cmd='nginx -s reload'; else reload_cmd='systemctl reload nginx'; fi
  printf '#!/bin/sh\n# Generado por bootstrap-vps.sh: recarga nginx tras renovar un certificado.\nnginx -t && %s\n' "$reload_cmd" >"$hooks/platform-reload-nginx"
  chmod 755 "$hooks/platform-reload-nginx"
  info "Creado $hooks/platform-reload-nginx."
fi

# ---- 9. recomendaciones (no se aplican) -------------------------------------------------------------
cat <<'EOF'

Recomendaciones (este script NO las aplica):
  - Firewall: permitir solo 22, 80 y 443 desde fuera; los puertos 20000-29999 escuchan solo en 127.0.0.1.
  - sshd: PasswordAuthentication no y PermitRootLogin prohibit-password.
  - Actualizaciones de seguridad automáticas (unattended-upgrades) activas.
  - Verificar la renovación: certbot renew --dry-run
EOF
[[ $config_complete == true ]] || printf '\nAVISO: %s está incompleto; install-client y deploy-client no funcionarán hasta completarlo.\n' "$PLATFORM_CONF"
