// Defensive extraction helpers for parsers. Etsy's internal JSON shapes are not
// contractual and change over time, so parsers must be tolerant: probe a list of
// candidate keys, coerce loosely, and never throw on unexpected input (spec §11).
import { createHash } from "node:crypto";

export type Json = unknown;
export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** First present (non-undefined) value among candidate keys on an object. */
export function pick(obj: unknown, keys: string[]): unknown {
  if (!isObject(obj)) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Locate the array of entities inside a capture body. Tries the given candidate
 * keys (and a few generic wrappers), else returns the body itself if it is an
 * array, else an empty array.
 */
export function getArray(body: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(body)) return body.filter(isObject);
  if (isObject(body)) {
    for (const k of [...keys, "results", "data", "rows", "items"]) {
      const v = body[k];
      if (Array.isArray(v)) return v.filter(isObject);
      // one level of nesting: { data: { results: [...] } }
      if (isObject(v)) {
        for (const k2 of [...keys, "results", "data", "rows", "items"]) {
          if (Array.isArray(v[k2])) return (v[k2] as unknown[]).filter(isObject);
        }
      }
    }
  }
  return [];
}

export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

export function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^(true|on|yes|1)$/i.test(v)) return true;
    if (/^(false|off|no|0)$/i.test(v)) return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
}

/**
 * Numeric/money extraction. Handles plain numbers, numeric strings, and Etsy's
 * money shape { amount, divisor, currency_code } (amount is in minor units).
 * Returns { value, currency }.
 */
export function toMoney(v: unknown): { value: number | null; currency: string | null } {
  if (isObject(v) && "amount" in v) {
    const amount = toInt(v.amount);
    const divisor = toInt(v.divisor) ?? 100;
    const currency = toStr(pick(v, ["currency_code", "currency"]));
    return { value: amount === null ? null : amount / (divisor || 1), currency };
  }
  if (typeof v === "number" && Number.isFinite(v)) return { value: v, currency: null };
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return { value: Number.isFinite(n) ? n : null, currency: null };
  }
  return { value: null, currency: null };
}

/** Coerce epoch seconds/millis or ISO strings to an ISO-8601 UTC string. */
export function toDateISO(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // < ~2001 in ms => treat as seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Coerce a value to a YYYY-MM-DD date string (UTC). */
export function toDateOnly(v: unknown): string | null {
  const iso = toDateISO(v);
  return iso ? iso.slice(0, 10) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** Normalize tags to a string array. */
export function toTags(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(toStr).filter((s): s is string => s !== null);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable short hash for PII minimization (buyer identifiers, spec §9). */
export function hashPII(...parts: (string | number | null | undefined)[]): string | null {
  const material = parts.filter((p) => p !== null && p !== undefined && p !== "").join("|");
  return material ? sha256Hex(material).slice(0, 32) : null;
}
