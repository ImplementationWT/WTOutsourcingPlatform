import { useFormContext, useWatch } from "react-hook-form";
import { useServers } from "@/features/servers/api";
import type { NewProjectValues } from "./schema";

/** Servidores que se pueden elegir (verificados) y el elegido en el formulario. */
export function useSelectedServer() {
  const { control } = useFormContext<NewProjectValues>();
  const serverId = useWatch({ control, name: "serverId" });
  const ready = (useServers().data?.servers ?? []).filter((s) => s.status === "ready");
  return { ready, selected: ready.find((s) => s.id === serverId) };
}
