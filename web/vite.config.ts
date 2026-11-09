import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, fs: { allow: [".."] }, proxy: { "/api": "http://localhost:4320", "/hooks": "http://localhost:4320" } },
});
