# "node" simulado para la vista previa en vivo (solo pruebas, sin red): corepack instala un
# pnpm falso que "instala" (cuenta las instalaciones) y arranca un servidor de desarrollo
# que lee el clon en cada petición, como Vite con HMR.
FROM node:24-alpine
COPY corepack /usr/local/bin/corepack
COPY pnpm dev-server.js /fake/
RUN chmod 755 /usr/local/bin/corepack /fake/pnpm
