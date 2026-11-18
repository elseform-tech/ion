import { MessageSquare, Settings } from "@ion/design-system";

/** The window: the rail, the Chats sidebar and the open chat. */
export function App() {
  return (
    <div className="app">
      <nav className="rail" aria-label="Screens">
        <button type="button" className="rail-item rail-item--on" aria-label="Chats">
          <MessageSquare size={18} />
        </button>
        <div className="rail-end">
          <button type="button" className="rail-item" aria-label="Settings">
            <Settings size={18} />
          </button>
        </div>
      </nav>
      <aside className="sidebar" aria-label="Chats" />
      <main className="main" />
    </div>
  );
}
