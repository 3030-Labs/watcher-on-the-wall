import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "daemon/entry": "src/daemon/entry.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  banner: ({ format }) => {
    if (format === "esm") {
      return { js: "#!/usr/bin/env node" };
    }
    return {};
  },
  esbuildOptions(options) {
    options.keepNames = true;
  },
  async onSuccess() {
    // Copy wiki templates into dist so `wotw init` can read them at runtime.
    const src = resolve("src/wiki/templates");
    const dst = resolve("dist/wiki/templates");
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  },
});
