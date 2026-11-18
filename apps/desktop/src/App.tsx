import { MessageSquare } from "@ion/design-system";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Chats } from "./chats/Chats.js";
import { Down } from "./Down.js";
import { useIon } from "./ion.js";

/** The first letter of your account's name, for the rail (the lab's "Y"). */
function useInitial(): string {
  const [initial, setInitial] = useState("Y");
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) void invoke<string>("user_initial").then(setInitial, () => {});
  }, []);
  return initial;
}

/**
 * The window, as the design lab draws it: the rail (the window's own buttons sit in its top strip), then the
 * Chats screen. Ions, Search and Settings join the rail when they exist.
 */
export function App() {
  const { state, client } = useIon();
  const initial = useInitial();
  // The open chat outlives a dropped connection: after ion comes back you're where you were.
  const [openId, setOpenId] = useState<string | null>(null);
  if (state === "connecting") return <div className="app--empty" />;
  if (state === "down" || !client) return <Down onRetry={() => window.location.reload()} />;
  return (
    <div className="win">
      <nav className="rail" aria-label="App">
        <div className="lights" aria-hidden="true" data-tauri-drag-region />
        <button className="rb on" type="button" title="Chats">
          <MessageSquare />
        </button>
        <span className="grow" />
        <span className="me" title="You">
          {initial}
        </span>
      </nav>
      <div className="body">
        <div className="mode chats">
          <Chats client={client} openId={openId} setOpenId={setOpenId} />
        </div>
      </div>
    </div>
  );
}
