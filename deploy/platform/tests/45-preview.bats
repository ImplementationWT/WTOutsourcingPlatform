#!/usr/bin/env bats
# Vista previa del AI Developer: preview-install, deploy-client con "target": "preview",
# acceso solo con pase de Launchpad (auth_request), preview-stop y aislamiento de producción.
load helpers

setup() { write_test_config; }

deploy() { # <slug> <payload>
  run /opt/platform/bin/deploy-client "$1" <<<"$2"
}

preview_payload() { # <image>
  jq -cn --arg image "$1" '{target: "preview", image: $image, registryToken: "ghs_registryTokenForTests0123456789"}'
}

port_of_key() { awk -v s="$1" '$1 == s { print $2 }' /srv/customer-apps/.ports; }

https_preview() { # <ruta> [args de curl…]
  local path=$1
  shift
  curl -sk --resolve preview-acme.apps.test:443:127.0.0.1 "$@" "https://preview-acme.apps.test$path"
}

@test "preview-install exige PANEL_ORIGIN y un cliente instalado" {
  write_test_config "PANEL_ORIGIN="
  run /opt/platform/bin/preview-install acme
  [ "$status" -ne 0 ]
  [[ $output == *"PANEL_ORIGIN no está configurado"* ]]

  write_test_config
  run /opt/platform/bin/preview-install nadie
  [ "$status" -ne 0 ]
  [[ $output == *"no está instalado"* ]]
  [ ! -e /etc/nginx/platform-apps/preview-nadie.conf ]
}

@test "preview-install: puerto propio, certificado y nginx con auth_request y frame-ancestors" {
  run /opt/platform/bin/preview-install acme
  [ "$status" -eq 0 ]
  result=$(tail -n 1 <<<"$output")
  [ "$(jq -r .host <<<"$result")" = preview-acme.apps.test ]
  [ "$(jq -r .certificate <<<"$result")" = issued ]
  port=$(jq -r .port <<<"$result")
  [ "$port" = "$(port_of_key preview-acme)" ]
  [ "$port" != "$(port_of_key acme)" ]
  [ "$(stat -c '%U %a' /srv/customer-apps/acme/preview)" = "root 700" ]

  conf=/etc/nginx/platform-apps/preview-acme.conf
  grep -q "auth_request /__launchpad/check;" "$conf"
  grep -q "proxy_pass http://127.0.0.1:3001/api/ai/preview/check;" "$conf"
  grep -q 'add_header Content-Security-Policy "frame-ancestors https://launchpad.test" always;' "$conf"
  grep -q "proxy_pass http://127.0.0.1:$port;" "$conf"
  nginx -t

  # Repetirlo reutiliza puerto y certificado.
  run /opt/platform/bin/preview-install acme
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .certificate)" = existing ]
  [ "$(tail -n 1 <<<"$output" | jq -r .port)" = "$port" ]
}

@test "deploy-client preview rechaza variables, destinos desconocidos e imágenes de otro cliente" {
  deploy acme "$(preview_payload "$GOOD_IMAGE_ACME" | jq -c '. + {env: {MONGODB_URI: "mongodb://otra"}}')"
  [ "$output" = "DEPLOY_FAILED preview takes no env" ]
  deploy acme "$(preview_payload "$GOOD_IMAGE_ACME" | jq -c '.target = "staging"')"
  [ "$output" = "DEPLOY_FAILED invalid target" ]
  deploy acme "$(preview_payload "$GOOD_IMAGE_BETA")"
  [ "$output" = "DEPLOY_FAILED invalid image" ]
  # beta no tiene vista previa instalada.
  deploy beta "$(preview_payload "$GOOD_IMAGE_BETA")"
  [ "$output" = "DEPLOY_FAILED preview not installed" ]
}

@test "deploy-client preview: base temporal propia, sin tocar producción" {
  prod_env=$(sha256sum /srv/customer-apps/acme/.env)
  deploy acme "$(preview_payload "$GOOD_IMAGE_ACME")"
  [ "$status" -eq 0 ]
  [ "$output" = "DEPLOY_OK" ]

  env_file=/srv/customer-apps/acme/preview/.env
  [ "$(stat -c '%U %a' "$env_file")" = "root 600" ]
  grep -qx 'MONGODB_DB=client_acme_preview' "$env_file"
  ! grep -q 's3cr3t\|session-secret\|Init-Pa55' "$env_file"
  [ "$(sha256sum /srv/customer-apps/acme/.env)" = "$prod_env" ]

  runtime=$(curl -s "http://127.0.0.1:$(port_of_key preview-acme)/runtime")
  [ "$(jq -r .MONGODB_DB <<<"$runtime")" = client_acme_preview ]
  [ "$(jq -r .mongoHost <<<"$runtime")" = mongo:27017 ]
  [ "$(jq -r .NODE_ENV <<<"$runtime")" = production ]

  # Producción sigue sana.
  container=$(docker compose -p app-acme ps -q app)
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ]
}

