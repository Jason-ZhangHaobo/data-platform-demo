import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path)); else files.push(path);
  }
  return files;
}

const files = [...await filesUnder("src"), ...await filesUnder("scripts"), ...await filesUnder("test")];
for (const file of files.filter((path) => path.endsWith(".mjs"))) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax check failed: ${file}`);
}
const forbidden = [/AKID[A-Za-z0-9]{12,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/];
for (const file of files) {
  const content = await readFile(file, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) throw new Error(`Possible secret found in ${file}`);
}
console.log(`Source checks passed for ${files.length} files.`);
