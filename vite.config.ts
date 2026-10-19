import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { collectBuildInfo } from "./scripts/build-info.mjs";

const host = process.env.TAURI_DEV_HOST;

// The dev server port can be overridden per workspace (Superset reserves a free
// port for every workspace and sets VITE_DEV_PORT), so parallel workspaces do
// not fight over 1420. The Tauri dev URL follows it (see .superset/run.sh).
const devPort = Number(process.env.VITE_DEV_PORT ?? 1420);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_INFO__: JSON.stringify(collectBuildInfo()),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        splashscreen: path.resolve(__dirname, "splashscreen.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort + 1,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
