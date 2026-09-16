import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  base: "/v2/",
  server: { proxy: { "/api/v2": "http://127.0.0.1:3100" } },
  build: { outDir: "../web-dist", emptyOutDir: true },
});
