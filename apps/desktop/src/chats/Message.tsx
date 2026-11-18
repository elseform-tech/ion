import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Links in agents' text open nothing inside the app (ion has no browser of its own yet); hovering shows where. */
function Link({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} title={href} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  );
}

/**
 * An agent's text as Markdown. Raw HTML is never rendered (react-markdown leaves it out without a raw-HTML
 * plugin), and unsafe link targets such as javascript: are emptied by its URL check.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: Link }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
