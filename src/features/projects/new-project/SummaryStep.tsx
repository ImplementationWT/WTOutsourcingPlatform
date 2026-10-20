import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useIntegrationCatalog, usePlatform } from "../api";
import { deriveResources, STACK } from "../config";
import { useSelectedServer } from "./useSelectedServer";
import { Code } from "./parts";
import type { NewProjectValues } from "./schema";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function Section({
  title,
  description,
  onEdit,
  children,
}: {
  title: string;
  description: string;
  onEdit?: () => void;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {onEdit && (
          <CardAction>
            <Button type="button" variant="ghost" size="sm" onClick={onEdit} className="text-muted-foreground">
              <Pencil />
              Editar
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-foreground/10">{children}</dl>
      </CardContent>
    </Card>
  );
}

export default function SummaryStep({
  values,
  onEditInfo,
}: {
  values: NewProjectValues;
  onEditInfo: () => void;
}) {
  const platform = usePlatform().data;
  const catalog = useIntegrationCatalog().data;
  const DEPLOY_ENABLED = platform?.deployEnabled ?? false;
  const { selected } = useSelectedServer();
  const resources = deriveResources(values.slug, selected?.appsDomain ?? platform?.appBaseDomain);
  // Solo el estado: los valores de las credenciales nunca se muestran.
  const enabledIntegrations = (catalog?.providers ?? []).filter((p) => values.integrations?.[p.id]?.enabled);

  return (
    <div className="space-y-6">
      <Section title="Proyecto" description="Datos ingresados en el primer paso." onEdit={onEditInfo}>
        <Row label="Nombre">{values.name}</Row>
        <Row label="Identificador">
          <Code>{values.slug}</Code>
        </Row>
        <Row label="Descripción">{values.description}</Row>
      </Section>

      <Section title="Recursos e integraciones" description="Lo que se creará automáticamente.">
        <Row label="Repositorio GitHub">
          <Code>
            {platform?.githubOwner ?? "…"}/{resources.repository}
          </Code>{" "}
          <span className="text-muted-foreground">· privado, generado desde la plantilla</span>
        </Row>
        <Row label="Base de datos MongoDB">
          <Code>{resources.database}</Code>
          {platform && (
            <span className="text-muted-foreground"> · clúster {platform.atlas.clusterName} de MongoDB Atlas</span>
          )}
        </Row>
        <Row label="Usuario de la base">
          <Code>{resources.dbUser}</Code> <span className="text-muted-foreground">· readWrite solo sobre su base</span>
        </Row>
        <Row label="Tecnología">{STACK.runtime}</Row>
        <Row label="CI/CD">{STACK.ci}: tests, build y despliegue</Row>
        <Row label="Versionamiento">
          {STACK.versioning}
          {platform && <span className="text-muted-foreground"> · plantilla node-typescript@{platform.templateVersion}</span>}
        </Row>
        <Row label="Integraciones">
          {enabledIntegrations.length
            ? enabledIntegrations.map((p) => `${p.label}: activada`).join(" · ")
            : "Ninguna"}
        </Row>
      </Section>

      <Section
        title="Despliegue"
        description={DEPLOY_ENABLED ? "Dónde y cómo se publicará." : "Próxima fase: no se ejecuta todavía."}
      >
        <Row label="Servidor">
          {selected ? selected.name : STACK.environment}{" "}
          <span className="text-muted-foreground">· {STACK.environmentDetail} · no se podrá cambiar</span>
        </Row>
        <Row label="URL pública">
          <Code>https://{resources.subdomain}</Code>
        </Row>
        <Row label="HTTPS">Certificado de Let&apos;s Encrypt (Certbot) servido por nginx{!DEPLOY_ENABLED && " · próximamente"}</Row>
        <Row label="Verificación">
          <Code>{STACK.healthPath}</Code> y <Code>{STACK.metaPath}</Code> antes de marcarlo como listo
          {!DEPLOY_ENABLED && " · próximamente"}
        </Row>
      </Section>
    </div>
  );
}
