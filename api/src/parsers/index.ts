// Parser registry: maps a capture_type to its parser. Unknown types have no
// parser and are left in raw_captures (parsed = false) for later re-processing.
import type { Parser } from "./types.js";
import { parseStats } from "./stats.js";
import { parseListing } from "./listing.js";
import { parseAds } from "./ads.js";
import { parseOrder } from "./order.js";
import { parseReview } from "./review.js";
import { parseMessages } from "./messages.js";

export const PARSERS: Record<string, Parser> = {
  stats: parseStats,
  listing: parseListing,
  ads: parseAds,
  order: parseOrder,
  review: parseReview,
  messages: parseMessages,
};

export function getParser(captureType: string): Parser | null {
  return PARSERS[captureType] ?? null;
}

export * from "./types.js";
