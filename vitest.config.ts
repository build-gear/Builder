import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/tests/**/*.spec.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
