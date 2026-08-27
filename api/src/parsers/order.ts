// Order parser -> orders + order_items. Buyer PII is minimized to a hash (§9).
import type { OrderItemRow, OrderRow, Parser } from "./types.js";
import { getArray, hashPII, isObject, pick, toBool, toDateISO, toInt, toMoney, toStr } from "./util.js";

function items(entry: Record<string, unknown>): OrderItemRow[] {
  const txns = pick(entry, ["transactions", "items", "line_items"]);
  if (!Array.isArray(txns)) return [];
  const out: OrderItemRow[] = [];
  for (const t of txns) {
    if (!isObject(t)) continue;
    const listingId = toInt(pick(t, ["listing_id", "listingId"]));
    if (listingId === null) continue;
    const price = toMoney(pick(t, ["price", "amount"]));
    out.push({
      listingId,
      quantity: toInt(pick(t, ["quantity", "qty"])),
      price: price.value,
      personalization: toStr(pick(t, ["personalization", "variations", "note"])),
    });
  }
  return out;
}

export const parseOrder: Parser = (body) => {
  const entries = getArray(body, ["receipts", "orders", "results"]);
  const orders: OrderRow[] = [];

  for (const e of entries) {
    const receiptId = toInt(pick(e, ["receipt_id", "receiptId", "order_id", "id"]));
    if (receiptId === null) continue;

    const total = toMoney(pick(e, ["grandtotal", "total", "total_price", "amount"]));
    const buyerHash = hashPII(
      toStr(pick(e, ["buyer_user_id", "buyerUserId"])),
      toStr(pick(e, ["buyer_email", "name"]))
    );

    orders.push({
      receiptId,
      orderedAt: toDateISO(pick(e, ["created_timestamp", "creation_tsz", "created_at", "ordered_at"])),
      buyerHash,
      total: total.value,
      currency: total.currency ?? toStr(pick(e, ["currency_code", "currency"])),
      status: toStr(pick(e, ["status", "state"])),
      isAdAttributed: toBool(pick(e, ["is_ad_attributed", "from_ads", "attributed_to_ads"])),
      raw: e,
      items: items(e),
    });
  }

  return { orders };
};
