// Command-center HTTP surface, as a Fastify plugin so it can run inside this
// API or be mounted into another Fastify app (magaza-crm) unchanged.
//
//   /agent/v1/*  — called by the extension in each shop's Chrome (Bearer = the shop's token)
//   /admin/v1/*  — called by the command-center UI (x-admin-key = ADMIN_KEY)
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "../repository.js";
import { validateJob, type SafetyLimits, isWriteJob } from "./jobs.js";
import {
  cancelJob,
  createJob,
  finishJob,
  getJob,
  hasRecentJob,
  heartbeat,
  leaseNextJob,
  listAgents,
  listJobs,
  setPaused,
} from "./repo.js";
import { processJobResult } from "./results.js";
import { refreshSuggestions, type RuleConfig } from "./rules.js";
import type { ModuleStore } from "./modules.js";

export interface AgentHubOptions {
  pool: Pool;
  /** token -> shop_tag */
  tokenToShop: Map<string, string>;
  /** Admin key for /admin/v1; empty = open (local dev only). */
  adminKey: string;
  limits: SafetyLimits;
  rules: RuleConfig;
  /** Auto-collect each shop every N hours (0 = only on command). */
  collectEveryHours: number;
  pollSeconds: number;
  modules?: ModuleStore;
  /** Called after a result fed raw captures into the ingest pipeline. */
  onIngest?: () => void;
}

const heartbeatBody = z.object({
  agentId: z.string().max(100).nullish(),
  extVersion: z.string().max(40).nullish(),
  moduleVersion: z.string().max(40).nullish(),
  etsyShopId: z.union([z.string(), z.number()]).nullish(),
  shopName: z.string().max(100).nullish(),
  loggedIn: z.boolean().nullish(),
  lastError: z.string().max(2000).nullish(),
  state: z.unknown().optional(),
});

const resultBody = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(5000).nullish(),
});

const createJobBody = z.object({
  shopTag: z.string().min(1),
  kind: z.string().min(1),
  params: z.unknown().optional(),
  priority: z.number().int().min(-10).max(10).optional(),
});

function bearer(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1].trim() : null;
}

