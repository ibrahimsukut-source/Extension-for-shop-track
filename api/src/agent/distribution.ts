// Self-hosted extension distribution (replaces the Chrome Web Store):
//   GET /ext/updates.xml   — Chrome's update manifest (polled every few hours)
//   GET /ext/:file.crx     — the signed package
// Built by `extension/scripts/pack.mjs` into a release dir with latest.json.
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DistributionOptions {
  releaseDir: string;
  publicUrl: string;
}

export async function extensionDistribution(app: FastifyInstance, opts: DistributionOptions): Promise<void> {
  const latest = async (): Promise<{ id: string; version: string; crx: string } | null> => {
    try {
      return JSON.parse(await readFile(path.join(opts.releaseDir, "latest.json"), "utf8"));
    } catch {
      return null;
    }
  };

  app.get("/ext/updates.xml", async (_req, reply) => {
    const l = await latest();
    if (!l) return reply.code(404).send("no release");
    const base = opts.publicUrl.replace(/\/+$/, "");
    const xml =
      `<?xml version='1.0' encoding='UTF-8'?>\n` +
      `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
      `  <app appid='${l.id}'>\n` +
      `    <updatecheck codebase='${base}/ext/${l.crx}' version='${l.version}' />\n` +
      `  </app>\n` +
      `</gupdate>\n`;
    return reply.type("application/xml").send(xml);
  });

  app.get("/ext/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^agent-[\d.]+\.crx$/.test(file)) return reply.code(404).send("not found");
    try {
      const buf = await readFile(path.join(opts.releaseDir, file));
      return reply.type("application/x-chrome-extension").send(buf);
    } catch {
      return reply.code(404).send("not found");
    }
  });
}
