// Regression test for the storage read-modify-write race: many captures
// arriving at once must all be retained (none clobbered). Mocks chrome.storage
// with a deliberate get/set delay to widen the race window; the mutex in
// lib/lock.ts must serialize the writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadStore() {
  const out = path.join(here, ".store.bundle.mjs");
  await esbuild.build({
    stdin: {
      contents: `export { pushRecent, getRecent, pushAll, getAll } from "../src/lib/store.ts";`,
      resolveDir: here,
      loader: "ts",
    },
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  await rm(out, { force: true });
  return mod;
}

function installChromeMock(delayMs = 1) {
  const mem = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key) =>
          new Promise((r) => setTimeout(() => r({ [key]: mem[key] }), delayMs)),
        set: (obj) =>
          new Promise((r) =>
            setTimeout(() => {
              Object.assign(mem, obj);
              r();
            }, delayMs)
          ),
        remove: (key) =>
          new Promise((r) => {
            delete mem[key];
            r();
          }),
      },
    },
  };
}

const store = await loadStore();

test("pushRecent: 50 concurrent writes lose nothing (mutex serializes RMW)", async () => {
  installChromeMock(1);
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.pushRecent({
        captureType: "stats",
        source: "extension",
        method: "GET",
        url: `https://www.etsy.com/x/${i}`,
        status: 200,
        shopId: "1",
        shopTag: null,
        vpsHost: null,
        chromeProfile: null,
        body: { i },
        capturedAt: "2026-08-27T10:00:00.000Z",
        dedupKey: `dk_${i}`,
      })
    )
  );
  const recent = await store.getRecent();
  assert.equal(recent.length, N, "all concurrent captures retained");
  assert.equal(new Set(recent.map((r) => r.dedupKey)).size, N, "no duplicates/clobbering");
});

test("pushAll: concurrent diagnostic writes lose nothing", async () => {
  installChromeMock(1);
  const N = 30;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.pushAll({ url: `u${i}`, method: "GET", status: 200, captureType: "unmatched", preview: "", ts: i })
    )
  );
  assert.equal((await store.getAll()).length, N);
});
