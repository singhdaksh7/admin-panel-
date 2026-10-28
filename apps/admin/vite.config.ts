import fs from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fs.realpathSync(process.cwd()),
  plugins: [react()],
  server: {
    fs: { strict: false },
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"], globals: false, css: false },
});
