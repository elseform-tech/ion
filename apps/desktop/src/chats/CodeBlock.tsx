import { ChevronsUpDown, Copy } from "@ion/design-system";
import type { Element, Text } from "hast";
import { type HTMLAttributes, useState } from "react";

const FOLD = 12;

/** The fence's code element: its language, the file name after it ("```ts src/a.ts"), and its text. */
function fenceOf(node: Element | undefined): { lang: string; file: string; text: string } {
  const code = node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
  const cls = (code?.properties.className as string[] | undefined) ?? [];
  const lang = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
  const meta = (code?.data as { meta?: string } | undefined)?.meta ?? "";
  const text = (code?.children ?? [])
    .map((c) => (c as Text).value ?? "")
    .join("")
    .replace(/\n$/, "");
  return { lang, file: meta.trim(), text };
}

/** A fenced block, as the lab's `.cblock`: language, file name and Copy; over 12 lines it folds. */
export function CodeBlock({ node }: HTMLAttributes<HTMLPreElement> & { node?: Element }) {
  const [open, setOpen] = useState(false);
  const { lang, file, text } = fenceOf(node);
  const lines = text.split("\n");
  const hidden = lines.length - FOLD;
  return (
    <div className={`cblock${open ? " open" : ""}`}>
      <div className="ch">
        {lang && <span className="lang">{lang}</span>}
        {file && <span>{file}</span>}
        <span className="sp" />
        <button
          className="ib"
          type="button"
          title="Copy"
          onClick={() => void navigator.clipboard?.writeText(text)}
        >
          <Copy />
        </button>
      </div>
      <pre>{hidden > 0 && !open ? lines.slice(0, FOLD).join("\n") : text}</pre>
      {hidden > 0 && (
        <button className="more" type="button" onClick={() => setOpen(!open)}>
          <ChevronsUpDown />
          {open ? "Show less" : `Show ${hidden} more lines`}
        </button>
      )}
    </div>
  );
}
