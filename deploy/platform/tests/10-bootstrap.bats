#!/usr/bin/env bats
# bootstrap-vps.sh: idempotente, conservador y solo con rutas propias.
load helpers

@test "sin --wire-nginx no modifica nginx.conf e imprime la línea a añadir" {
  before=$(sha256sum /etc/nginx/nginx.conf)
  run "$SRC/bin/bootstrap-vps.sh"
  [ "$status" -eq 0 ]
  [[ $output == *"include /etc/nginx/platform-apps/*.conf;"* ]]
  [[ $output == *"AVISO: /opt/platform/etc/platform.conf está incompleto"* ]]
  [ "$(sha256sum /etc/nginx/nginx.conf)" = "$before" ]
}

@test "instala los scripts como root:root 755 y crea rutas propias y registro de puertos" {
  for f in bootstrap-vps.sh install-client deploy-client client-status provisioner-dispatch uninstall-client preview-install preview-stop server-info; do
    [ "$(stat -c '%U:%G %a' "/opt/platform/bin/$f")" = "root:root 755" ]
  done
  [ "$(stat -c '%U %a' /opt/platform/lib/common.sh)" = "root 644" ]
  [ -d /etc/nginx/platform-apps ] && [ -d /var/www/certbot ]
  [ "$(stat -c '%a' /srv/customer-apps)" = "711" ]
  [ "$(stat -c '%U %a' /srv/customer-apps/.ports)" = "root 600" ]
}

@test "usuarios deploy y provisioner: shell /bin/sh y sin contraseña utilizable" {
  for user in deploy provisioner; do
    [ "$(getent passwd "$user" | cut -d: -f7)" = "/bin/sh" ]
    [ "$(getent shadow "$user" | cut -d: -f2)" = "*" ]
    home=$(getent passwd "$user" | cut -d: -f6)
    [ "$(stat -c '%U %a' "$home/.ssh")" = "$user 700" ]
  done
}

@test "sudoers válido y limitado a los scripts de /opt/platform/bin" {
  visudo -cf /etc/sudoers.d/platform-apps
  [ "$(stat -c '%a' /etc/sudoers.d/platform-apps)" = "440" ]
  grep -qx 'deploy ALL=(root) NOPASSWD: /opt/platform/bin/deploy-client' /etc/sudoers.d/platform-apps
  grep -qx 'provisioner ALL=(root) NOPASSWD: /opt/platform/bin/install-client, /opt/platform/bin/client-status, /opt/platform/bin/uninstall-client, /opt/platform/bin/preview-install, /opt/platform/bin/preview-stop, /opt/platform/bin/server-info' /etc/sudoers.d/platform-apps
  [ "$(grep -c NOPASSWD /etc/sudoers.d/platform-apps)" -eq 2 ]
}

@test "hook de renovación de certbot que recarga nginx" {
  hook=/etc/letsencrypt/renewal-hooks/deploy/platform-reload-nginx
  [ -x "$hook" ]
  grep -q 'nginx -t &&' "$hook"
}

@test "install-client falla con un mensaje claro si falta el include" {
  write_test_config
  run /opt/platform/bin/install-client acme <<<"$(new_pubkey)"
  [ "$status" -ne 0 ]
  [[ $output == *"nginx no incluye /etc/nginx/platform-apps"* ]]
  [[ $output == *"include /etc/nginx/platform-apps/*.conf;"* ]]
}

@test "--wire-nginx restaura nginx.conf si nginx -t falla" {
  before=$(sha256sum /etc/nginx/nginx.conf)
  printf 'esto rompe nginx\n' >/etc/nginx/platform-apps/roto.conf
  run "$SRC/bin/bootstrap-vps.sh" --wire-nginx
  [ "$status" -ne 0 ]
  [[ $output == *"se restauró"* ]]
  [ "$(sha256sum /etc/nginx/nginx.conf)" = "$before" ]
  rm -f /etc/nginx/platform-apps/roto.conf
  nginx -t
}

