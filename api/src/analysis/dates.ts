// Small date helpers shared by the effect-estimation modules. Dates round-trip
// through Postgres DATE/TIMESTAMPTZ columns, which the pg driver (and pg-mem)
// can hand back as either a JS Date or an ISO-ish string depending on path —
// routing everything through `new Date(v)` normalizes both.

/** Coerce a DATE/TIMESTAMPTZ column value (Date or string) to "YYYY-MM-DD". */
export function toDateOnlyStr(v: unknown): string {
  return new Date(v as any).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" shifted by `days` (may be negative). */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
