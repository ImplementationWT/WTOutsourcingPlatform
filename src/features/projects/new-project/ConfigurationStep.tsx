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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { usePlatform } from "../api";
import { DEPLOY_DOMAIN, deriveResources, STACK } from "../config";
import { Code, InfoRow, Pill } from "./parts";

export default function ConfigurationStep({ slug }: { slug: string }) {
  const platform = usePlatform().data;
  const DEPLOY_ENABLED = platform?.deployEnabled ?? false;
  const domain = platform?.appBaseDomain ?? DEPLOY_DOMAIN;
  const resources = deriveResources(slug, domain);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Integraciones</CardTitle>
          <CardDescription>
            Se generan automáticamente a partir del identificador <Code>{slug}</Code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-white/10">
          <InfoRow
            icon={FolderGit2}
            title="Repositorio GitHub"
            note="La organización corporativa se configura globalmente."
            pill={<Pill>Obligatorio</Pill>}
          >
            Nombre generado automáticamente: <Code>{resources.repository}</Code>
          </InfoRow>
          <InfoRow
            icon={Database}
            title="Base de datos MongoDB Atlas"
            note="En el clúster compartido, con la colección app_metadata inicializada."
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
          </InfoRow>
        </CardContent>
      </Card>

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
            <p className="text-sm font-medium text-muted-foreground">Entorno de despliegue</p>
            <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <Server className="size-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{STACK.environment}</p>
                <p className="text-sm text-muted-foreground">{STACK.environmentDetail}.</p>
              </div>
              <Pill>Predeterminado</Pill>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Subdominio</p>
            <div className="flex items-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] font-mono text-sm">
              <span className="truncate px-3 py-2.5 text-foreground">{slug || "mi-proyecto"}</span>
              <span className="border-l border-white/10 bg-white/[0.03] px-3 py-2.5 text-muted-foreground">
                .{domain}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Se genera a partir del identificador y coincide con la configuración del proxy y del health check.
            </p>
          </div>

          <div className="divide-y divide-white/10">
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
