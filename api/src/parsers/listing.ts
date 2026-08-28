// Listing parser -> listing_snapshots (state time series + snapshot-diff source).
// Tuned to Etsy's real listings/v3/search shape (OrnamentsPoint): a bare array of
// listing objects with numeric `state`, string `price`, `listing_images[].image_id`,
// and is_activateable / is_deactivateable flags.
import type { ListingSnapshotRow, Parser } from "./types.js";
import { getArray, isObject, pick, sha256Hex, toBool, toInt, toMoney, toStr, toTags } from "./util.js";

/**
 * Resolve a human listing state. Etsy sends a numeric `state` here, but the
 * activate/deactivate flags are the reliable signal for the active/inactive
 * distinction that drives deactivated/activated events.
 */
function listingState(e: Record<string, unknown>): string | null {
  if (toBool(pick(e, ["is_frozen"])) === true) return "frozen";
  if (toBool(pick(e, ["is_activateable"])) === true) return "inactive";
  if (toBool(pick(e, ["is_deactivateable"])) === true) return "active";
  const raw = pick(e, ["state", "listing_state", "status"]);
  if (typeof raw === "string" && !/^\d+$/.test(raw)) return raw;
  const map: Record<number, string> = { 0: "active", 1: "inactive", 2: "sold_out", 3: "expired", 4: "draft" };
  const n = toInt(raw);
  return n !== null && map[n] ? map[n] : raw === null || raw === undefined ? null : String(raw);
}

/** Primary-image hash for photo-change detection. This endpoint returns only the
 *  primary image, so we key on the stable image_id (changes when the photo does). */
function imageInfo(entry: Record<string, unknown>): { num: number | null; hashes: string[] | null } {
  const images = pick(entry, ["listing_images", "images", "Images"]);
  if (Array.isArray(images)) {
    const hashes = images
      .map((img) => {
        if (typeof img === "string") return sha256Hex(img).slice(0, 16);
        if (isObject(img)) {
          const key = toStr(pick(img, ["image_id", "listing_image_id", "id", "url_fullxfull", "url", "src"]));
          return key ? sha256Hex(key).slice(0, 16) : null;
        }
        return null;
      })
      .filter((h): h is string => h !== null);
    return { num: images.length, hashes: hashes.length ? hashes : null };
  }
  const num = toInt(pick(entry, ["num_images", "image_count"]));
  return { num, hashes: null };
}

/** Currency isn't a field here; infer it from the "1,982 TL" symbol string. */
function inferCurrency(entry: Record<string, unknown>): string | null {
  const sym = toStr(pick(entry, ["inventory_min_price_with_symbol", "inventory_max_price_with_symbol"]));
  if (!sym) return null;
  if (/\bTL\b/i.test(sym)) return "TRY";
  if (sym.includes("$")) return "USD";
  if (sym.includes("€")) return "EUR";
  if (sym.includes("£")) return "GBP";
  const code = /([A-Z]{3})/.exec(sym);
  return code ? code[1] : null;
}

export const parseListing: Parser = (body) => {
  const entries = getArray(body, ["listings", "listing", "results"]);
  const listingSnapshots: ListingSnapshotRow[] = [];

  for (const e of entries) {
    const listingId = toInt(pick(e, ["listing_id", "listingId", "id"]));
    if (listingId === null) continue;

    // price is a plain string ("1982.00"); fall back to price_int (minor units).
    let price = toMoney(pick(e, ["price", "Price"])).value;
    if (price === null) {
      const priceInt = toInt(pick(e, ["price_int", "inventory_min_price_int"]));
      if (priceInt !== null) price = priceInt / 100;
    }

    const { num, hashes } = imageInfo(e);

    listingSnapshots.push({
      listingId,
      title: toStr(pick(e, ["title", "name"])),
      state: listingState(e),
      price,
      currency: toStr(pick(e, ["currency_code", "currency"])) ?? inferCurrency(e),
      quantity: toInt(pick(e, ["quantity", "quantity_available"])),
      tags: toTags(pick(e, ["tags", "Tags"])),
      numImages: num,
      imageHashes: hashes,
      sectionId: toInt(pick(e, ["shop_section_id", "section_id"])),
      views: toInt(pick(e, ["views", "num_views"])),
      favorites: toInt(pick(e, ["num_favorers", "favorites", "num_favorites"])),
      raw: e,
    });
  }

  return { listingSnapshots };
};
