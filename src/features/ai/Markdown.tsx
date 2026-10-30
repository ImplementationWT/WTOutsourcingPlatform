import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Sin rehype-raw: el HTML que venga en el texto se muestra como texto, nunca se ejecuta.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-brand-300 underline underline-offset-4 hover:text-brand-200">
      {children}
    </a>
  ),
  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-3">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-4 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 font-semibold first:mt-0">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="mt-3 border-l-2 border-foreground/20 pl-3 text-muted-foreground">{children}</blockquote>,
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-foreground/10 bg-foreground/5 px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-foreground/10 px-2 py-1">{children}</td>,
  pre: ({ children }) => (
    <pre className="mt-3 overflow-x-auto rounded-lg border border-foreground/10 bg-foreground/5 p-3 font-mono text-xs leading-relaxed">{children}</pre>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),
};

/** Texto de Claude con formato (listas, código, tablas, enlaces). */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
