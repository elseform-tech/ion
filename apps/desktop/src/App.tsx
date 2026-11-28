import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Chats } from "./chats/Chats.js";
import { Down } from "./Down.js";
import { Frame, useSidebar } from "./Frame.js";
import { openSettings, useSettingsAt } from "./goto.js";
import { Ions } from "./ions/Ions.js";
import { useIon } from "./ion.js";
import { useSystemNotifications } from "./notify.js";
import { type Mode, Rail, useNeedCount } from "./Rail.js";
import { openSearch, type Place, Search } from "./Search.js";
import { Settings } from "./settings/Settings.js";

/** The first letter of your account's name, for the rail (the lab's "Y"). */
function useInitial(): string {
  const [initial, setInitial] = useState("Y");
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) void invoke<string>("user_initial").then(setInitial, () => {});
  }, []);
  return initial;
}

/** Opens a chat a notification is about: an ion's chat on the Ions screen, any other on Chats. */
function openChat(
  chatId: string,
  go: { setIonId: (id: string) => void; setOpenId: (id: string | null) => void; setMode: (m: Mode) => void },
) {
  const ion = chatId.startsWith("ion:") ? chatId.slice(4) : null;
  if (ion) go.setIonId(ion);
  else go.setOpenId(chatId);
  go.setMode(ion ? "ions" : "chats");
}

/** Goes where a search result points (Plan 21 Task 4: Search reaches every screen). */
function goTo(to: Place, go: Parameters<typeof openChat>[1]) {
  if (to.kind === "settings") return openSettings(to.page, to.more);
  if (to.kind === "chat") return openChat(to.chatId, go);
  if (to.kind === "ion") return openChat(`ion:${to.ionId}`, go);
  if (to.kind === "new") go.setOpenId(null);
  go.setMode(to.kind === "ions" ? "ions" : "chats");
}

/** The chat on screen: the open chat on Chats, the open ion's chat on Ions, none elsewhere. */
function watched(mode: Mode, openId: string | null, ionId: string): string | null {
  if (mode === "chats") return openId;
  return mode === "ions" ? `ion:${ionId}` : null;
}

/**
 * The window, as the design lab draws it: the rail (the window's own buttons sit in its top strip), then the
 * Chats, Ions or Settings screen. ion's notifications show as the system's own; clicking one opens its chat.
 */
export function App() {
  const { state, client } = useIon();
  const initial = useInitial();
  const needs = useNeedCount(client);
  // The open chat outlives a dropped connection: after ion comes back you're where you were.
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("chats");
  // The ion the Ions screen opens on (Settings' "Open chat" picks one).
  const [ionId, setIonId] = useState("chief");
  const [sidebar, toggleSidebar] = useSidebar();
  const [settingsAt, settingsKey] = useSettingsAt(mode, setMode);
  // The chat on screen: no system notification for it while the window has focus.
  const watching = watched(mode, openId, ionId);
  const go = { setIonId, setOpenId, setMode };
  useSystemNotifications(client, (chatId) => openChat(chatId, go), watching);
  if (state === "connecting") return <div className="app--empty" />;
  if (state === "down" || state === "starting" || !client)
    return <Down onRetry={() => window.location.reload()} starting={state === "starting"} />;
  return (
    <div className={`win${sidebar ? "" : " side-off"}`}>
      <Rail mode={mode} setMode={setMode} initial={initial} needs={needs} onSearch={openSearch} />
      <div className="body">
        <Frame sidebar={sidebar} onSidebar={toggleSidebar} />
        {mode === "chats" && (
          <div className="mode chats">
            <Chats client={client} openId={openId} setOpenId={setOpenId} />
          </div>
        )}
        {mode === "ions" && (
          <div className="mode ions">
            <Ions key={ionId} client={client} start={ionId} onOpenChat={(chatId) => openChat(chatId, go)} />
          </div>
        )}
        {mode === "settings" && (
          <div className="mode settings">
            <Settings
              key={settingsKey}
              client={client}
              at={settingsAt}
              onOpenIon={(id) => openChat(`ion:${id}`, go)}
            />
          </div>
        )}
      </div>
      <Search client={client} go={(to) => goTo(to, go)} />
    </div>
  );
}
