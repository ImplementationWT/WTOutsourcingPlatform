#!/usr/bin/env bats
# provisioner-dispatch: solo la lista estricta de comandos; sudo limitado.
load helpers

setup() { write_test_config; }


dispatch() {
  local cmd=$1 input=${2:-}
  run env SSH_ORIGINAL_COMMAND="$cmd" su -p provisioner -s /bin/sh -c '/opt/platform/bin/provisioner-dispatch' <<<"$input"
}

@test "client-status devuelve el estado sin variables de entorno ni secretos" {
  dispatch "client-status acme"
  [ "$status" -eq 0 ]
  json=$(tail -n 1 <<<"$output")
  [ "$(jq -r .host <<<"$json")" = acme.apps.test ]
  [ "$(jq -r .deployment.image <<<"$json")" = "$GOOD_IMAGE_ACME" ]
  [ "$(jq -r .container.health <<<"$json")" = healthy ]
  [ "$(jq -r '.certificate.notAfter | length > 0' <<<"$json")" = true ]
  [[ $output != *s3cr3t* && $output != *session-secret* && $output != *Init-Pa55* && $output != *ghs_* ]]
}

@test "server-info: verificación de solo lectura, sin secretos ni rutas de claves" {
  dispatch "server-info"
  [ "$status" -eq 0 ]
  json=$(tail -n 1 <<<"$output")
  [ "$(jq -r .status <<<"$json")" = ok ]
  [ "$(jq -r .scriptsVersion <<<"$json")" = 2 ]
  [ "$(jq -r .appBaseDomain <<<"$json")" = apps.test ]
  [ "$(jq -r .ghcrOrg <<<"$json")" = testorg ]
  [ "$(jq -r .panelOrigin <<<"$json")" = https://launchpad.test ]
  [ "$(jq -r .nginx.valid <<<"$json")" = true ]
  [ "$(jq -r .docker <<<"$json")" = true ]
  [ "$(jq -r '.ports.total' <<<"$json")" = 51 ]
  [[ $output != *ops@example.test* && $output != *BEGIN* && $output != */run/secrets* ]]
  # Sin argumentos: "server-info x" no es un comando permitido.
  dispatch "server-info acme"
  [ "$status" -eq 126 ]
}

@test "install-client por el dispatch recibe la clave por stdin" {
  dispatch "install-client acme" "$(new_pubkey)"
  [ "$status" -eq 0 ]
  [ "$(tail -n 1 <<<"$output" | jq -r .certificate)" = existing ]
}

@test "cualquier otro comando se rechaza" {
  for cmd in "" bash "id" "deploy-client acme" "install-client" "install-client acme; id" "install-client acme && id" \
    "install-client ../etc" "install-client Acme" "client-status acme extra" "client-status \$(id)" \
    "install-client $(printf 'a%.0s' {1..31})" "sudo /opt/platform/bin/install-client acme" "client-status acme
id"; do
    dispatch "$cmd"
    [ "$status" -eq 126 ]
    [[ $output == *"REJECTED command not allowed"* ]]
  done
}

@test "deploy y provisioner solo pueden usar sudo con sus scripts" {
  run su deploy -s /bin/sh -c 'sudo -n /opt/platform/bin/install-client acme </dev/null'
  [ "$status" -ne 0 ]
  run su provisioner -s /bin/sh -c 'sudo -n /opt/platform/bin/deploy-client acme </dev/null'
  [ "$status" -ne 0 ]
  run su provisioner -s /bin/sh -c 'sudo -n /bin/sh -c id'
  [ "$status" -ne 0 ]
}
