import { type AnchorHTMLAttributes, type ImgHTMLAttributes, memo } from "react";
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

/** An image as its words only: nothing is fetched (a memory file's image could be a tracker). */
const NoImage = ({ alt }: ImgHTMLAttributes<HTMLImageElement>) => (alt ? <span>{alt}</span> : null);

/**
 * An agent's text as Markdown. Raw HTML is never rendered (react-markdown leaves it out without a raw-HTML
 * plugin), and unsafe link targets such as javascript: are emptied by its URL check.
 */
export const Markdown = memo(function Markdown(p: {
  text: string;
  htmlAsText?: boolean;
  noImages?: boolean;
}) {
  const { text, htmlAsText } = p;
  return (
    <div className="md">
      {/* htmlAsText: raw HTML is shown as its text (escaped), never rendered and never dropped. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml={!htmlAsText}
        components={{ a: Link, pre: CodeBlock, ...(p.noImages ? { img: NoImage } : {}) }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
