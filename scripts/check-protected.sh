#!/usr/bin/env bash
# Verifica que una rama no toca las zonas protegidas (docs/migracion-prototipo.md §Zonas protegidas):
# Infraestructura (Apps y Repositorios), el Dashboard existente, Integraciones, Meetings/Read.ai y el
# badge del usuario. Uso: scripts/check-protected.sh [base]   (base por defecto: origin/main)
set -euo pipefail
base="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

protected=(
  # Infraestructura: Apps y Repositorios, servidores, despliegues y AI Developer
  "src/features/projects/"
  "src/features/servers/"
  "src/features/ai/"
  "apps/api/src/adapters/"
  "apps/api/src/jobs/"
  "apps/api/src/servers/"
  "apps/api/src/ai/"
  "apps/api/src/routes/clients.ts"
  "apps/api/src/routes/servers.ts"
  "apps/api/src/routes/ai.ts"
  # Dashboard existente (con Costos)
  "src/features/dashboard/"
  "src/features/costs/"
  "apps/api/src/routes/dashboard.ts"
  "apps/api/src/routes/costs.ts"
  # Integraciones
  "apps/api/src/integrations/"
  "apps/api/src/routes/integrations.ts"
  # Meetings y la automatización de Read.ai
  "src/features/meetings/"
  "apps/api/src/meetings/"
  "apps/api/src/routes/meetings.ts"
  # Badge del usuario "admin"
  "src/components/layout/UserMenu.tsx"
)

changed="$(git diff --name-only "$base"...HEAD; git diff --name-only; git diff --name-only --cached)"
bad=0
for path in "${protected[@]}"; do
  hits="$(printf '%s\n' "$changed" | grep -F -- "$path" | sort -u || true)"
  if [[ -n "$hits" ]]; then
    printf 'ZONA PROTEGIDA modificada (%s):\n%s\n' "$path" "$hits"
    bad=1
  fi
done

# Las rutas de Infraestructura y Meetings siguen registradas igual en el router.
for route in '{ path: "/dashboard", element: <DashboardPage /> }' '{ path: "/projects", element: <ProjectsPage /> }' \
  '{ path: "/projects/new", element: <NewProjectPage /> }' '{ path: "/projects/:slug", element: <ProjectDetailPage /> }' \
  '{ path: "/integrations", element: <IntegrationsPage /> }' '{ path: "/meetings", element: <MeetingsPage /> }'; do
  grep -qF -- "$route" src/app/router.tsx || { echo "Ruta protegida cambiada o ausente: $route"; bad=1; }
done

# Los ítems de Infraestructura del menú siguen con la misma ruta y nombre.
for item in 'to: "/dashboard", label: "Dashboard"' 'to: "/projects", label: "Apps y repositorios"' 'to: "/integrations", label: "Integraciones"'; do
  grep -qF -- "$item" src/components/layout/nav.ts || { echo "Ítem protegido del menú cambiado: $item"; bad=1; }
done

if [[ $bad -eq 0 ]]; then echo "Zonas protegidas intactas respecto de $base."; fi
exit $bad
