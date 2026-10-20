#!/usr/bin/env bash
# Arranca Docker (dind), nginx y un registro local; publica imágenes de prueba y
# ejecuta las pruebas bats. Solo dentro del contenedor de pruebas.
set -euo pipefail
tests=/src/deploy/platform/tests

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null

mkdir -p /run/nginx
nginx

docker run -d --name registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:5000/v2/ >/dev/null && break; sleep 1; done

build_push() { # <repo> <tag> <broken>
  docker build -q --build-arg "BROKEN=$3" -t "localhost:5000/testorg/$1:$2" "$tests/fake-app" >/dev/null
  docker push -q "localhost:5000/testorg/$1:$2" >/dev/null
  # Imágenes idénticas comparten capas: se elige el digest de ESTE repositorio.
  docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "localhost:5000/testorg/$1:$2" | grep -m1 "/testorg/$1@"
}
GOOD_IMAGE_ACME=$(build_push acme-app good 0)
BAD_IMAGE_ACME=$(build_push acme-app bad 1)
GOOD_IMAGE_BETA=$(build_push beta-app good 0)
# Las de origen se borran: deploy-client debe descargarlas con su login temporal.
docker rmi -f "localhost:5000/testorg/acme-app:good" "localhost:5000/testorg/acme-app:bad" "localhost:5000/testorg/beta-app:good" >/dev/null
export GOOD_IMAGE_ACME BAD_IMAGE_ACME GOOD_IMAGE_BETA

# Vistas previas: MongoDB simulada en el registro local y API del panel en 127.0.0.1:3001.
docker build -q -t localhost:5000/fake-mongo:8 "$tests/fake-mongo" >/dev/null
docker push -q localhost:5000/fake-mongo:8 >/dev/null
docker rmi -f localhost:5000/fake-mongo:8 >/dev/null
# Vista previa en vivo: "node" simulado (corepack, pnpm y servidor de desarrollo sin red).
docker build -q -t localhost:5000/fake-node:24 "$tests/fake-node" >/dev/null
docker push -q localhost:5000/fake-node:24 >/dev/null
docker rmi -f localhost:5000/fake-node:24 >/dev/null
docker build -q -t fake-panel "$tests/fake-panel" >/dev/null
docker run -d --name fake-panel --network host fake-panel >/dev/null

bats --print-output-on-failure "$tests"/*.bats
