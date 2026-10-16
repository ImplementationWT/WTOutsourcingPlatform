import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const listeners = new Set<() => void>();

/** Preferencia guardada (oscuro por defecto). El almacenamiento puede no estar disponible. */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Aplica un tema al documento (clase .dark en <html>). */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

function setStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Sin almacenamiento: el tema dura hasta recargar.
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

/** Tema del panel y su conmutador. El login usa siempre el oscuro (su fondo es de marca). */
export function useTheme() {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    storedTheme,
    () => "dark" as Theme,
  );
  const toggle = useCallback(() => setStoredTheme(storedTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}
