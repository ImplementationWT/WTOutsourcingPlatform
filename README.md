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

## Desarrollo con recarga automática (sin Docker)

Con Node 24 y pnpm 12, en dos terminales desde la raíz:

```bash
pnpm install
pnpm dev        # API en http://127.0.0.1:3001 (con su propia MongoDB local)
pnpm dev:web    # panel en http://localhost:5173
```

Usa el mismo `apps/api/.env`. Aquí la ruta del `.pem` puede estar en cualquier sitio de
tu equipo.

**Qué hace `pnpm dev`:**

- instala las dependencias de la API;
- arranca una MongoDB local, con los datos en `apps/api/.dev/mongo`. Nunca usa la base
  de producción, aunque el `.env` tenga `ADMIN_MONGODB_URI`;
- genera las claves de cifrado en `apps/api/.dev`;
- desactiva el despliegue a servidores;
- reinicia la API al guardar cambios.

Para borrar los datos locales, borra `apps/api/.dev`.

Tests: `pnpm test` (panel), `cd apps/api && pnpm test` (API) y
`bash deploy/platform/tests/run.sh` (scripts de los servidores).

## Modo demo (revisar el panel y el AI Developer sin credenciales)

```bash
pnpm dev:demo   # en vez de pnpm dev (para antes pnpm dev si lo tienes abierto: usan el puerto 3001)
pnpm dev:web    # http://localhost:5173 → admin / launchpad-local
```

Todo es simulado y en memoria: GitHub, Atlas, los servidores y Claude. No hace falta
`.env`, no cuesta nada y nada sale de tu equipo. Trae dos proyectos de ejemplo ya listos.
En **Tienda Demo → AI Developer**, Claude responde en varios pasos, deja un commit y se
puede crear el PR y publicar.

La vista previa queda «lista» pero no carga una app real: el iframe apunta a un dominio
de ejemplo. Al parar, los datos se borran.

## Documentación

- [Despliegue en los servidores](docs/deployment.md) y [servidores múltiples](docs/servers.md)
- [AI Developer](docs/ai-developer.md)
- [Seguridad](docs/security.md) y [procedimientos](docs/runbooks.md)
- [Contrato de la plantilla](docs/TEMPLATE_CONTRACT.md)
