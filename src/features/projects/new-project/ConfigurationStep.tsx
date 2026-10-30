import {
  Braces,
  Database,
  FolderGit2,
  KeyRound,
  Rocket,
  Server,
  ShieldCheck,
  Tag,
  Workflow,
} from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useFormContext } from "react-hook-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { usePlatform } from "../api";
import { DEPLOY_DOMAIN, deriveResources, STACK } from "../config";
import IntegrationsSection from "../integrations/IntegrationsSection";
import { Code, InfoRow, Pill } from "./parts";
import type { NewProjectValues } from "./schema";
import { useSelectedServer } from "./useSelectedServer";

export default function ConfigurationStep({ slug }: { slug: string }) {
  const platform = usePlatform().data;
  const { setValue } = useFormContext<NewProjectValues>();
  const { ready, selected } = useSelectedServer();
  const DEPLOY_ENABLED = platform?.deployEnabled ?? false;
  const domain = selected?.appsDomain ?? platform?.appBaseDomain ?? DEPLOY_DOMAIN;

  // Por defecto, el primer servidor listo (el principal, si existe).
  useEffect(() => {
    if (!selected && ready[0]) setValue("serverId", ready[0].id);
  }, [selected, ready, setValue]);
  const resources = deriveResources(slug, domain);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Recursos</CardTitle>
          <CardDescription>
            Se generan automáticamente a partir del identificador <Code>{slug}</Code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-foreground/10">
          <InfoRow
            icon={FolderGit2}
            title="Repositorio GitHub"
            note={platform ? `Privado, en la cuenta ${platform.githubOwner} de GitHub.` : undefined}
            pill={<Pill>Obligatorio</Pill>}
          >
            Nombre generado automáticamente: <Code>{platform ? `${platform.githubOwner}/` : ""}{resources.repository}</Code>
          </InfoRow>
          <InfoRow
            icon={Database}
            title="Base de datos MongoDB Atlas"
            note={`En el clúster compartido${platform ? ` ${platform.atlas.clusterName}` : ""}, con la colección app_metadata inicializada.`}
            pill={<Pill>Obligatorio</Pill>}
          >
            Base de datos dedicada: <Code>{resources.database}</Code>
          </InfoRow>
          <InfoRow
            icon={KeyRound}
            title="Usuario de la base"
            note="Contraseña aleatoria que solo se guarda cifrada en los secrets del entorno production."
            pill={<Pill>Obligatorio</Pill>}
          >
            <Code>{resources.dbUser}</Code> con <Code>readWrite</Code> solo sobre su base.
          </InfoRow>
          <InfoRow icon={Braces} title="Tecnología" pill={<Pill>Estándar</Pill>}>
            {STACK.runtime}
          </InfoRow>
          <InfoRow icon={Workflow} title={`CI/CD con ${STACK.ci}`} pill={<Pill>Obligatorio</Pill>}>
            Tests, build y despliegue automatizado.
          </InfoRow>
          <InfoRow icon={Tag} title="Versionamiento" pill={<Pill>Estándar</Pill>}>
            {STACK.versioning} sobre la rama <Code>main</Code>.
            {platform && (
              <>
                {" "}La plataforma espera <Code>node-typescript@{platform.templateVersion}</Code>.
              </>
            )}
          </InfoRow>
        </CardContent>
      </Card>

      <IntegrationsSection />

      <Card>
        <CardHeader>
          <CardTitle>Despliegue</CardTitle>
          <CardDescription>
            {DEPLOY_ENABLED
              ? "Infraestructura donde se publicará el proyecto."
              : "Próxima fase: por ahora se reserva el subdominio y el repo queda conectado a su base, sin desplegar."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Servidor</p>
            {ready.length ? (
              <div className="space-y-2" role="radiogroup" aria-label="Servidor">
                {ready.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    role="radio"
                    aria-checked={selected?.id === server.id}
                    onClick={() => setValue("serverId", server.id)}
                    className={cn(
                      "flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors",
                      selected?.id === server.id
                        ? "border-brand-400/60 bg-brand-500/10"
                        : "border-foreground/10 bg-foreground/[0.03] hover:border-foreground/25",
                    )}
                  >
                    <Server className="size-6 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{server.name}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        *.{server.appsDomain} · {STACK.environmentDetail}
                      </p>
                    </div>
                    {selected?.id === server.id && <Pill>Elegido</Pill>}
                  </button>
                ))}
                <p className="text-xs text-muted-foreground">
                  El servidor no se puede cambiar después. Se gestionan en{" "}
                  <Link to="/integrations" className="underline underline-offset-4">
                    Integraciones
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-4 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4">
                <Server className="size-6 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{STACK.environment}</p>
                  <p className="text-sm text-muted-foreground">{STACK.environmentDetail}.</p>
                </div>
                <Pill>Predeterminado</Pill>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Subdominio</p>
            <div className="flex items-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground/[0.03] font-mono text-sm">
              <span className="truncate px-3 py-2.5 text-foreground">{slug || "mi-proyecto"}</span>
              <span className="border-l border-foreground/10 bg-foreground/[0.03] px-3 py-2.5 text-muted-foreground">
                .{domain}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Se genera a partir del identificador y coincide con la configuración del proxy y del health check.
            </p>
          </div>

          <div className="divide-y divide-foreground/10">
            <InfoRow
              icon={ShieldCheck}
              title="Certificado TLS automático"
              pill={DEPLOY_ENABLED ? <Pill tone="emerald">Activado</Pill> : <Pill>Próximamente</Pill>}
            >
              HTTPS con nginx y un certificado de Let&apos;s Encrypt (Certbot) por subdominio, renovado automáticamente.
            </InfoRow>
            <InfoRow
              icon={Rocket}
              title="Publicación automática"
              pill={DEPLOY_ENABLED ? <Pill tone="emerald">Activado</Pill> : <Pill>Próximamente</Pill>}
            >
              Lanzar el primer despliegue y verificar <Code>{STACK.healthPath}</Code> y que{" "}
              <Code>{STACK.metaPath}</Code> devuelva el clientId antes de marcar el proyecto como listo.
            </InfoRow>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
