#!/usr/bin/env bats
# uninstall-client: retira todo lo del cliente sin tocar a los demás; idempotente.
load helpers

setup() { write_test_config; }

@test "retira contenedor, imágenes, red, nginx, certificado, clave, puerto y carpeta" {
  [ -d /srv/customer-apps/beta ]
  run /opt/platform/bin/uninstall-client beta
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -c .removed <<<"$result")" = '{"container":true,"images":1,"network":true,"nginx":true,"certificate":true,"key":true,"port":true,"files":true,"preview":false}' ]

  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=app-beta)" ]
  ! docker network inspect app-beta >/dev/null 2>&1
  [ ! -e /etc/nginx/platform-apps/beta.conf ]
  [ ! -d /etc/letsencrypt/live/beta.apps.test ]
  ! grep -q 'platform-client:beta$' /home/deploy/.ssh/authorized_keys
  ! grep -q '^beta ' /srv/customer-apps/.ports
  [ ! -e /srv/customer-apps/beta ]
  nginx -T 2>/dev/null | grep -vq "server_name beta.apps.test;"
}

@test "los demás clientes siguen funcionando" {
  nginx -t
  [ "$(curl -sk -o /dev/null -w '%{http_code}' --resolve acme.apps.test:443:127.0.0.1 https://acme.apps.test/health)" = 200 ]
  grep -q 'platform-client:acme$' /home/deploy/.ssh/authorized_keys
  grep -q '^acme ' /srv/customer-apps/.ports
}

@test "repetirlo no falla y no toca nada más" {
  run /opt/platform/bin/uninstall-client beta
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -c .removed)" = '{"container":false,"images":0,"network":false,"nginx":false,"certificate":false,"key":false,"port":false,"files":false,"preview":false}' ]
}

@test "el puerto liberado se puede reasignar a otro cliente" {
  run /opt/platform/bin/install-client nuevo <<<"$(new_pubkey)"
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .certificate)" = issued ]
}

@test "rechaza slugs inválidos" {
  for bad in "../etc" "acme;id" "" "Acme"; do
    run /opt/platform/bin/uninstall-client "$bad"
    [ "$status" -ne 0 ]
  done
}

@test "el provisioner puede pedirlo por el dispatch" {
  run env SSH_ORIGINAL_COMMAND="uninstall-client nuevo" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' </dev/null
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .removed.nginx)" = true ]
}
