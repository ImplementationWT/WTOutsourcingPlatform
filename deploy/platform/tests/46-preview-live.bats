#!/usr/bin/env bats
# Vista previa en vivo (contrato §5.3): preview-live-start clona la rama sin root y arranca
# pnpm dev:preview; preview-live-update trae cada commit y se ve sin reiniciar nada.
load helpers

BRANCH=ai/20261020-abcdef12
TOKEN=ghs_tokenDePruebaSoloLectura0123456789
GIT=/srv/test-git/testorg/acme-app.git

setup() { write_test_config; }

# El repo "remoto" de las pruebas es una carpeta local: git exige que sea del mismo usuario que
# lo clona (uid 1000). En producción se clona por https y esto no aplica.
g() {
  mkdir -p /tmp/git-home && chown 1000:1000 /tmp/git-home
  setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/tmp/git-home GIT_CONFIG_NOSYSTEM=1 git "$@"
}
new_dir() { rm -rf "$1" && mkdir -p "$1" && chown 1000:1000 "$1"; }

# Repo "remoto" con la rama de trabajo: package.json con dev:preview, lockfile y un mensaje.
make_repo() { # [sin-dev-preview]
  mkdir -p /srv/test-git/testorg && chmod 755 /srv/test-git /srv/test-git/testorg && chown 1000:1000 /srv/test-git/testorg
  new_dir "$GIT"
  new_dir /tmp/acme-work
  g init -q --bare "$GIT"
  g init -q -b "$BRANCH" /tmp/acme-work
  if [[ ${1:-} == sin-dev-preview ]]; then
    printf '{"scripts":{"dev":"tsx watch src/index.ts"}}\n' >/tmp/acme-work/package.json
  else
    printf '{"scripts":{"dev:preview":"node scripts/dev-preview.mjs"}}\n' >/tmp/acme-work/package.json
  fi
  printf 'lockfileVersion: 9\n' >/tmp/acme-work/pnpm-lock.yaml
  printf 'version 1\n' >/tmp/acme-work/message.txt
  # Como en la plantilla: node_modules se ignora (y git clean lo conserva al actualizar).
  printf 'node_modules\n' >/tmp/acme-work/.gitignore
  commit "Primera versión"
  g -C /tmp/acme-work push -q "$GIT" "$BRANCH"
}

commit() {
  g -C /tmp/acme-work add -A
  g -C /tmp/acme-work -c user.name=Claude -c user.email=ai@test commit -q -m "$1"
}

push() { g -C /tmp/acme-work push -q "$GIT" "$BRANCH"; }

start_payload() { jq -cn --arg b "${1:-$BRANCH}" --arg t "$TOKEN" '{repository: "testorg/acme-app", branch: $b, token: $t}'; }
update_payload() { jq -cn --arg b "$BRANCH" --arg t "$TOKEN" '{branch: $b, token: $t}'; }

# Por nginx con la cookie que deja el pase de Launchpad (fake-panel).
live() { # <ruta>
  curl -sk --resolve preview-acme.apps.test:443:127.0.0.1 -H 'Cookie: lp_preview=cookie-buena' "https://preview-acme.apps.test$1"
}

@test "preview-live-start: clona la rama sin root, instala y arranca pnpm dev:preview detrás de nginx" {
  make_repo
  run /opt/platform/bin/preview-live-start acme <<<"$(start_payload)"
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -r .status <<<"$result")" = ok ]
  [ "$(jq -r .sha <<<"$result")" = "$(g -C /tmp/acme-work rev-parse HEAD)" ]

  # El clon es del uid 1000 y vive fuera de la carpeta del cliente.
  live_dir=/srv/customer-apps/.preview-live/acme
  [ "$(stat -c '%u %a' "$live_dir")" = "1000 755" ]
  [ "$(stat -c '%a' /srv/customer-apps/.preview-live)" = 711 ]
  [ "$(stat -c '%u' "$live_dir/message.txt")" = 1000 ]

  live / | grep -q "version 1"
  state=$(live /state)
  [ "$(jq -r .installs <<<"$state")" = 1 ]
  [ "$(jq -r .NODE_ENV <<<"$state")" = development ]
  [ "$(jq -r .FORCE_ADMIN_PASSWORD_CHANGE <<<"$state")" = false ]
  [ "$(jq -r .MONGODB_DB <<<"$state")" = client_acme_preview ]
  [ "$(jq -r .mongoHost <<<"$state")" = mongo:27017 ]
  [ "$(jq -r .uid <<<"$state")" = 1000 ]
}

@test "el token no queda en el clon, en el compose, en el .env ni en el estado" {
  ! grep -rqs "$TOKEN" /srv/customer-apps/.preview-live/acme/.git
  ! grep -qs "$TOKEN" /srv/customer-apps/acme/preview/compose.yaml /srv/customer-apps/acme/preview/.env /srv/customer-apps/acme/preview/state.json
  ! grep -qs 'tokenDePrueba' /srv/customer-apps/.preview-live/acme/.git/config
}

