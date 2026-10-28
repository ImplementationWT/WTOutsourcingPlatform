#!/usr/bin/env bats
# deploy-client: protocolo del contrato (§5), compose endurecido, rollback y aislamiento.
load helpers

setup() { write_test_config; }

deploy() { # <slug> <payload>
  run /opt/platform/bin/deploy-client "$1" <<<"$2"
}

port_of_client() { awk -v s="$1" '$1 == s { print $2 }' /srv/customer-apps/.ports; }

@test "rechaza slug inválido y cliente no instalado" {
  deploy "acme;id" "$(payload "$GOOD_IMAGE_ACME")"
  [ "$output" = "DEPLOY_FAILED invalid slug" ]
  deploy nadie "$(payload "$GOOD_IMAGE_ACME")"
  [ "$output" = "DEPLOY_FAILED client not installed" ]
}

@test "rechaza imágenes por etiqueta, de otro cliente o de otro registro" {
  digest=${GOOD_IMAGE_ACME#*@}
  for image in localhost:5000/testorg/acme-app:good "localhost:5000/testorg/beta-app@$digest" \
    "ghcr.io/testorg/acme-app@$digest" "localhost:5000/otra/acme-app@$digest" ""; do
    deploy acme "$(payload "$image")"
    [ "$status" -ne 0 ]
    [ "$output" = "DEPLOY_FAILED invalid image" ]
  done
}

@test "rechaza variables no permitidas (incluidas PORT, HOST, NODE_ENV y TRUST_PROXY_HOPS)" {
  for key in PORT HOST NODE_ENV TRUST_PROXY_HOPS LOG_LEVEL SESSION_TTL_HOURS MONDAY_MAX_BOARDS FOO LD_PRELOAD; do
    deploy acme "$(payload "$GOOD_IMAGE_ACME" "{\"$key\": \"x\"}")"
    [ "$status" -ne 0 ]
    [ "$output" = "DEPLOY_FAILED env key not allowed: $key" ]
  done
  deploy acme "$(payload "$GOOD_IMAGE_ACME" '{"lower_case": "x"}')"
  [ "$output" = "DEPLOY_FAILED env key not allowed" ]
}

@test "rechaza JSON inválido, faltantes, valores con saltos de línea y sin registryToken" {
  deploy acme "no es json"
  [ "$output" = "DEPLOY_FAILED invalid payload" ]
  deploy acme "$(payload "$GOOD_IMAGE_ACME" | jq -c '. + {extra: 1}')"
  [ "$output" = "DEPLOY_FAILED invalid payload" ]
  deploy acme "$(payload "$GOOD_IMAGE_ACME" | jq -c 'del(.env.SESSION_SECRET)')"
  [ "$output" = "DEPLOY_FAILED missing env SESSION_SECRET" ]
  deploy acme "$(payload "$GOOD_IMAGE_ACME" '{"APP_DISPLAY_NAME": "dos\nlineas"}')"
  [ "$output" = "DEPLOY_FAILED invalid env value" ]
  deploy acme "$(payload "$GOOD_IMAGE_ACME" '{"MONGODB_DB": "otra-base"}')"
  [ "$output" = "DEPLOY_FAILED invalid MONGODB_DB" ]
  deploy acme "$(payload "$GOOD_IMAGE_ACME" | jq -c 'del(.registryToken)')"
  [ "$output" = "DEPLOY_FAILED missing registryToken" ]
  # Nada de lo anterior llegó a desplegar.
  [ ! -e /srv/customer-apps/acme/compose.yaml ]
}

@test "despliega: DEPLOY_OK como única salida, .env 0600 y contenedor sano" {
  deploy acme "$(payload "$GOOD_IMAGE_ACME")"
  [ "$status" -eq 0 ]
  [ "$output" = "DEPLOY_OK" ]
  [ "$(stat -c '%U %a' /srv/customer-apps/acme/.env)" = "root 600" ]
  grep -qx 'APP_DISPLAY_NAME=Acme $ "CRM" & Co' /srv/customer-apps/acme/.env
  [ "$(jq -r .image /srv/customer-apps/acme/state.json)" = "$GOOD_IMAGE_ACME" ]
  container=$(docker compose -p app-acme ps -q app)
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ]
}

@test "acepta MONDAY_API_TOKEN (contrato 1.4.0) y lo deja en el .env 0600" {
  deploy acme "$(payload "$GOOD_IMAGE_ACME" '{"MONDAY_API_TOKEN": "monday-token-de-prueba-123"}')"
  [ "$status" -eq 0 ]
  [ "$output" = "DEPLOY_OK" ]
  grep -qx 'MONDAY_API_TOKEN=monday-token-de-prueba-123' /srv/customer-apps/acme/.env
  [ "$(stat -c '%a' /srv/customer-apps/acme/.env)" = "600" ]
}

