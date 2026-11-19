import type { IonClient } from "@ion/client/browser";
import { File as FileIcon, FileText, Globe, Image as ImageIcon, type LucideIcon } from "@ion/design-system";
import type { ArtifactInfo } from "@ion/schema";
import { useEffect, useState } from "react";

/** How often the Files tab reads the chat's artifacts again while it's open (no faster than Tasks). */
const ARTIFACTS_MS = 5000;

const ICON: Record<ArtifactInfo["kind"], LucideIcon> = {
  image: ImageIcon,
  html: Globe,
  text: FileText,
  binary: FileIcon,
};

/** The files the chat's runs made, newest first, read again every few seconds while shown. */
function useArtifacts(client: IonClient, chatId: string): ArtifactInfo[] {
  const [made, setMade] = useState<ArtifactInfo[]>([]);
  useEffect(() => {
    let live = true;
    setMade([]);
    const read = () =>
      void client.call("chat.artifacts", { chatId }).then(
        (a) => live && setMade(a),
        () => {},
      );
    read();
    const timer = setInterval(read, ARTIFACTS_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, chatId]);
  return made;
}

/** "212 KB", "3.2 MB". */
function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "now", "5m ago", "3h ago", "2d ago". */
function agoText(iso: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(min) || min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / (60 * 24))}d ago`;
}

function Row({ a, onOpen }: { a: ArtifactInfo; onOpen: (path: string) => void }) {
  const cut = a.path.lastIndexOf("/");
  const name = a.path.slice(cut + 1);
  const sub = [a.path.slice(0, Math.max(cut, 0)), sizeText(a.size), agoText(a.changedAt)].filter(Boolean);
  const Icon = ICON[a.kind];
  // A binary file has nothing to show.
  const shown = a.kind !== "binary";
  return (
    <button type="button" className="mrow" title={a.path} disabled={!shown} onClick={() => onOpen(a.path)}>
      <Icon />
      <span className="g">
        {name}
        <small>{sub.join(" · ")}</small>
      </span>
    </button>
  );
}

/**
 * The lab's "In this chat": what the chat made that isn't among its changed files (a screenshot, a build, other
 * ignored outputs), newest first. Nothing made, no section.
 */
export function InChat(p: {
  client: IonClient;
  chatId: string;
  changed: string[];
  onOpen: (path: string) => void;
}) {
  const made = useArtifacts(p.client, p.chatId).filter((a) => !p.changed.includes(a.path));
  if (!made.length) return null;
  return (
    <div className="inchat">
      <div className="lh2">In this chat</div>
      {made.map((a) => (
        <Row key={a.path} a={a} onOpen={p.onOpen} />
      ))}
    </div>
  );
}
