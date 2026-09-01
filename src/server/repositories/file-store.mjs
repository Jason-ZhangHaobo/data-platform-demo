import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MemoryTaskStore } from "./memory-store.mjs";
import { createSeedState } from "./store.mjs";

export class FileTaskStore extends MemoryTaskStore {
  constructor(filePath, state) { super(state); this.filePath = filePath; }
  static async open(filePath) {
    try { return new FileTaskStore(filePath, JSON.parse(await readFile(filePath, "utf8"))); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const store = new FileTaskStore(filePath, createSeedState()); await store.persist(); return store;
    }
  }
  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
