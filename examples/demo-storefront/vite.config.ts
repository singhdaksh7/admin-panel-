import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Workspace dev: resolve the SDK straight from its TypeScript source (no build step needed).
// A standalone app that installs the published package does not need this alias.
const sdk = fileURLToPath(new URL("../../packages/storefront-sdk/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@kash-commerce/storefront-sdk": sdk } },
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
