import { PanelLeft } from "@ion/design-system";
import { useEffect, useState } from "react";
import { hit } from "./hotkeys.js";

/** Whether the screen's left panel shows: one choice for the window, like the chat's side panel. */
export function useSidebar(): [boolean, () => void] {
  const [open, setOpen] = useState(true);
  const toggle = () => setOpen((was) => !was);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hit("sidebar", e)) {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return [open, toggle];
}

/** The strip along the window's top (you drag the window by it): the sidebar's button. */
export function Frame({ sidebar, onSidebar }: { sidebar: boolean; onSidebar: () => void }) {
  const label = `${sidebar ? "Hide" : "Show"} sidebar`;
  return (
    <header className="frame" data-tauri-drag-region>
      <button className="ib" type="button" aria-label={label} title={`${label}  ⌘B`} onClick={onSidebar}>
        <PanelLeft />
      </button>
    </header>
  );
}