export async function agentHub(app: FastifyInstance, opts: AgentHubOptions): Promise<void> {
  const { pool } = opts;

  const shopOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const tok = bearer(req);
    const tag = tok ? opts.tokenToShop.get(tok) : undefined;
    if (!tag) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return tag;
  };
  const isAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!opts.adminKey) return true;
    const key = (req.headers["x-admin-key"] as string | undefined) ?? (req.query as any)?.key;
    if (key === opts.adminKey) return true;
    reply.code(401).send({ error: "unauthorized" });
    return false;
  };

  async function autoSchedule(shopTag: string): Promise<void> {
    if (opts.collectEveryHours <= 0) return;
    for (const kind of ["collect.ads", "collect.shop_stats"]) {
      if (!(await hasRecentJob(pool, shopTag, kind, opts.collectEveryHours))) {
        await createJob(pool, { shopTag, kind, params: {}, origin: "schedule", priority: -1 });
      }
    }
  }

  // ── Agent side ────────────────────────────────────────────────────────────
  app.post("/agent/v1/poll", async (req, reply) => {
    const shopTag = shopOf(req, reply);
    if (!shopTag) return reply;
    const hb = heartbeatBody.safeParse(req.body ?? {});
    if (!hb.success) return reply.code(400).send({ error: "invalid heartbeat" });
    const { paused } = await heartbeat(pool, shopTag, hb.data);
    const base = {
      pollSeconds: opts.pollSeconds,
      paused,
      modules: opts.modules ? await opts.modules.manifest() : null,
    };
    if (paused) return reply.send({ ...base, job: null });
    // Don't schedule collection while logged out — it would only fail.
    if (hb.data.loggedIn !== false) await autoSchedule(shopTag);
    else return reply.send({ ...base, job: null });
    const job = await leaseNextJob(pool, shopTag);
    return reply.send({
      ...base,
      job: job ? { id: job.id, kind: job.kind, params: job.params ?? {}, attempt: job.attempts } : null,
    });
  });

  app.post("/agent/v1/jobs/:id/result", async (req, reply) => {
    const shopTag = shopOf(req, reply);
    if (!shopTag) return reply;
    const id = Number((req.params as any).id);
    const job = await getJob(pool, id);
    if (!job || job.shop_tag !== shopTag) return reply.code(404).send({ error: "no such job" });
    if (job.status !== "leased") return reply.code(409).send({ error: `job is ${job.status}` });
    const body = resultBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid result" });
    let summary: Record<string, unknown> = {};
    let error = body.data.error ?? null;
    let ok = body.data.ok;
    try {
      // Write jobs may report partial success: store what was done either way.
      if (body.data.result !== undefined) summary = await processJobResult(pool, job, body.data.result);
    } catch (e) {
      ok = false;
      error = `result processing failed: ${(e as Error).message}`;
      req.log.error(e);
    }
    await finishJob(pool, id, { ok, result: { summary }, error });
    opts.onIngest?.();
    if (job.suggestion_id) {
      await pool.query(`UPDATE suggestions SET status = $2 WHERE id = $1`, [job.suggestion_id, ok ? "done" : "failed"]);
    }
    if (ok && job.kind === "collect.ads") await refreshSuggestions(pool, shopTag, opts.rules);
    return reply.send({ ok: true, summary });
  });

  if (opts.modules) {
    const modules = opts.modules;
    app.get("/agent/v1/modules/:name", async (req, reply) => {
      const shopTag = shopOf(req, reply);
      if (!shopTag) return reply;
      const mod = await modules.get((req.params as any).name);
      if (!mod) return reply.code(404).send({ error: "no such module" });
      return reply.send(mod);
    });
  }

  // ── Admin side ────────────────────────────────────────────────────────────
  app.get("/admin/v1/overview", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const agents = await listAgents(pool);
    const campaigns = (await pool.query(`SELECT * FROM ads_campaign_latest`)).rows;
    const stats = (await pool.query(`SELECT * FROM shop_stats_latest WHERE range_key = 'last_30'`)).rows;
    const sugg = (await pool.query(`SELECT shop_tag, COUNT(*)::int AS n FROM suggestions WHERE status = 'open' GROUP BY shop_tag`)).rows;
    const jobs = (
      await pool.query(`SELECT shop_tag, status, COUNT(*)::int AS n FROM agent_jobs WHERE status IN ('queued','leased') GROUP BY shop_tag, status`)
    ).rows;
    const tags = new Set<string>([...opts.tokenToShop.values(), ...agents.map((a: any) => a.shop_tag)]);
    const shops = [...tags].sort().map((tag) => ({
      shopTag: tag,
      agent: agents.find((a: any) => a.shop_tag === tag) ?? null,
      campaign: campaigns.find((c: any) => c.shop_tag === tag) ?? null,
      stats30: stats.find((s: any) => s.shop_tag === tag) ?? null,
      openSuggestions: sugg.find((s: any) => s.shop_tag === tag)?.n ?? 0,
      queued: jobs.filter((j: any) => j.shop_tag === tag).reduce((n: number, j: any) => n + j.n, 0),
    }));
    return reply.send({ shops, limits: opts.limits, now: new Date().toISOString() });
  });

  app.get("/admin/v1/shops/:tag/ads", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tag = (req.params as any).tag as string;
    const campaign = (await pool.query(`SELECT * FROM ads_campaign_latest WHERE shop_tag = $1`, [tag])).rows[0] ?? null;
    const listings = (
      await pool.query(`SELECT * FROM ads_listing_latest WHERE shop_tag = $1 ORDER BY spend_cents DESC NULLS LAST, listing_id`, [tag])
    ).rows;
    const qcount = (
      await pool.query(`SELECT listing_id, COUNT(*)::int AS n FROM ads_query_latest WHERE shop_tag = $1 GROUP BY listing_id`, [tag])
    ).rows;
    return reply.send({ campaign, listings, queryCounts: Object.fromEntries(qcount.map((r: any) => [String(r.listing_id), r.n])) });
  });

  app.get("/admin/v1/shops/:tag/queries", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tag = (req.params as any).tag as string;
    const lid = (req.query as any)?.listing_id;
    const rows = lid
      ? (await pool.query(`SELECT * FROM ads_query_latest WHERE shop_tag = $1 AND listing_id = $2 ORDER BY cost_cents DESC NULLS LAST`, [tag, Number(lid)])).rows
      : (await pool.query(`SELECT * FROM ads_query_latest WHERE shop_tag = $1 ORDER BY cost_cents DESC NULLS LAST LIMIT 500`, [tag])).rows;
    return reply.send({ queries: rows });
  });

  app.get("/admin/v1/shops/:tag/stats", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tag = (req.params as any).tag as string;
    const rows = (await pool.query(`SELECT * FROM shop_stats_latest WHERE shop_tag = $1`, [tag])).rows;
    return reply.send({ stats: rows });
  });

  app.get("/admin/v1/suggestions", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tag = (req.query as any)?.shop_tag;
    const rows = tag
      ? (await pool.query(`SELECT * FROM suggestions WHERE shop_tag = $1 AND status = 'open' ORDER BY id DESC`, [tag])).rows
      : (await pool.query(`SELECT * FROM suggestions WHERE status = 'open' ORDER BY shop_tag, id DESC`)).rows;
    return reply.send({ suggestions: rows });
  });

  app.post("/admin/v1/suggestions/:id/:decision", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const { id, decision } = req.params as { id: string; decision: string };
    const s = (await pool.query(`SELECT * FROM suggestions WHERE id = $1`, [Number(id)])).rows[0];
    if (!s) return reply.code(404).send({ error: "no such suggestion" });
    if (s.status !== "open") return reply.code(409).send({ error: `suggestion is ${s.status}` });
    if (decision === "dismiss") {
      await pool.query(`UPDATE suggestions SET status = 'dismissed', decided_at = now() WHERE id = $1`, [s.id]);
      return reply.send({ ok: true });
    }
    if (decision !== "accept") return reply.code(400).send({ error: "decision must be accept|dismiss" });
    const v = validateJob(s.kind, s.params, opts.limits);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const job = await createJob(pool, { shopTag: s.shop_tag, kind: v.kind, params: v.params, origin: "suggestion", createdBy: "admin", suggestionId: s.id, priority: 5 });
    await pool.query(`UPDATE suggestions SET status = 'accepted', decided_at = now(), job_id = $2 WHERE id = $1`, [s.id, job.id]);
    return reply.send({ ok: true, job });
  });

  app.post("/admin/v1/rules/run", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tags = (await pool.query(`SELECT shop_tag FROM ads_campaign_latest`)).rows.map((r: any) => r.shop_tag as string);
    const out: Record<string, unknown> = {};
    for (const t of tags) out[t] = await refreshSuggestions(pool, t, opts.rules);
    return reply.send(out);
  });

  app.get("/admin/v1/jobs", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const q = req.query as any;
    return reply.send({ jobs: await listJobs(pool, { shopTag: q?.shop_tag, limit: Number(q?.limit ?? 50) }) });
  });

  app.post("/admin/v1/jobs", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const body = createJobBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid job", issues: body.error.issues });
    const known = new Set([...opts.tokenToShop.values()]);
    if (!known.has(body.data.shopTag)) return reply.code(400).send({ error: "unknown shop" });
    const v = validateJob(body.data.kind, body.data.params, opts.limits);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const job = await createJob(pool, {
      shopTag: body.data.shopTag,
      kind: v.kind,
      params: v.params,
      origin: "manual",
      createdBy: "admin",
      priority: body.data.priority ?? (isWriteJob(v.kind) ? 5 : 0),
    });
    return reply.code(201).send({ job });
  });

  app.post("/admin/v1/jobs/:id/cancel", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const ok = await cancelJob(pool, Number((req.params as any).id));
    return ok ? reply.send({ ok: true }) : reply.code(409).send({ error: "only queued jobs can be cancelled" });
  });

  app.get("/admin/v1/actions", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const tag = (req.query as any)?.shop_tag;
    const rows = tag
      ? (await pool.query(`SELECT * FROM action_log WHERE shop_tag = $1 ORDER BY id DESC LIMIT 200`, [tag])).rows
      : (await pool.query(`SELECT * FROM action_log ORDER BY id DESC LIMIT 200`)).rows;
    return reply.send({ actions: rows });
  });

  app.post("/admin/v1/agents/:tag/pause", async (req, reply) => {
    if (!isAdmin(req, reply)) return reply;
    const paused = Boolean((req.body as any)?.paused ?? true);
    await setPaused(pool, (req.params as any).tag, paused);
    return reply.send({ ok: true, paused });
  });
}
