// Listing parser -> listing_snapshots (state time series + snapshot-diff source).
import type { ListingSnapshotRow, Parser } from "./types.js";
import { getArray, isObject, pick, sha256Hex, toInt, toMoney, toStr, toTags } from "./util.js";

/** Derive stable per-image hashes so photo changes are detectable via diffing. */
function imageInfo(entry: Record<string, unknown>): { num: number | null; hashes: string[] | null } {
  const images = pick(entry, ["images", "listing_images", "Images"]);
  if (Array.isArray(images)) {
    const hashes = images
      .map((img) => {
        if (typeof img === "string") return sha256Hex(img).slice(0, 16);
        if (isObject(img)) {
          const key = toStr(pick(img, ["url_fullxfull", "url", "src", "listing_image_id", "id"]));
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

export const parseListing: Parser = (body) => {
  const entries = getArray(body, ["listings", "listing", "results"]);
  const listingSnapshots: ListingSnapshotRow[] = [];

  for (const e of entries) {
    const listingId = toInt(pick(e, ["listing_id", "listingId", "id"]));
    if (listingId === null) continue; // a snapshot without an id is useless

    const money = toMoney(pick(e, ["price", "Price"]));
    const { num, hashes } = imageInfo(e);

    listingSnapshots.push({
      listingId,
      title: toStr(pick(e, ["title", "name"])),
      state: toStr(pick(e, ["state", "listing_state", "status"])),
      price: money.value,
      currency: money.currency ?? toStr(pick(e, ["currency_code", "currency"])),
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
