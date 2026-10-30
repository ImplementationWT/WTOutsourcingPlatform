import { cn } from "@/lib/utils";

/** Isotipo de Whatever Tech (whatever.tech): cuadrado rojo redondeado con la W blanca. */
export function BrandMark({ className, title = "Whatever Tech" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={title} className={cn("size-8 shrink-0", className)}>
      <rect width="100" height="100" rx="13" fill="#ff3054" />
      <path d="M13.1 20.2H75.2A11.9 11.9 0 0 1 83.6 39.8L44 79.3V48.6L13.1 79.3Z" fill="#fff" />
    </svg>
  );
}

/** Isotipo + nombre de la empresa, como en el encabezado del sitio. */
export function BrandLockup({ subtitle, className }: { subtitle?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <BrandMark className="size-9" />
      <div className="min-w-0 leading-tight">
        <p className="truncate font-semibold tracking-tight">Whatever Tech</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}
