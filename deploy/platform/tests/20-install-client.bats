#!/usr/bin/env bats
# install-client: carpeta, puerto, red, certificado, nginx y clave; idempotente.
load helpers

setup() { write_test_config; }

calls() { grep -c -- "-d $1" /var/log/certbot-stub.calls 2>/dev/null || true; }

@test "rechaza slugs inválidos y claves que no son ed25519" {
  for bad in Acme acme_crm "acme;id" ../etc "-x" ""; do
    run /opt/platform/bin/install-client "$bad" <<<"$(new_pubkey)"
    [ "$status" -ne 0 ]
    [[ $output == *"slug inválido"* ]]
  done
  run /opt/platform/bin/install-client acme <<<"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test"
  [ "$status" -ne 0 ]
  [[ $output == *"ssh-ed25519"* ]]
  [ ! -e /srv/customer-apps/acme ]
}

@test "instala un cliente: puerto, carpeta, red, certificado, nginx y clave" {
  key=$(new_pubkey)
  run /opt/platform/bin/install-client acme <<<"$key"
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -r .status <<<"$result")" = ok ]
  [ "$(jq -r .host <<<"$result")" = acme.apps.test ]
  [ "$(jq -r .certificate <<<"$result")" = issued ]
  port=$(jq -r .port <<<"$result")
  ((port >= 20000 && port <= 20050))
  grep -qx "acme $port" /srv/customer-apps/.ports

  [ "$(stat -c '%U %a' /srv/customer-apps/acme)" = "root 700" ]
  docker network inspect app-acme >/dev/null

  [ "$(calls acme.apps.test)" -eq 1 ]
  grep -- "-d acme.apps.test" /var/log/certbot-stub.calls | grep -q -- "certonly --webroot -w /var/www/certbot -d acme.apps.test --non-interactive --agree-tos -m ops@example.test"
  ! grep -- "-d acme.apps.test" /var/log/certbot-stub.calls | grep -q -- "--server"

  conf=/etc/nginx/platform-apps/acme.conf
  [[ "$(cat "$conf")" == *"$(contract_nginx_block "$port")"* ]]
  grep -q 'ssl_certificate     /etc/letsencrypt/live/acme.apps.test/fullchain.pem;' "$conf"
  nginx -T 2>/dev/null | grep -q "server_name acme.apps.test;"

  keys=/home/deploy/.ssh/authorized_keys
  grep -qx "command=\"sudo /opt/platform/bin/deploy-client acme\",restrict $(cut -d' ' -f1-2 <<<"$key") platform-client:acme" "$keys"
  [ "$(stat -c '%U %a' "$keys")" = "deploy 600" ]
}

@test "el desafío ACME se sirve desde el webroot" {
  mkdir -p /var/www/certbot/.well-known/acme-challenge
  echo token-ok >/var/www/certbot/.well-known/acme-challenge/t1
  [ "$(curl -s -H 'Host: acme.apps.test' http://127.0.0.1/.well-known/acme-challenge/t1)" = token-ok ]
  # La recarga de nginx es asíncrona: se espera a que los workers nuevos respondan.
  for _ in $(seq 1 20); do
    run curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: acme.apps.test' http://127.0.0.1/otra
    [ "$output" = "301 https://acme.apps.test/otra" ] && break
    sleep 0.25
  done
  [ "$output" = "301 https://acme.apps.test/otra" ]
}

@test "reintentar no reemite el certificado ni duplica puerto, clave ni archivos" {
  port=$(awk '$1 == "acme" { print $2 }' /srv/customer-apps/.ports)
  conf_before=$(sha256sum /etc/nginx/platform-apps/acme.conf)
  key=$(new_pubkey)
  run /opt/platform/bin/install-client acme <<<"$key"
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -r .certificate <<<"$result")" = existing ]
  [ "$(jq -r .port <<<"$result")" = "$port" ]
  [ "$(calls acme.apps.test)" -eq 1 ]
  [ "$(grep -c '^acme ' /srv/customer-apps/.ports)" -eq 1 ]
  [ "$(grep -c 'platform-client:acme$' /home/deploy/.ssh/authorized_keys)" -eq 1 ]
  grep -q "$(cut -d' ' -f2 <<<"$key")" /home/deploy/.ssh/authorized_keys
  [ "$(sha256sum /etc/nginx/platform-apps/acme.conf)" = "$conf_before" ]
  [ "$(ls /etc/nginx/platform-apps | grep -c '^acme')" -eq 1 ]
  [ "$(docker network ls --filter name='^app-acme$' -q | wc -l)" -eq 1 ]
}

