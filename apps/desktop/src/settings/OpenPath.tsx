import { Check, type LucideIcon } from "@ion/design-system";
import { useState } from "react";
import { openFile } from "../opener.js";

/**
 * Opens a file or folder of ion's (your mcp.json, the memory folder, a memory file) in its app; outside the app it
 * copies the path (and says so with a check). `onFail`: whether the system wouldn't open it.
 */
export function OpenPath(p: {
  path: string;
  name: string;
  icon: LucideIcon;
  onFail: (failed: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const name = copied ? "Path copied" : p.name;
  const Icon = copied ? Check : p.icon;
  return (
    <button
      className="ib"
      type="button"
      title={name}
      aria-label={name}
      onClick={() =>
        void openFile(p.path).then((r) => {
          p.onFail(r === "failed");
          if (r !== "copied") return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <Icon />
    </button>
  );
}
