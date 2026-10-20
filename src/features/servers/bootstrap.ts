import type { DeployServer } from "@/types/server";

/** Comandos para preparar el VPS: platform.conf, clave pública del provisioner y bootstrap. */
export function bootstrapCommands(server: DeployServer, ghcrOrg: string | null) {
  const origin = window.location.origin;
  const ssh = server.sshPort && server.sshPort !== 22 ? ` -e "ssh -p ${server.sshPort}"` : "";
  return [
    "# 1. Desde tu máquina, en la raíz del repo de la plataforma: copia los scripts al VPS",
    `rsync -a --delete${ssh} deploy/platform/ root@${server.host}:/root/platform-src/`,
    "",
    "# 2. En el VPS, como root (con Docker, nginx y certbot instalados). Si ya existe",
    "#    /opt/platform/etc/platform.conf, edítalo en vez de reemplazarlo.",
    "install -d -m 755 /opt/platform/etc",
    "cat > /opt/platform/etc/platform.conf <<'EOF'",
    `GHCR_ORG=${ghcrOrg ?? "<owner de GHCR en minúsculas>"}`,
    `APP_BASE_DOMAIN=${server.appsDomain}`,
    "ACME_EMAIL=<correo para Let's Encrypt>",
    `PANEL_ORIGIN=${origin}`,
    `PANEL_UPSTREAM=${origin}`,
    "EOF",
    "",
    "# 3. Clave del orquestador de Launchpad (solo la pública) y preparación del servidor",
    `echo '${server.provisionerPublicKey ?? ""}' > /root/launchpad-provisioner.pub`,
    "bash /root/platform-src/bin/bootstrap-vps.sh --wire-nginx --provisioner-pubkey /root/launchpad-provisioner.pub",
  ].join("\n");
}
