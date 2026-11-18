import { MessageSquare } from "@ion/design-system";
import { useState } from "react";
import { Chats } from "./chats/Chats.js";
import { Down } from "./Down.js";
import { useIon } from "./ion.js";

/** The window: the rail, then the Chats screen (Ions, Library and Settings come in later plans). */
export function App() {
  const { state, client } = useIon();
  // The open chat outlives a dropped connection: after ion comes back you're where you were.
  const [openId, setOpenId] = useState<string | null>(null);
  if (state === "connecting") return <div className="app app--empty" />;
  if (state === "down" || !client) return <Down onRetry={() => window.location.reload()} />;
  return (
    <div className="app">
      <nav className="rail" aria-label="Screens">
        <button type="button" className="rail-item rail-item--on" aria-label="Chats">
          <MessageSquare size={18} />
        </button>
      </nav>
      <Chats client={client} openId={openId} setOpenId={setOpenId} />
    </div>
  );
}
