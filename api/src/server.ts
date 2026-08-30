// Fastify app factory. Auth (per-VPS Bearer token) + the three ingest routes.
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./config.js";
import type { Pool } from "./repository.js";
import { ingestApi, ingestEvents, ingestHttp } from "./service.js";
import { ingestApiBody, ingestEventBody, ingestHttpBody } from "./schemas.js";
import { getDashboardData } from "./dashboard_repo.js";
import { buildAnalysisSummary, toMarkdown } from "./analysis/summary.js";
import { scheduleParse } from "./parse/scheduler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(path.resolve(here, "../public/dashboard.html"), "utf8");

declare module "fastify" {
  interface FastifyRequest {
    shopTag?: string;
  }
}

export interface AppDeps {
  pool: Pool;
  config: Config;
}

function bearer(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

export function buildServer({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: 8 * 1024 * 1024, // internal API bodies can be large
  });

  // CORS: the extension's service worker forwards cross-origin (from
  // chrome-extension:// or https://www.etsy.com) to this local API. With
  // non-simple headers (Authorization + application/json) the browser sends a
  // preflight OPTIONS, which must succeed WITHOUT auth — otherwise the real POST
  // is never made. Runs before the auth preHandler and answers preflight itself.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", request.headers.origin ?? "*");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "authorization, content-type");
    reply.header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  // Unauthenticated liveness probe.
  app.get("/health", async () => ({ ok: true }));

  // ── Local dashboard (read-only). Gated by DASHBOARD_KEY when set. ─────────
  app.get("/", async (_req, reply) => reply.type("text/html").send(DASHBOARD_HTML));
  app.get("/dashboard/data", async (request, reply) => {
    if (config.dashboardKey) {
      const key = (request.query as { key?: string } | undefined)?.key;
      if (key !== config.dashboardKey) return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send(await getDashboardData(pool));
  });

  // AI structured summary export (spec §9) — everything the causal engine has
  // computed, as JSON (default) or Markdown (?format=md) ready to paste into
  // an LLM conversation. Same gate as the dashboard.
  app.get("/analysis/summary", async (request, reply) => {
    const query = request.query as { key?: string; format?: string } | undefined;
    if (config.dashboardKey && query?.key !== config.dashboardKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const summary = await buildAnalysisSummary(pool);
    if (query?.format === "md" || query?.format === "markdown") {
      return reply.type("text/markdown; charset=utf-8").send(toMarkdown(summary));
    }
    return reply.send(summary);
  });

  // Auth for every /ingest/* route: resolve token -> shop_tag (spec §9).
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/ingest/")) return;
    const token = bearer(request);
    const shopTag = token ? config.tokenToShop.get(token) : undefined;
    if (!shopTag) {
      reply.code(401).send({ error: "unauthorized" });
      return reply; // stop the chain
    }
    request.shopTag = shopTag;
  });

  // Enforce the batch cap uniformly.
  const guardBatchSize = (n: number, reply: import("fastify").FastifyReply): boolean => {
    if (n > config.maxBatch) {
      reply.code(413).send({ error: "batch too large", maxBatch: config.maxBatch });
      return false;
    }
    return true;
  };

  const badRequest = (reply: import("fastify").FastifyReply, err: z.ZodError) =>
    reply.code(400).send({ error: "invalid payload", issues: err.issues });

  app.post("/ingest/http", async (request, reply) => {
    const parsed = ingestHttpBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.records.length, reply)) return reply;
    const result = await ingestHttp(pool, request.shopTag!, parsed.data.records);
    if (config.autoParse) scheduleParse(pool);
    return reply.code(202).send(result);
  });

  app.post("/ingest/event", async (request, reply) => {
    const parsed = ingestEventBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.events.length, reply)) return reply;
    const result = await ingestEvents(pool, request.shopTag!, parsed.data.events);
    return reply.code(202).send(result);
  });

  app.post("/ingest/api", async (request, reply) => {
    const parsed = ingestApiBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.records.length, reply)) return reply;
    const result = await ingestApi(pool, request.shopTag!, parsed.data.records);
    if (config.autoParse) scheduleParse(pool);
    return reply.code(202).send(result);
  });

  return app;
}
