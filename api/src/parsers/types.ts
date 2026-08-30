// Normalized row shapes produced by parsers. These map 1:1 to the DB tables in
// db/schema.sql. A single capture may yield many rows (a listings page, a stats
// series, a receipts batch), so every parser returns arrays under a ParseOutput.

export interface StatsDailyRow {
  statDate: string; // YYYY-MM-DD
  visits: number | null;
  views: number | null;
  orders: number | null;
  revenue: number | null;
  currency: string | null;
  conversionRate: number | null;
  trafficSources: unknown | null;
  topSearchTerms: unknown | null;
}

export interface ListingStatsDailyRow {
  listingId: number;
  statDate: string;
  views: number | null;
  visits: number | null;
  favorites: number | null;
  orders: number | null;
  revenue: number | null;
}

export interface ListingSnapshotRow {
  listingId: number;
  title: string | null;
  state: string | null;
  price: number | null;
  currency: string | null;
  quantity: number | null;
  tags: string[] | null;
  numImages: number | null;
  imageHashes: string[] | null;
  sectionId: number | null;
  views: number | null;
  favorites: number | null;
  raw: unknown;
}

export interface AdsDailyRow {
  statDate: string;
  listingId: number; // 0 = shop total
  channel: "onsite" | "offsite" | "unknown"; // Etsy Ads vs Offsite Ads — distinct
  // programs Etsy reports separately; must not overwrite each other on the
  // same (shop, date, listing).
  state: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ordersFromAds: number | null;
  revenueFromAds: number | null;
}

// Etsy Ads on/off toggle: POST /prolist/listings echoes the new state per
// listing id (real shape confirmed on OrnamentsPoint, spec §4 ad-level
// intervention etsy_ads_on/etsy_ads_off). No daily metric — a state change.
export interface AdToggleRow {
  listingId: number;
  isAdvertised: boolean;
}

// Etsy Ads daily budget change: PUT /prolist/campaign-budget response (real
// shape confirmed on OrnamentsPoint: $50 -> $75/day). Shop-wide (the whole
// Etsy Ads "campaign"), not per-listing — spec §4 ad-level intervention
// ad_budget_changed. dailyBudget is already converted to major currency units.
export interface AdBudgetChangeRow {
  dailyBudget: number;
  isActive: boolean | null;
}

export interface OrderRow {
  receiptId: number;
  orderedAt: string | null;
  buyerHash: string | null;
  total: number | null;
  currency: string | null;
  status: string | null;
  isAdAttributed: boolean | null;
  raw: unknown;
  items: OrderItemRow[];
}

export interface OrderItemRow {
  listingId: number;
  quantity: number | null;
  price: number | null;
  personalization: string | null;
}

export interface ReviewRow {
  reviewId: string;
  listingId: number | null;
  rating: number | null;
  reviewText: string | null;
  reviewedAt: string | null;
  buyerHash: string | null;
  response: string | null;
  respondedAt: string | null;
}

export interface MessageThreadRow {
  threadId: string;
  buyerHash: string | null;
  lastMessageAt: string | null;
  messages: MessageRow[];
}

export interface MessageRow {
  messageId: string;
  direction: "in" | "out" | null;
  senderId: number | null;
  sentAt: string | null;
  hasText: boolean;
}

export interface ParseOutput {
  statsDaily?: StatsDailyRow[];
  listingStatsDaily?: ListingStatsDailyRow[];
  listingSnapshots?: ListingSnapshotRow[];
  adsDaily?: AdsDailyRow[];
  adToggles?: AdToggleRow[];
  adBudgetChanges?: AdBudgetChangeRow[];
  orders?: OrderRow[];
  reviews?: ReviewRow[];
  messageThreads?: MessageThreadRow[];
}

export interface ParseContext {
  shopId: number;
  capturedAt: string; // ISO of the raw capture
}

export type Parser = (body: unknown, ctx: ParseContext) => ParseOutput;
