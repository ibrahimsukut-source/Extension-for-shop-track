// Build script for the Etsy Shop Tracker MV3 extension.
// Bundles each entry point separately (MV3 content scripts / SW cannot share
// an ES module graph at runtime) and copies static assets into dist/.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, "dist");
const watch = process.argv.includes("--watch");

// Each entry is emitted as an IIFE with a stable, manifest-referenced name.
const entries = {
  interceptor: "src/interceptor.ts", // MAIN world
  bridge: "src/bridge.ts", // ISOLATED world (message relay)
  actions: "src/content/actions.ts", // ISOLATED world (DOM action capture)
  background: "src/background.ts", // service worker
  options: "src/options.ts", // options page
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: "chrome111", // world: "MAIN" content scripts require Chrome 111+
  logLevel: "info",
  loader: { ".json": "json" },
};

async function copyStatic() {
  await cp(path.join(root, "src/manifest.json"), path.join(outdir, "manifest.json"));
  await cp(path.join(root, "src/options.html"), path.join(outdir, "options.html"));
  const publicDir = path.join(root, "public");
  if (existsSync(publicDir)) {
    await cp(publicDir, path.join(outdir, "public"), { recursive: true });
  }
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const contexts = await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      esbuild.context({
        ...common,
        entryPoints: [path.join(root, entry)],
        outfile: path.join(outdir, `${name}.js`),
      })
    )
  );

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStatic();
    console.log("[build] watching for changes…");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    await copyStatic();
    console.log("[build] done →", path.relative(root, outdir));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