@test "el contenedor está endurecido y sin acceso a producción" {
  container=$(docker compose -p preview-acme ps -q app)
  [ "$(docker inspect --format '{{.Config.User}}' "$container")" = node ]
  [ "$(docker inspect --format '{{.HostConfig.CapDrop}}' "$container")" = "[ALL]" ]
  docker inspect --format '{{.HostConfig.SecurityOpt}}' "$container" | grep -q no-new-privileges
  [ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" = 512 ]
  # Solo en loopback.
  docker port "$container" 5173 | grep -q '^127.0.0.1:'
  # Ni la red ni el .env de producción.
  ! docker inspect --format '{{json .NetworkSettings.Networks}}' "$container" | grep -q 'app-acme'
  ! docker exec "$container" env | grep -q 's3cr3t\|session-secret-0123'
}

@test "preview-live-update trae el commit y se ve sin reiniciar; reinstala solo si cambia el lockfile" {
  container=$(docker compose -p preview-acme ps -q app)
  printf 'version 2\n' >/tmp/acme-work/message.txt
  commit "Cambia el mensaje"
  push
  run /opt/platform/bin/preview-live-update acme <<<"$(update_payload)"
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -r .sha <<<"$result")" = "$(g -C /tmp/acme-work rev-parse HEAD)" ]
  [ "$(jq -r .reinstalled <<<"$result")" = false ]
  live / | grep -q "version 2"
  # El mismo contenedor (no se reconstruye) y sin reinstalar.
  [ "$(docker compose -p preview-acme ps -q app)" = "$container" ]
  [ "$(live /state | jq -r .installs)" = 1 ]

  printf 'lockfileVersion: 9\npackages: {}\n' >/tmp/acme-work/pnpm-lock.yaml
  commit "Nueva dependencia"
  push
  run /opt/platform/bin/preview-live-update acme <<<"$(update_payload)"
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .reinstalled)" = true ]
  [ "$(live /state | jq -r .installs)" = 2 ]
}

@test "rechaza repos de otro cliente, ramas que no son de trabajo, tokens raros y vistas sin preparar" {
  for payload in \
    "$(jq -cn --arg t "$TOKEN" '{repository: "testorg/beta-app", branch: "ai/20261020-abcdef12", token: $t}')" \
    "$(jq -cn --arg t "$TOKEN" '{repository: "testorg/acme-app", branch: "main", token: $t}')" \
    "$(jq -cn --arg t "$TOKEN" '{repository: "testorg/acme-app", branch: "ai/20261020-abcdef12; id", token: $t}')" \
    '{"repository":"testorg/acme-app","branch":"ai/20261020-abcdef12","token":"$(id)"}' \
    'no es json'; do
    run /opt/platform/bin/preview-live-start acme <<<"$payload"
    [ "$status" -ne 0 ]
  done
  run /opt/platform/bin/preview-live-start beta <<<"$(start_payload)"
  [ "$status" -ne 0 ]
  [[ $output == *"no está preparada"* ]]
  # La vista que estaba en marcha sigue intacta.
  live / | grep -q "version 2"
}

@test "un repo sin pnpm dev:preview se rechaza con un mensaje claro" {
  make_repo sin-dev-preview
  run /opt/platform/bin/preview-live-start acme <<<"$(start_payload)"
  [ "$status" -ne 0 ]
  [[ $output == *"no tiene pnpm dev:preview"* ]]
  [[ $output == *"1.6.0"* ]]
}

@test "por el dispatch del provisioner, y preview-stop retira el clon pero conserva la caché" {
  make_repo
  run env SSH_ORIGINAL_COMMAND="preview-live-start acme" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' <<<"$(start_payload)"
  [ "$status" -eq 0 ]
  live / | grep -q "version 1"
  run env SSH_ORIGINAL_COMMAND="preview-live-update acme" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' <<<"$(update_payload)"
  [ "$status" -eq 0 ]

  run /opt/platform/bin/preview-stop acme
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .stopped)" = true ]
  [ ! -e /srv/customer-apps/.preview-live/acme ]
  docker volume inspect preview-acme-pnpm >/dev/null
  run /opt/platform/bin/preview-live-update acme <<<"$(update_payload)"
  [ "$status" -ne 0 ]
  [[ $output == *"no está arrancada"* ]]
}

@test "uninstall-client retira también el clon y la caché de pnpm de la vista en vivo" {
  run /opt/platform/bin/install-client delta <<<"$(new_pubkey)"
  [ "$status" -eq 0 ]
  run /opt/platform/bin/preview-install delta
  [ "$status" -eq 0 ]
  repo=/srv/test-git/testorg/delta-app.git
  new_dir "$repo"
  new_dir /tmp/delta-work
  g init -q --bare "$repo"
  g init -q -b "$BRANCH" /tmp/delta-work
  printf '{"scripts":{"dev:preview":"x"}}\n' >/tmp/delta-work/package.json
  printf 'delta\n' >/tmp/delta-work/message.txt
  g -C /tmp/delta-work add -A
  g -C /tmp/delta-work -c user.name=Claude -c user.email=ai@test commit -q -m inicial
  g -C /tmp/delta-work push -q "$repo" "$BRANCH"
  run /opt/platform/bin/preview-live-start delta <<<"$(jq -cn --arg b "$BRANCH" --arg t "$TOKEN" '{repository: "testorg/delta-app", branch: $b, token: $t}')"
  [ "$status" -eq 0 ]

  run /opt/platform/bin/uninstall-client delta
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .removed.preview)" = true ]
  [ ! -e /srv/customer-apps/.preview-live/delta ]
  ! docker volume inspect preview-delta-pnpm >/dev/null 2>&1
  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=preview-delta)" ]
  nginx -t
}