@test "solo se entra con pase de Launchpad; /health es libre y la puede enmarcar el panel" {
  [ "$(https_preview / -o /dev/null -w '%{http_code}')" = 401 ]
  https_preview / | grep -q "Vista previa privada"
  [ "$(https_preview / -o /dev/null -w '%{http_code}' -H 'Cookie: lp_preview=falsa')" = 401 ]
  [ "$(https_preview /health -o /dev/null -w '%{http_code}')" = 200 ]

  # El pase se canjea por la cookie de este host.
  headers=$(https_preview '/__launchpad/auth?t=pase-bueno' -D - -o /dev/null)
  grep -qi '^location: /' <<<"$headers"
  grep -qi '^set-cookie: lp_preview=cookie-buena' <<<"$headers"
  [ "$(https_preview '/__launchpad/auth?t=otro' -o /dev/null -w '%{http_code}')" = 401 ]

  # Con la cookie: la app, enmarcable solo desde el panel y sin indexar. Las cookies de la app no viajan al panel.
  headers=$(https_preview / -D - -o /dev/null -H 'Cookie: sid=de-la-app; lp_preview=cookie-buena')
  grep -q '^HTTP/[0-9.]* 200' <<<"$headers"
  grep -qi '^content-security-policy: frame-ancestors https://launchpad.test' <<<"$headers"
  grep -qi '^x-robots-tag: noindex, nofollow' <<<"$headers"
  ! grep -qi '^x-frame-options' <<<"$headers"
}

@test "preview-stop para la vista previa, borra su base y conserva nginx y certificado" {
  run /opt/platform/bin/preview-stop acme
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .stopped)" = true ]
  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=preview-acme)" ]
  [ -z "$(docker volume ls -q --filter label=com.docker.compose.project=preview-acme)" ]
  [ ! -e /srv/customer-apps/acme/preview/.env ]
  [ -e /etc/nginx/platform-apps/preview-acme.conf ]
  [ -d /etc/letsencrypt/live/preview-acme.apps.test ]
  [ "$(https_preview / -o /dev/null -w '%{http_code}' -H 'Cookie: lp_preview=cookie-buena')" = 503 ]

  run /opt/platform/bin/preview-stop acme
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .stopped)" = false ]
  # Producción intacta.
  [ "$(curl -sk -o /dev/null -w '%{http_code}' --resolve acme.apps.test:443:127.0.0.1 https://acme.apps.test/health)" = 200 ]
}

@test "por el dispatch del provisioner: preview-install y preview-stop, nada más" {
  run env SSH_ORIGINAL_COMMAND="preview-install acme" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' </dev/null
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .certificate)" = existing ]
  run env SSH_ORIGINAL_COMMAND="preview-stop acme" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' </dev/null
  [ "$status" -eq 0 ]
  for cmd in "preview-install acme; id" "preview-deploy acme" "preview-stop ../etc" "preview-install"; do
    run env SSH_ORIGINAL_COMMAND="$cmd" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' </dev/null
    [ "$status" -eq 126 ]
  done
  run su deploy -s /bin/sh -c 'sudo -n /opt/platform/bin/preview-install acme </dev/null'
  [ "$status" -ne 0 ]
}

@test "uninstall-client retira también la vista previa" {
  run /opt/platform/bin/install-client gamma <<<"$(new_pubkey)"
  [ "$status" -eq 0 ]
  run /opt/platform/bin/preview-install gamma
  [ "$status" -eq 0 ]
  run /opt/platform/bin/uninstall-client gamma
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .removed.preview)" = true ]
  [ ! -e /etc/nginx/platform-apps/preview-gamma.conf ]
  [ ! -d /etc/letsencrypt/live/preview-gamma.apps.test ]
  ! grep -q '^preview-gamma ' /srv/customer-apps/.ports
  nginx -t
}