@test "acepta ANTHROPIC_API_KEY y WILL_DOO_MODE de Will Doo (contrato 1.7.0) y los deja en el .env 0600" {
  deploy acme "$(payload "$GOOD_IMAGE_ACME" '{"ANTHROPIC_API_KEY": "sk-ant-clave-de-prueba-123", "WILL_DOO_MODE": "claude"}')"
  [ "$status" -eq 0 ]
  [ "$output" = "DEPLOY_OK" ]
  grep -qx 'ANTHROPIC_API_KEY=sk-ant-clave-de-prueba-123' /srv/customer-apps/acme/.env
  grep -qx 'WILL_DOO_MODE=claude' /srv/customer-apps/acme/.env
  [ "$(stat -c '%a' /srv/customer-apps/acme/.env)" = "600" ]
}

@test "el compose fija NODE_ENV, TRUST_PROXY_HOPS, PORT y HOST, y endurece el contenedor" {
  port=$(port_of_client acme)
  runtime=$(curl -s "http://127.0.0.1:$port/runtime")
  [ "$(jq -r .NODE_ENV <<<"$runtime")" = production ]
  [ "$(jq -r .TRUST_PROXY_HOPS <<<"$runtime")" = 1 ]
  [ "$(jq -r .PORT <<<"$runtime")" = 3000 ]
  [ "$(jq -r .HOST <<<"$runtime")" = 0.0.0.0 ]
  container=$(docker compose -p app-acme ps -q app)
  [ "$(docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$container")" = "node true [ALL] [no-new-privileges:true]" ]
  [ "$(docker inspect --format '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$container")" = "json-file 10m 3" ]
  [ "$(docker inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' "$container")" = "500000000 536870912" ]
  # Publicado solo en loopback.
  [ "$(docker port "$container" 3000/tcp)" = "127.0.0.1:$port" ]
}

@test "nginx publica la app por HTTPS con Host y X-Forwarded-Proto del contrato" {
  runtime=$(curl -sk --resolve acme.apps.test:443:127.0.0.1 https://acme.apps.test/runtime)
  [ "$(jq -r .host <<<"$runtime")" = acme.apps.test ]
  [ "$(jq -r .proto <<<"$runtime")" = https ]
  [ "$(curl -sk -o /dev/null -w '%{http_code}' --resolve acme.apps.test:443:127.0.0.1 https://acme.apps.test/health)" = 200 ]
}

@test "el registryToken no se guarda en el servidor" {
  ! grep -rqs ghs_registryTokenForTests /srv/customer-apps /root/.docker /home/deploy
  [ -z "$(find /tmp -maxdepth 2 -name config.json -newer /srv/customer-apps/.ports 2>/dev/null)" ]
}

@test "si la nueva imagen no queda sana, vuelve al digest anterior" {
  deploy acme "$(payload "$BAD_IMAGE_ACME")"
  [ "$status" -ne 0 ]
  [ "$output" = "DEPLOY_FAILED unhealthy (rolled back to previous image)" ]
  [ "$(jq -r .image /srv/customer-apps/acme/state.json)" = "$GOOD_IMAGE_ACME" ]
  container=$(docker compose -p app-acme ps -q app)
  [ "$(docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' "$container")" = "$GOOD_IMAGE_ACME healthy" ]
  grep -q "$GOOD_IMAGE_ACME" /srv/customer-apps/acme/compose.yaml
}

@test "un cliente no alcanza el puerto loopback ni el contenedor de otro" {
  /opt/platform/bin/install-client beta <<<"$(new_pubkey)" >/dev/null
  deploy beta "$(jq -c '.env.MONGODB_DB = "client_beta"' <<<"$(payload "$GOOD_IMAGE_BETA")")"
  [ "$output" = "DEPLOY_OK" ]
  acme_port=$(port_of_client acme)
  acme_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose -p app-acme ps -q app)")
  gateway=$(docker network inspect app-beta --format '{{(index .IPAM.Config 0).Gateway}}')
  # Control: desde el host sí responde.
  curl -fs "http://127.0.0.1:$acme_port/health" >/dev/null
  probe() {
    docker run --rm --network app-beta --entrypoint node "$GOOD_IMAGE_BETA" -e \
      "fetch('$1', { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(1))"
  }
  run probe "http://$gateway:$acme_port/health"
  [ "$status" -ne 0 ]
  run probe "http://$acme_ip:3000/health"
  [ "$status" -ne 0 ]
  run probe "http://127.0.0.1:$acme_port/health"
  [ "$status" -ne 0 ]
}
