import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  noExternal: ["@builder/core"],
  external: ["better-sqlite3"]
});
