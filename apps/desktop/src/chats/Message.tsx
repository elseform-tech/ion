import { type AnchorHTMLAttributes, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";

/**
 * Links in agents' text can't navigate at all (no href: no click, middle-click or keyboard opens anything);
 * hovering shows where they point. Opening them in your browser can come later, through the OS.
 */
function Link({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <span className="md-link" title={href}>
      {children}
    </span>
  );
}

/**
 * An agent's text as Markdown. Raw HTML is never rendered (react-markdown leaves it out without a raw-HTML
 * plugin), and unsafe link targets such as javascript: are emptied by its URL check.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: Link, pre: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
