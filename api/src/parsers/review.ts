// Review parser -> reviews. Buyer PII minimized to a hash (§9).
import type { Parser, ReviewRow } from "./types.js";
import { getArray, hashPII, pick, toDateISO, toInt, toStr } from "./util.js";

export const parseReview: Parser = (body) => {
  const entries = getArray(body, ["reviews", "transactions", "results"]);
  const reviews: ReviewRow[] = [];

  for (const e of entries) {
    // Reviews may lack a stable id; fall back to a composite of listing + date.
    const listingId = toInt(pick(e, ["listing_id", "listingId"]));
    const reviewedAt = toDateISO(pick(e, ["create_timestamp", "created_timestamp", "reviewed_at", "created_at"]));
    const explicitId = toStr(pick(e, ["review_id", "reviewId", "id", "transaction_id"]));
    const reviewId = explicitId ?? (listingId !== null && reviewedAt ? `${listingId}:${reviewedAt}` : null);
    if (!reviewId) continue;

    reviews.push({
      reviewId,
      listingId,
      rating: toInt(pick(e, ["rating", "stars", "score"])),
      reviewText: toStr(pick(e, ["review", "review_text", "text", "message"])),
      reviewedAt,
      buyerHash: hashPII(toStr(pick(e, ["buyer_user_id", "reviewer_id", "name"]))),
      response: toStr(pick(e, ["response", "seller_response", "reply"])),
      respondedAt: toDateISO(pick(e, ["response_timestamp", "responded_at", "reply_at"])),
    });
  }

  return { reviews };
};
