#!/usr/bin/env bash
# Ejecuta las pruebas de los scripts del servidor en un contenedor local (privilegiado
# porque lleva su propio Docker). No se conecta a ningún servidor.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
docker build -q -t platform-scripts-tests "$root/deploy/platform/tests" >/dev/null
exec docker run --rm --privileged \
  -v "$root/deploy/platform:/src/deploy/platform:ro" \
  -v "$root/docs:/src/docs:ro" \
  platform-scripts-tests
