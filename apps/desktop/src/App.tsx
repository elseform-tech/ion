import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Chats } from "./chats/Chats.js";
import { Down } from "./Down.js";
import { Ions } from "./ions/Ions.js";
import { useIon } from "./ion.js";
import { type Mode, Rail, useNeedCount } from "./Rail.js";

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
 * Chats or the Ions screen. Search and Settings join the rail when they exist.
 */
export function App() {
  const { state, client } = useIon();
  const initial = useInitial();
  const needs = useNeedCount(client);
  // The open chat outlives a dropped connection: after ion comes back you're where you were.
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("chats");
  if (state === "connecting") return <div className="app--empty" />;
  if (state === "down" || !client) return <Down onRetry={() => window.location.reload()} />;
  return (
    <div className="win">
      <Rail mode={mode} setMode={setMode} initial={initial} needs={needs} />
      <div className="body">
        {mode === "chats" ? (
          <div className="mode chats">
            <Chats client={client} openId={openId} setOpenId={setOpenId} />
          </div>
        ) : (
          <div className="mode ions">
            <Ions
              client={client}
              onOpenChat={(chatId) => {
                setOpenId(chatId);
                setMode("chats");
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
