# App simulada con el contrato mínimo: /health, usuario node y puerto 3000.
FROM node:24-alpine
ARG BROKEN=0
ENV FAKE_BROKEN=$BROKEN
COPY server.js /app/server.js
USER node
CMD ["node", "/app/server.js"]
