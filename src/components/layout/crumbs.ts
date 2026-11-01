import { createContext, useContext, useEffect } from "react";

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * Migas de pan del encabezado. El área y la pantalla salen del menú; una página de detalle suma
 * su nombre con `useCrumbs` (o reemplaza todo si la pantalla no está en el menú).
 */
export interface CrumbsApi {
  set: (crumbs: { extra?: Crumb[]; replace?: Crumb[] } | null) => void;
}

export const CrumbsContext = createContext<CrumbsApi>({ set: () => {} });

/** Suma migas al final (el nombre del registro abierto) o, con `replace`, las define todas. */
export function useCrumbs(extra: (Crumb | null | false | undefined)[], options: { replace?: boolean } = {}) {
  const { set } = useContext(CrumbsContext);
  const list = extra.filter((c): c is Crumb => Boolean(c && c.label));
  const key = JSON.stringify(list);
  const replace = Boolean(options.replace);
  useEffect(() => {
    const crumbs = JSON.parse(key) as Crumb[];
    set(replace ? { replace: crumbs } : { extra: crumbs });
    return () => set(null);
  }, [key, replace, set]);
}
