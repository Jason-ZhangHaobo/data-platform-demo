import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { publicContext } from "./src/v2/context.mjs";
import { publicAgentSamples } from "./web/src/agent-startup-samples";

const openingSamples = publicAgentSamples(["holdings-t1", "stock-cash-t1"].map(publicContext));
const openingTemplate = readFileSync(new URL("./web/agent-opening.html", import.meta.url), "utf8");

export default defineConfig({
  root: "web",
  base: "/v2/",
  plugins: [{
    name: "public-agent-opening",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (openingSamples.length !== 2) throw new Error("Public Agent opening fixtures unavailable");
        const json = JSON.stringify(openingSamples).replaceAll("<", "\\u003c");
        const opening = openingTemplate.replace("<!-- agent-opening-data -->", () => json);
        // A preceding stylesheet would block the parser's opening script.
        const stylesheets = html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
        return html.replace(/<link rel="stylesheet"[^>]*>/g, "")
          .replace("<!-- agent-opening -->", () => opening + stylesheets.join("\n"));
      },
    },
  }],
  server: { proxy: { "/api/v2": "http://127.0.0.1:3100" } },
  build: { outDir: "../web-dist", emptyOutDir: true },
});
