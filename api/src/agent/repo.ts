// Data access for the agent/command-center layer (parameterized SQL, works on
// real Postgres and pg-mem).
import type { Pool, Queryable } from "../repository.js";
import { withTransaction } from "../repository.js";

export interface JobRow {
  id: number;
  shop_tag: string;
  kind: string;
  params: Record<string, unknown> | null;
  status: string;
  priority: number;
  origin: string | null;
  created_by: string | null;
  created_at: string;
  not_before: string | null;
  leased_at: string | null;
  lease_until: string | null;
  attempts: number;
  max_attempts: number;
  finished_at: string | null;
  result: unknown;
  error: string | null;
  suggestion_id: number | null;
}

export interface HeartbeatInput {
  agentId?: string | null;
  extVersion?: string | null;
  moduleVersion?: string | null;
  etsyShopId?: string | number | null;
  shopName?: string | null;
  loggedIn?: boolean | null;
  lastError?: string | null;
  state?: unknown;
}

const LEASE_MINUTES = 10;

export async function heartbeat(q: Queryable, shopTag: string, hb: HeartbeatInput): Promise<{ paused: boolean }> {
  const shopId = hb.etsyShopId != null && /^\d+$/.test(String(hb.etsyShopId)) ? String(hb.etsyShopId) : null;
  const res = await q.query(
    `INSERT INTO agents (shop_tag, agent_id, ext_version, module_version, etsy_shop_id, shop_name, logged_in, last_seen, last_error, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9::jsonb)
     ON CONFLICT (shop_tag) DO UPDATE SET
       agent_id = COALESCE(EXCLUDED.agent_id, agents.agent_id),
       ext_version = COALESCE(EXCLUDED.ext_version, agents.ext_version),
       module_version = COALESCE(EXCLUDED.module_version, agents.module_version),
       etsy_shop_id = COALESCE(EXCLUDED.etsy_shop_id, agents.etsy_shop_id),
       shop_name = COALESCE(EXCLUDED.shop_name, agents.shop_name),
       logged_in = EXCLUDED.logged_in,
       last_seen = now(),
       last_error = EXCLUDED.last_error,
       state = EXCLUDED.state
     RETURNING paused`,
    [
      shopTag,
      hb.agentId ?? null,
      hb.extVersion ?? null,
      hb.moduleVersion ?? null,
      shopId,
      hb.shopName ?? null,
      hb.loggedIn ?? null,
      hb.lastError ?? null,
      JSON.stringify(hb.state ?? null),
    ]
  );
  return { paused: Boolean(res.rows[0]?.paused) };
}

export async function setPaused(q: Queryable, shopTag: string, paused: boolean): Promise<void> {
  await q.query(
    `INSERT INTO agents (shop_tag, paused) VALUES ($1,$2)
     ON CONFLICT (shop_tag) DO UPDATE SET paused = EXCLUDED.paused`,
    [shopTag, paused]
  );
}

export async function createJob(
  q: Queryable,
  input: {
    shopTag: string;
    kind: string;
    params: unknown;
    origin?: string;
    createdBy?: string;
    priority?: number;
    notBefore?: string | null;
    suggestionId?: number | null;
  }
): Promise<JobRow> {
  const res = await q.query(
    `INSERT INTO agent_jobs (shop_tag, kind, params, origin, created_by, priority, not_before, suggestion_id)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.shopTag,
      input.kind,
      JSON.stringify(input.params ?? {}),
      input.origin ?? "manual",
      input.createdBy ?? null,
      input.priority ?? 0,
      input.notBefore ?? null,
      input.suggestionId ?? null,
    ]
  );
  return res.rows[0] as JobRow;
}

/** Requeue (or fail) jobs whose lease ran out — the agent died mid-job. */
export async function reapExpiredLeases(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE agent_jobs SET status = 'failed', error = 'lease expired', finished_at = now()
     WHERE status = 'leased' AND lease_until < now() AND attempts >= max_attempts`
  );
  await q.query(
    `UPDATE agent_jobs SET status = 'queued', leased_at = NULL, lease_until = NULL
     WHERE status = 'leased' AND lease_until < now() AND attempts < max_attempts`
  );
}

