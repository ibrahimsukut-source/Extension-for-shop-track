// clean_window_flagger (spec §7): marks each intervention's is_clean_window —
// false when another intervention (on the same entity, or ANY shop-wide one)
// falls within its comparison window, since the effect estimator can't then
// attribute a metric change to this one change alone. A shop-wide intervention
// (entity_type='shop', e.g. ad_budget_changed) is treated as reaching every
// entity; a shop-wide intervention itself is marked dirty by ANY overlapping
// intervention, since its effect is shop-wide by definition.
import type { Queryable } from "../repository.js";

/** Recompute is_clean_window for every intervention in the shop. Returns count checked. */
export async function flagCleanWindows(q: Queryable, shopId: number, windowDays = 14): Promise<number> {
  const res = await q.query(
    `SELECT id, entity_type, entity_id, occurred_at FROM interventions WHERE shop_id=$1`,
    [shopId]
  );
  const rows = res.rows.map((r) => ({
    id: Number(r.id),
    entityType: String(r.entity_type ?? ""),
    entityId: r.entity_id === null || r.entity_id === undefined ? null : String(r.entity_id),
    occurredAtMs: new Date(r.occurred_at).getTime(),
  }));
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const a of rows) {
    const overlapping = rows.some(
      (b) =>
        b.id !== a.id &&
        Math.abs(b.occurredAtMs - a.occurredAtMs) <= windowMs &&
        (b.entityType === "shop" || a.entityType === "shop" || (b.entityType === a.entityType && b.entityId === a.entityId))
    );
    await q.query(`UPDATE interventions SET is_clean_window=$1 WHERE id=$2`, [!overlapping, a.id]);
  }
  return rows.length;
}