@test "--wire-nginx añade UNA línea include dentro de http y es idempotente" {
  run "$SRC/bin/bootstrap-vps.sh" --wire-nginx
  [ "$status" -eq 0 ]
  run "$SRC/bin/bootstrap-vps.sh" --wire-nginx
  [ "$status" -eq 0 ]
  [[ $output == *"nginx ya incluye /etc/nginx/platform-apps"* ]]
  [ "$(grep -c 'include /etc/nginx/platform-apps/\*\.conf;' /etc/nginx/nginx.conf)" -eq 1 ]
  ls /etc/nginx/nginx.conf.platform-bak.* >/dev/null
  # La línea está dentro del bloque http.
  awk '/^[[:space:]]*http[[:space:]]*\{/ { h = 1 } h && /platform-apps/ { found = 1 } END { exit !found }' /etc/nginx/nginx.conf
  nginx -t
}

@test "sube server_names_hash_bucket_size para hosts largos (preview-<slug>.<dominio>)" {
  conf=/etc/nginx/platform-apps/_platform-http.conf
  grep -qx 'server_names_hash_bucket_size 128;' "$conf"
  # Un host de 100 caracteres no cabe con el valor por defecto de x86 (64).
  host="preview-$(printf 'a%.0s' {1..74}).apps.whatever.tech"
  printf 'server { listen 8089; server_name %s; return 200; }\n' "$host" >/etc/nginx/platform-apps/largo.conf
  nginx -t
  # Idempotente: reejecutar no lo duplica.
  "$SRC/bin/bootstrap-vps.sh" >/dev/null
  [ "$(grep -rc server_names_hash_bucket_size /etc/nginx/platform-apps/ | awk -F: '{ s += $2 } END { print s }')" -eq 1 ]
  nginx -t
  rm -f /etc/nginx/platform-apps/largo.conf
}

@test "no repite server_names_hash_bucket_size si nginx.conf ya lo define" {
  cp -p /etc/nginx/nginx.conf /tmp/nginx.conf.orig
  rm -f /etc/nginx/platform-apps/_platform-http.conf
  awk '!done && /^[[:space:]]*http[[:space:]]*\{/ { print; print "\tserver_names_hash_bucket_size 256;"; done = 1; next } { print }' \
    /tmp/nginx.conf.orig >/etc/nginx/nginx.conf
  grep -q 'server_names_hash_bucket_size 256;' /etc/nginx/nginx.conf
  run "$SRC/bin/bootstrap-vps.sh"
  [ "$status" -eq 0 ]
  [[ $output == *"ya define server_names_hash_bucket_size"* ]]
  [ ! -e /etc/nginx/platform-apps/_platform-http.conf ]
  nginx -t
  cp -p /tmp/nginx.conf.orig /etc/nginx/nginx.conf
  "$SRC/bin/bootstrap-vps.sh" >/dev/null
  [ -f /etc/nginx/platform-apps/_platform-http.conf ]
}

@test "clave del orquestador con comando forzado; reejecutar la reemplaza sin duplicar" {
  key_dir=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N "" -f "$key_dir/prov"
  "$SRC/bin/bootstrap-vps.sh" --provisioner-pubkey "$key_dir/prov.pub" >/dev/null
  ssh-keygen -q -t ed25519 -N "" -f "$key_dir/prov2"
  "$SRC/bin/bootstrap-vps.sh" --provisioner-pubkey "$key_dir/prov2.pub" >/dev/null
  keys=/home/provisioner/.ssh/authorized_keys
  [ "$(grep -c platform-provisioner "$keys")" -eq 1 ]
  grep -q "^command=\"/opt/platform/bin/provisioner-dispatch\",restrict $(cut -d' ' -f1-2 "$key_dir/prov2.pub") platform-provisioner$" "$keys"
  [ "$(stat -c '%U %a' "$keys")" = "provisioner 600" ]
}
