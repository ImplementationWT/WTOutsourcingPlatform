import { useState } from "react";
import { Link } from "react-router-dom";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIntegrationCatalog, useProjects } from "./api";
import { deriveResources } from "./config";
import ConfigurationStep from "./new-project/ConfigurationStep";
import ProjectInfoStep from "./new-project/ProjectInfoStep";
import ProvisioningPanel from "./new-project/ProvisioningPanel";
import { newProjectSchema, type NewProjectValues } from "./new-project/schema";
import Stepper from "./new-project/Stepper";
import SummaryStep from "./new-project/SummaryStep";
import { useProvisioning } from "./provisioning";
import { useIsBoss } from "@/features/auth/auth";

const STEPS = ["Información", "Integraciones y despliegue", "Resumen", "Creación"];
const FORM_STEPS = 3;

/** El proyecto queda en el equipo de quien lo crea; un CEO/CCO elige el equipo. */
export default function NewProjectPage() {
  const isBoss = useIsBoss();
  const { data: projects } = useProjects();
  const { data: catalog } = useIntegrationCatalog();
  const provisioning = useProvisioning();
  const [step, setStep] = useState(0);
  const [slugTouched, setSlugTouched] = useState(false);

  const form = useForm<NewProjectValues>({
    resolver: zodResolver(newProjectSchema),
    defaultValues: { name: "", slug: "", description: "", integrations: {} },
    mode: "onTouched",
  });
  const values = useWatch({ control: form.control }) as NewProjectValues;

  async function goNext() {
    if (step === 0) {
      const valid = await form.trigger(["name", "slug", "description"]);
      if (!valid) return;
      if (isBoss && !values.teamId) {
        form.setError("teamId", { message: "Elige el equipo del proyecto" });
        return;
      }
      const repository = deriveResources(values.slug).repository;
      if (projects?.some((p) => p.name.toLowerCase() === repository)) {
        form.setError("slug", { message: `Ya existe el repositorio ${repository} en GitHub` });
        return;
      }
    }
    if (step === 1) {
      // Una integración activada necesita todos sus campos.
      const incomplete = (catalog?.providers ?? []).find((provider) => {
        const state = values.integrations?.[provider.id];
        return state?.enabled && provider.fields.some((f) => !(state.credentials[f.name] ?? "").trim());
      });
      if (incomplete) {
        form.setError("integrations", { message: `Completa la credencial de ${incomplete.label} o desactívala.` });
        return;
      }
    }
    setStep((s) => Math.min(s + 1, FORM_STEPS - 1));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function submit(data: NewProjectValues) {
    const enabled = Object.entries(data.integrations ?? {}).filter(([, state]) => state.enabled);
    setStep(FORM_STEPS);
    void provisioning.start({
      name: data.name,
      slug: data.slug,
      description: data.description,
      ...(data.serverId ? { serverId: data.serverId } : {}),
      ...(isBoss && data.teamId ? { teamId: data.teamId } : {}),
      ...(enabled.length ? { integrations: Object.fromEntries(enabled.map(([id, state]) => [id, state.credentials])) } : {}),
    });
    // Enviadas una vez: se borran del formulario (si se vuelve atrás habrá que escribirlas de nuevo).
    form.setValue("integrations", {});
  }

  const stepperCurrent = provisioning.job?.status === "succeeded" ? STEPS.length : step;

  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Proyectos
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Nuevo proyecto</h1>
        <p className="mt-2 text-muted-foreground">
          Define el proyecto y la plataforma creará su repositorio y lo conectará a su base de datos.
        </p>
      </div>

      <Stepper steps={STEPS} current={stepperCurrent} />

      {step === FORM_STEPS && (
        <ProvisioningPanel
          projectName={values.name}
          provisioning={provisioning}
          onBack={() => {
            provisioning.reset();
            setStep(FORM_STEPS - 1);
          }}
        />
      )}

      <FormProvider {...form}>
        <form
          hidden={step === FORM_STEPS}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step === FORM_STEPS - 1) form.handleSubmit(submit)();
            else goNext();
          }}
          className="space-y-6"
        >
          {step === 0 && (
            <ProjectInfoStep slugTouched={slugTouched} onSlugTouched={() => setSlugTouched(true)} />
          )}
          {step === 1 && (
            <ConfigurationStep slug={values.slug} />
          )}
          {step === 2 && <SummaryStep values={values} onEditInfo={() => setStep(0)} />}

          <div className="flex items-center justify-between border-t border-foreground/10 pt-6">
            {step === 0 ? (
              <Button variant="ghost" render={<Link to="/projects" />} nativeButton={false}>
                Cancelar
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={goBack}>
                <ArrowLeft />
                Atrás
              </Button>
            )}

            {step < FORM_STEPS - 1 ? (
              <Button type="submit">
                Siguiente
                <ArrowRight />
              </Button>
            ) : (
              <Button type="submit">
                <Rocket />
                Crear proyecto
              </Button>
            )}
          </div>
        </form>
      </FormProvider>
    </section>
  );
}
