import { cp, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src", "dist", { recursive: true });
await writeFile("dist/build-meta.json", JSON.stringify({ builtAt: new Date().toISOString(), runtime: process.version }, null, 2));
console.log("Production artifact created in dist/.");
