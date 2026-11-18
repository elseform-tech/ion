import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built files; in dev it loads Vite's server on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: { target: "safari16", outDir: "dist" },
});
