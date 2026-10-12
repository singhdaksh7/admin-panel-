import { defineConfig } from "tsup";

/**
 * Bundles the API + its workspace packages into dist/. Third-party deps (prisma client, argon2 native,
 * express...) stay external and are resolved from node_modules at runtime.
 */
export default defineConfig({
  entry: ["src/server.ts", "src/cli/create-admin.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  noExternal: [
    "@kash-commerce/shared",
    "@kash-commerce/config",
    "@kash-commerce/contracts",
    "@kash-commerce/provider-sdk",
    "@kash-commerce/database",
  ],
  // @prisma/client must remain external (generated client + native engine)
  external: ["@prisma/client", ".prisma/client"],
});
