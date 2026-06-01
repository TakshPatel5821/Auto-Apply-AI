import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests target the PURE logic modules (classification, validation, dropdown
// matching, profile resolution) — no DB, no browser. The `@/` alias matches the
// app so tests can import modules the same way the app does.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
