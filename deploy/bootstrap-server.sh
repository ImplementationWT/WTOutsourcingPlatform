#!/usr/bin/env bash
# Preparación única del VPS para Launchpad. Se ejecuta como root y es idempotente.
# Solo crea cosas nuevas (/opt/wt-launchpad, /var/www/launchpad y el sitio launchpad.whatever.tech);
# no toca los demás sitios de Nginx ni contenedores.
#
# Uso: bootstrap-server.sh "<clave pública ssh de GitHub Actions>" <ruta a launchpad.whatever.tech.conf>
# (lo lanza scripts/setup-deploy.sh).
set -euo pipefail

DOMAIN=launchpad.whatever.tech

main() {
  local pubkey="$1" nginx_src="$2"
  [ "$(id -u)" -eq 0 ] || { echo "Ejecutar como root" >&2; exit 1; }
  [ -s "$nginx_src" ] || { echo "Falta $nginx_src" >&2; exit 1; }

  # Clave dedicada de GitHub Actions (revocable borrando su línea de authorized_keys).
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  if ! grep -qxF "$pubkey" /root/.ssh/authorized_keys; then
    # Si la última línea no termina en salto de línea, la clave quedaría pegada a ella.
    [ -z "$(tail -c1 /root/.ssh/authorized_keys)" ] || echo >> /root/.ssh/authorized_keys
    echo "$pubkey" >> /root/.ssh/authorized_keys
  fi

  install -d -m 755 /var/www/launchpad /var/www/launchpad/releases
  install -d -m 700 /opt/wt-launchpad /opt/wt-launchpad/incoming

  # Certificado (el plugin nginx solo atiende el challenge; no edita la configuración).
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    certbot certonly --nginx --non-interactive --agree-tos -d "$DOMAIN"
  fi

  install -m 644 "$nginx_src" "/etc/nginx/sites-available/$DOMAIN"
  ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  rm -f "$nginx_src"
  nginx -t
  systemctl reload nginx

  echo "Servidor listo para desplegar en https://$DOMAIN"
}

main "$@"
