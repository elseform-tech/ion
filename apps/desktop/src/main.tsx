import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/sora/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@ion/design-system/tokens.css";
import "@ion/design-system/lab.css";
import "./app.css";
import "./chats/chat.css";
import "./chats/chats.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
