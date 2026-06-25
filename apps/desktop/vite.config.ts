import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(dirname, "package.json"), "utf8")) as {
  version?: unknown;
};
const appVersion = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILDER_GEAR_APP_VERSION__: JSON.stringify(appVersion)
  },
  resolve: {
    alias: {
      "@builder/core/browser": path.resolve(dirname, "../../packages/core/src/browser.ts")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"]
    }
  },
  clearScreen: false
});
