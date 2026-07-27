import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 60006,
    proxy: {
      "/api": {
        target: process.env.ASMDB_WORKLOAD_API ?? "http://localhost:5002",
        changeOrigin: true,
      },
    },
  },
});
