// Upserts for the normalized tables populated by parsers (Phase 3). All are
// idempotent so re-parsing raw_captures never double-counts. JSONB columns are
// passed as JSON strings cast to ::jsonb.
import type { Queryable } from "./repository.js";
import type {
  AdsDailyRow,
  ListingSnapshotRow,
  ListingStatsDailyRow,
  MessageRow,
  MessageThreadRow,
  OrderRow,
  ReviewRow,
  StatsDailyRow,
} from "./parsers/types.js";
import type { PriorSnapshot } from "./parse/diff.js";

const j = (v: unknown) => JSON.stringify(v ?? null);

export interface UnparsedCapture {
  id: number;
  shopId: number;
  captureType: string;
  body: unknown;
  capturedAt: string;
}

/** Fetch a chronological batch of unparsed captures for the given types. */
export async function getUnparsedCaptures(
  q: Queryable,
  types: string[],
  limit: number
): Promise<UnparsedCapture[]> {
  if (types.length === 0) return [];
  const placeholders = types.map((_, i) => `$${i + 2}`).join(",");
  const res = await q.query(
    `SELECT id, shop_id, capture_type, body, captured_at
       FROM raw_captures
      WHERE parsed = false AND capture_type IN (${placeholders})
      ORDER BY captured_at ASC, id ASC
      LIMIT $1`,
    [limit, ...types]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    shopId: Number(r.shop_id),
    captureType: String(r.capture_type),
    body: r.body,
    capturedAt: new Date(r.captured_at).toISOString(),
  }));
}

export async function markParsed(q: Queryable, id: number): Promise<void> {
  await q.query(`UPDATE raw_captures SET parsed = true WHERE id = $1`, [id]);
}

export async function upsertStatsDaily(q: Queryable, shopId: number, capturedAt: string, r: StatsDailyRow): Promise<void> {
  await q.query(
    `INSERT INTO stats_daily
       (shop_id, stat_date, visits, views, orders, revenue, currency, conversion_rate, traffic_sources, top_search_terms, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
     ON CONFLICT (shop_id, stat_date) DO UPDATE SET
       visits=EXCLUDED.visits, views=EXCLUDED.views, orders=EXCLUDED.orders,
       revenue=EXCLUDED.revenue, currency=EXCLUDED.currency,
       conversion_rate=EXCLUDED.conversion_rate, traffic_sources=EXCLUDED.traffic_sources,
       top_search_terms=EXCLUDED.top_search_terms, captured_at=EXCLUDED.captured_at`,
    [shopId, r.statDate, r.visits, r.views, r.orders, r.revenue, r.currency, r.conversionRate, j(r.trafficSources), j(r.topSearchTerms), capturedAt]
  );
}

export async function upsertListingStatsDaily(q: Queryable, shopId: number, r: ListingStatsDailyRow): Promise<void> {
  await q.query(
    `INSERT INTO listing_stats_daily (shop_id, listing_id, stat_date, views, visits, favorites, orders, revenue)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (shop_id, listing_id, stat_date) DO UPDATE SET
       views=EXCLUDED.views, visits=EXCLUDED.visits, favorites=EXCLUDED.favorites,
       orders=EXCLUDED.orders, revenue=EXCLUDED.revenue`,
    [shopId, r.listingId, r.statDate, r.views, r.visits, r.favorites, r.orders, r.revenue]
  );
}