@test "con stdin vacío conserva la clave instalada; sin clave instalada, falla con un mensaje claro" {
  before=$(grep 'platform-client:acme$' /home/deploy/.ssh/authorized_keys)
  run /opt/platform/bin/install-client acme </dev/null
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .key)" = kept ]
  [ "$(grep 'platform-client:acme$' /home/deploy/.ssh/authorized_keys)" = "$before" ]
  calls_before=$(wc -l </var/log/certbot-stub.calls)
  run /opt/platform/bin/install-client sinclave </dev/null
  [ "$status" -ne 0 ]
  [[ $output == *"no hay ninguna clave instalada para sinclave"* ]]
  # Falla antes de emitir certificados o reservar puerto.
  [ "$(wc -l </var/log/certbot-stub.calls)" -eq "$calls_before" ]
  ! grep -q '^sinclave ' /srv/customer-apps/.ports
}

@test "ACME_CA configurable (staging) se pasa a certbot con --server" {
  write_test_config "ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory"
  run /opt/platform/bin/install-client gamma <<<"$(new_pubkey)"
  [ "$status" -eq 0 ]
  grep -- "-d gamma.apps.test" /var/log/certbot-stub.calls | grep -q -- "--server https://acme-staging-v02.api.letsencrypt.org/directory"
}

@test "si la config nueva no pasa nginx -t, se elimina o restaura y los demás sitios siguen" {
  printf 'server { listen 18082; return 200 "vecino\\n"; }\n' >/etc/nginx/http.d/vecino.conf
  nginx -s reload
  sleep 1
  # Certificado incompleto (sin clave privada): la config final no pasaría nginx -t.
  mkdir -p /etc/letsencrypt/live/epsilon.apps.test
  cp /etc/letsencrypt/live/acme.apps.test/fullchain.pem /etc/letsencrypt/live/epsilon.apps.test/
  acme_before=$(sha256sum /etc/nginx/platform-apps/acme.conf)
  run /opt/platform/bin/install-client epsilon <<<"$(new_pubkey)"
  [ "$status" -ne 0 ]
  [[ $output == *"nginx -t falló con la nueva configuración de epsilon.conf"* ]]
  [ ! -e /etc/nginx/platform-apps/epsilon.conf ]
  [ "$(sha256sum /etc/nginx/platform-apps/acme.conf)" = "$acme_before" ]
  nginx -t
  [ "$(curl -s http://127.0.0.1:18082/)" = vecino ]
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: acme.apps.test' http://127.0.0.1/.well-known/acme-challenge/t1)" = 200 ]
  [ -z "$(ls -A /etc/nginx/platform-apps/ | grep -E '\.bak\.|\.tmp\.' || true)" ]
}

@test "si la config actual de nginx está rota, lo dice en vez de culpar al include" {
  printf 'roto\n' >/etc/nginx/http.d/roto.conf
  run /opt/platform/bin/install-client acme <<<"$(new_pubkey)"
  rm -f /etc/nginx/http.d/roto.conf
  [ "$status" -ne 0 ]
  [[ $output == *"la configuración actual de nginx no es válida"* ]]
}

@test "si certbot falla, el error es claro" {
  touch /tmp/certbot-fail
  run /opt/platform/bin/install-client delta <<<"$(new_pubkey)"
  rm -f /tmp/certbot-fail
  [ "$status" -ne 0 ]
  [[ $output == *"certbot no pudo emitir el certificado de delta.apps.test"* ]]
}