/**
 * Lease the next runnable job for a shop. Write jobs run before collection
 * (they're what the user is waiting for), then by priority, then FIFO.
 * The conditional UPDATE makes the lease safe even if two polls race.
 */
export async function leaseNextJob(pool: Pool, shopTag: string): Promise<JobRow | null> {
  return withTransaction(pool, async (c) => {
    await reapExpiredLeases(c);
    // One job at a time per shop: Etsy session + worker tab are shared.
    const busy = await c.query(`SELECT 1 FROM agent_jobs WHERE shop_tag = $1 AND status = 'leased' LIMIT 1`, [shopTag]);
    if (busy.rows.length) return null;
    const cand = await c.query(
      `SELECT id FROM agent_jobs
       WHERE shop_tag = $1 AND status = 'queued' AND (not_before IS NULL OR not_before <= now())
       ORDER BY (CASE WHEN kind LIKE 'ads.%' THEN 0 ELSE 1 END), priority DESC, id ASC
       LIMIT 1`,
      [shopTag]
    );
    if (!cand.rows.length) return null;
    const id = cand.rows[0].id as number;
    const upd = await c.query(
      `UPDATE agent_jobs SET status = 'leased', leased_at = now(),
         lease_until = now() + interval '${LEASE_MINUTES} minutes', attempts = attempts + 1
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id]
    );
    return (upd.rows[0] as JobRow) ?? null;
  });
}

export async function getJob(q: Queryable, id: number): Promise<JobRow | null> {
  const res = await q.query(`SELECT * FROM agent_jobs WHERE id = $1`, [id]);
  return (res.rows[0] as JobRow) ?? null;
}

export async function finishJob(
  q: Queryable,
  id: number,
  input: { ok: boolean; result?: unknown; error?: string | null }
): Promise<void> {
  await q.query(
    `UPDATE agent_jobs SET status = $2, result = $3::jsonb, error = $4, finished_at = now(), lease_until = NULL
     WHERE id = $1`,
    [id, input.ok ? "done" : "failed", JSON.stringify(input.result ?? null), input.error ?? null]
  );
}

export async function cancelJob(q: Queryable, id: number): Promise<boolean> {
  const res = await q.query(
    `UPDATE agent_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued' RETURNING id`,
    [id]
  );
  return res.rows.length > 0;
}

export async function listJobs(q: Queryable, opts: { shopTag?: string; limit?: number }): Promise<JobRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const res = opts.shopTag
    ? await q.query(`SELECT * FROM agent_jobs WHERE shop_tag = $1 ORDER BY id DESC LIMIT ${limit}`, [opts.shopTag])
    : await q.query(`SELECT * FROM agent_jobs ORDER BY id DESC LIMIT ${limit}`);
  return res.rows as JobRow[];
}

/** True when a job of this kind is queued/leased, or finished within `hours`. */
export async function hasRecentJob(q: Queryable, shopTag: string, kind: string, hours: number): Promise<boolean> {
  const res = await q.query(
    `SELECT 1 FROM agent_jobs WHERE shop_tag = $1 AND kind = $2 AND (
       status IN ('queued','leased') OR
       (status = 'done' AND finished_at > now() - ($3 || ' hours')::interval) OR
       (status = 'failed' AND finished_at > now() - interval '1 hours')
     ) LIMIT 1`,
    [shopTag, kind, String(hours)]
  );
  return res.rows.length > 0;
}

export async function logAction(
  q: Queryable,
  input: { jobId: number; shopTag: string; action: string; target: string | null; before: unknown; after: unknown; verified: boolean | null }
): Promise<void> {
  await q.query(
    `INSERT INTO action_log (job_id, shop_tag, action, target, before_state, after_state, verified)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [input.jobId, input.shopTag, input.action, input.target, JSON.stringify(input.before ?? null), JSON.stringify(input.after ?? null), input.verified]
  );
}

export async function listAgents(q: Queryable): Promise<any[]> {
  const res = await q.query(`SELECT * FROM agents ORDER BY shop_tag`);
  return res.rows;
}
