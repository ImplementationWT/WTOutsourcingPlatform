# Entorno de pruebas de los scripts del servidor: Docker propio (dind), nginx,
# certbot simulado y un registro local. Nada sale de este contenedor.
FROM docker:27-dind
RUN apk add --no-cache bash bats jq nginx openssl util-linux shadow sudo iproute2 curl coreutils musl-utils openssh-keygen git
COPY stubs/certbot /usr/local/bin/certbot
ENV DOCKER_TLS_CERTDIR="" LANG=C.UTF-8
ENTRYPOINT ["bash", "/src/deploy/platform/tests/entrypoint.sh"]
