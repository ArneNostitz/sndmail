import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { collectBuildInfo } from "./scripts/build-info.mjs";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_INFO__: JSON.stringify(collectBuildInfo()),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
});
