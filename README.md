# Launchpad

Plataforma interna de WhatEver que crea, despliega y mantiene una app por cliente:
repo desde la plantilla `node-typescript`, base en MongoDB Atlas, despliegue en los
servidores de la empresa y AI Developer para pedir cambios a Claude.

- Panel: React + Vite (`src/`).
- API: Fastify + MongoDB (`apps/api/`).
- Scripts de los servidores: `deploy/platform/`.

## Ejecutarlo en local (un comando)

Necesitas [Docker Desktop](https://www.docker.com/products/docker-desktop/) abierto y,
una sola vez, las credenciales de la GitHub App y de MongoDB Atlas:

1. Copia `apps/api/.env.example` a `apps/api/.env` y rellena `GITHUB_*`, `ATLAS_*` y
   `APP_BASE_DOMAIN`. Si ya tienes un `.env`, sirve tal cual.
2. Guarda la clave privada de la GitHub App como `apps/api/github-app.pem`. El
   `.gitignore` la excluye, así que nunca se sube.
3. Desde la carpeta del repositorio:

```bash
docker compose up --build
```

Abre <http://localhost:8080> y entra con `admin` / `launchpad-local`, o con el usuario
de tu `.env` si define `PANEL_ADMIN_USERNAME` y `PANEL_ADMIN_PASSWORD_HASH`.

**Qué se genera solo:**

- la base administrativa, una MongoDB local;
- las claves de cifrado y el secreto de sesión, que se guardan en un volumen de Docker,
  solo en tu equipo;
- el usuario del panel.

El despliegue a servidores está **desactivado** (`DEPLOY_ENABLED=false`): desde local
nunca se toca un VPS. Con credenciales reales, crear un proyecto **sí** crea su repo en
GitHub y su base en Atlas.

- **Parar:** `Ctrl+C` (o `docker compose down`). Los datos se conservan.
- **Empezar de cero:** `docker compose down -v`.
- **Puerto ocupado:** `PORT=8081 docker compose up --build`.
- **Otra contraseña local:** `LOCAL_ADMIN_PASSWORD=… docker compose up --build`.
- **AI Developer en local** (opcional): añade `ANTHROPIC_API_KEY=sk-ant-…` y
  `ANTHROPIC_WORKSPACE` a `apps/api/.env`.

## Desarrollo con recarga automática

Con Node 24 y pnpm 12: `pnpm install` en la raíz y en `apps/api`. Después,
`cd apps/api && pnpm dev` (API en `:3001`) y `pnpm dev` en la raíz (panel en `:5173`).
Hace falta un `apps/api/.env` completo (ver `.env.example`) y una MongoDB.

Tests: `pnpm test` (panel), `cd apps/api && pnpm test` (API) y
`bash deploy/platform/tests/run.sh` (scripts de los servidores).

## Documentación

- [Despliegue en los servidores](docs/deployment.md) y [servidores múltiples](docs/servers.md)
- [AI Developer](docs/ai-developer.md)
- [Seguridad](docs/security.md) y [procedimientos](docs/runbooks.md)
- [Contrato de la plantilla](docs/TEMPLATE_CONTRACT.md)
