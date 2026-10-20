// Contrato de /api/servers (apps/api/src/routes/servers.ts y apps/api/src/servers/directory.ts).

export type ServerStatus = "host_key" | "verify" | "ready";

export interface ServerCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Si falla, ¿impide usar el servidor? (las vistas previas, por ejemplo, son opcionales). */
  required: boolean;
  detail?: string;
}

export interface DeployServer {
  id: string;
  name: string;
  /** El de la configuración de la plataforma (DEPLOY_HOST…): no se edita ni se quita desde aquí. */
  primary: boolean;
  host: string;
  sshPort: number | null;
  appsDomain: string;
  publicIp: string;
  status: ServerStatus;
  /** Clave pública del provisioner para bootstrap-vps.sh (la privada nunca sale de la API). */
  provisionerPublicKey: string | null;
  hostKeyFingerprint: string | null;
  verification: { at: string; ok: boolean; checks: ServerCheck[]; error?: string } | null;
  projects: number;
  createdBy: string | null;
  createdAt: string | null;
}

export interface ServersResponse {
  /** Se pueden dar de alta servidores (hay clave de cifrado en la plataforma). */
  available: boolean;
  ghcrOrg: string | null;
  servers: DeployServer[];
}

export interface NewServerInput {
  name: string;
  host: string;
  sshPort: number;
  appsDomain: string;
  publicIp: string;
}
