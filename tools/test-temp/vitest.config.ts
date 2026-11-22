import { defineConfig } from "vitest/config";

// Its own test runs without the setup it tests (that would swap TMPDIR under it).
export default defineConfig({ test: {} });
