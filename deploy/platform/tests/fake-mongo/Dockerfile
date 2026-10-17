# MongoDB simulada para las vistas previas: el healthcheck del compose (mongosh) pasa
# y el contenedor sigue vivo. Misma base que fake-app para no descargar nada más.
FROM node:24-alpine
COPY --chmod=755 mongosh /usr/local/bin/mongosh
ENTRYPOINT ["/bin/sh", "-c", "exec sleep infinity", "--"]