/** Insert a listing snapshot. Returns false if one already exists at that instant. */
export async function insertListingSnapshot(
  q: Queryable,
  shopId: number,
  capturedAt: string,
  r: ListingSnapshotRow
): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO listing_snapshots
       (shop_id, listing_id, captured_at, title, state, price, currency, quantity, tags, num_images, image_hashes, section_id, views, favorites, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15::jsonb)
     ON CONFLICT (shop_id, listing_id, captured_at) DO NOTHING`,
    [shopId, r.listingId, capturedAt, r.title, r.state, r.price, r.currency, r.quantity, j(r.tags), r.numImages, j(r.imageHashes), r.sectionId, r.views, r.favorites, j(r.raw)]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Latest snapshot strictly before `capturedAt` for diffing. NUMERIC coerced to number. */
export async function getLatestSnapshotBefore(
  q: Queryable,
  shopId: number,
  listingId: number,
  capturedAt: string
): Promise<PriorSnapshot | null> {
  const res = await q.query(
    `SELECT state, price, title, tags, num_images, image_hashes, quantity
       FROM listing_snapshots
      WHERE shop_id=$1 AND listing_id=$2 AND captured_at < $3
      ORDER BY captured_at DESC
      LIMIT 1`,
    [shopId, listingId, capturedAt]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    state: r.state ?? null,
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    title: r.title ?? null,
    tags: (r.tags as string[] | null) ?? null,
    numImages: r.num_images === null || r.num_images === undefined ? null : Number(r.num_images),
    imageHashes: (r.image_hashes as string[] | null) ?? null,
    quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
  };
}

export async function upsertAdsDaily(q: Queryable, shopId: number, r: AdsDailyRow): Promise<void> {
  await q.query(
    `INSERT INTO ads_daily
       (shop_id, stat_date, listing_id, state, spend, impressions, clicks, orders_from_ads, revenue_from_ads)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (shop_id, stat_date, listing_id) DO UPDATE SET
       state=EXCLUDED.state, spend=EXCLUDED.spend, impressions=EXCLUDED.impressions,
       clicks=EXCLUDED.clicks, orders_from_ads=EXCLUDED.orders_from_ads,
       revenue_from_ads=EXCLUDED.revenue_from_ads`,
    [shopId, r.statDate, r.listingId, r.state, r.spend, r.impressions, r.clicks, r.ordersFromAds, r.revenueFromAds]
  );
}

export async function upsertOrder(q: Queryable, shopId: number, r: OrderRow): Promise<void> {
  await q.query(
    `INSERT INTO orders
       (shop_id, receipt_id, ordered_at, buyer_hash, total, currency, status, is_ad_attributed, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (shop_id, receipt_id) DO UPDATE SET
       ordered_at=EXCLUDED.ordered_at, buyer_hash=EXCLUDED.buyer_hash, total=EXCLUDED.total,
       currency=EXCLUDED.currency, status=EXCLUDED.status,
       is_ad_attributed=EXCLUDED.is_ad_attributed, raw=EXCLUDED.raw`,
    [shopId, r.receiptId, r.orderedAt, r.buyerHash, r.total, r.currency, r.status, r.isAdAttributed, j(r.raw)]
  );
  for (const it of r.items) {
    await q.query(
      `INSERT INTO order_items (shop_id, receipt_id, listing_id, quantity, price, personalization)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (shop_id, receipt_id, listing_id) DO UPDATE SET
         quantity=EXCLUDED.quantity, price=EXCLUDED.price, personalization=EXCLUDED.personalization`,
      [shopId, r.receiptId, it.listingId, it.quantity, it.price, it.personalization]
    );
  }
}

export async function upsertReview(q: Queryable, shopId: number, r: ReviewRow): Promise<void> {
  await q.query(
    `INSERT INTO reviews
       (shop_id, review_id, listing_id, rating, review_text, reviewed_at, buyer_hash, response, responded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (shop_id, review_id) DO UPDATE SET
       listing_id=EXCLUDED.listing_id, rating=EXCLUDED.rating, review_text=EXCLUDED.review_text,
       reviewed_at=EXCLUDED.reviewed_at, buyer_hash=EXCLUDED.buyer_hash,
       response=EXCLUDED.response, responded_at=EXCLUDED.responded_at`,
    [shopId, r.reviewId, r.listingId, r.rating, r.reviewText, r.reviewedAt, r.buyerHash, r.response, r.respondedAt]
  );
}

export async function upsertMessageThread(q: Queryable, shopId: number, t: MessageThreadRow): Promise<void> {
  await q.query(
    `INSERT INTO message_threads (shop_id, thread_id, buyer_hash, last_message_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (shop_id, thread_id) DO UPDATE SET
       buyer_hash=COALESCE(EXCLUDED.buyer_hash, message_threads.buyer_hash),
       last_message_at=CASE
         WHEN message_threads.last_message_at IS NULL THEN EXCLUDED.last_message_at
         WHEN EXCLUDED.last_message_at IS NULL THEN message_threads.last_message_at
         WHEN EXCLUDED.last_message_at > message_threads.last_message_at THEN EXCLUDED.last_message_at
         ELSE message_threads.last_message_at
       END`,
    [shopId, t.threadId, t.buyerHash, t.lastMessageAt]
  );
  for (const m of t.messages) await upsertMessage(q, shopId, t.threadId, m);
}

async function upsertMessage(q: Queryable, shopId: number, threadId: string, m: MessageRow): Promise<void> {
  await q.query(
    `INSERT INTO messages (shop_id, thread_id, message_id, direction, sender_id, sent_at, has_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (shop_id, thread_id, message_id) DO UPDATE SET
       direction = COALESCE(EXCLUDED.direction, messages.direction),
       sender_id = COALESCE(EXCLUDED.sender_id, messages.sender_id),
       sent_at = EXCLUDED.sent_at, has_text = EXCLUDED.has_text`,
    [shopId, threadId, m.messageId, m.direction, m.senderId, m.sentAt, m.hasText]
  );
}
