// Etsy "Monthly statement" sayfasındaki Activity summary'yi okur.
// Yalnız okuma: DOM'a dokunmaz, tıklamaz, istek atmaz (Kural 1). Özet satırları
// sayfa açıldıktan sonra Etsy'nin kendi isteğiyle çizilir; bu yüzden beklenir.

export interface StatementRow {
  key: string; // ör. listing_fees (data-test-id'den)
  label: string; // ör. "Listing fees" ya da "Credits"
  value: string; // ham metin, ör. "-2,729.77 TL"
  credit: boolean; // bir üst satıra ait kredi satırı mı
}
export interface StatementModule {
  title: string; // Sales | Fees | Marketing | Shipping
  total: string | null;
  rows: StatementRow[];
}
export interface MonthlyStatement {
  month: number;
  year: number;
  heading: string; // "Your net profit on Etsy for October 2026 was 76,719.34 TL"
  profit: string;
  currency: string | null;
  modules: StatementModule[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const clean = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

/** "TL" → TRY gibi; bulamazsa null (merkez sayfadaki para birimi koduna bakar). */
export function currencyFromAmount(text: string): string | null {
  const t = text.replace(/[\d.,\s+-]/g, "");
  const map: Record<string, string> = { TL: "TRY", "₺": "TRY", $: "USD", US$: "USD", "€": "EUR", "£": "GBP", CA$: "CAD", AU$: "AUD", NZ$: "NZD", "¥": "JPY" };
  return map[t] ?? (/^[A-Z]{3}$/.test(t) ? t : null);
}

/** Sayfa hazırsa özeti döndürür; özet henüz çizilmediyse null. Yanlış ay açıksa hata fırlatır. */
export function readMonthlyStatement(doc: Document, month: number, year: number): MonthlyStatement | null {
  const profitEl = doc.querySelector('[data-test-id="profit-amount"]');
  const headEl = doc.querySelector('[data-test-id="activity-summary-profit"]');
  const mods = Array.from(doc.querySelectorAll('[data-test-id="summary-module"]'));
  if (!profitEl || !headEl || !mods.length) return null;
  const heading = clean(headEl.textContent?.replace(/Your total Sales on Etsy.*?selected time period\./, ""));
  const want = `${MONTHS[month - 1]} ${year}`;
  if (!heading.includes(want)) {
    const err = new Error(`Sayfa ${want} yerine başka bir dönemi gösteriyor: "${heading.slice(0, 120)}"`) as Error & { code?: string };
    err.code = "wrong_page";
    throw err;
  }
  const modules: StatementModule[] = mods.map((m) => {
    const title = clean(Array.from(m.querySelectorAll("h3")).find((h) => !h.hasAttribute("data-test-id"))?.textContent);
    const total = clean(m.querySelector('[data-test-id="accordion-total"]')?.textContent) || null;
    const rows: StatementRow[] = [];
    for (const sec of Array.from(m.querySelectorAll('[data-test-id$="-section"]'))) {
      const key = (sec.getAttribute("data-test-id") ?? "").replace(/-section$/, "");
      for (const cell of Array.from(sec.querySelectorAll('[data-clg-id="WtGridItem"].wt-text-right-xs'))) {
        const row = cell.closest('[data-clg-id="WtGrid"]');
        if (!row || !sec.contains(row)) continue;
        const main = row.querySelector('[data-test-id="child-label"]');
        const label = clean(main?.textContent ?? row.querySelector("button span")?.textContent ?? "Credits");
        rows.push({ key, label, value: clean(cell.textContent), credit: !main });
      }
    }
    return { title, total, rows };
  });
  const profit = clean(profitEl.textContent);
  return { month, year, heading, profit, currency: currencyFromAmount(profit), modules };
}
