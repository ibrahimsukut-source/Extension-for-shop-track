// Aylık ekstre özet okuyucusu: Etsy'nin "Activity summary" işaretlemesinin sadeleştirilmiş kopyası
// üzerinde gerçek Chromium'da çalıştırılır (rakamlar örnektir).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

// Tarayıcı bulunamazsa (ör. Chromium kurulu olmayan makine) test atlanır
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try { return execSync(`ls -d ${base}/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1`).toString().trim() || null; } catch { return null; }
}
const CHROME = chromePath();

const row = (label, value, main = true) => `<div data-clg-id="WtGrid" class="wt-grid"><div data-clg-id="WtGridItem" class="wt-grid__item-xs-9">
  ${main ? `<div data-test-id="child-label" class="wt-display-inline">${label}</div><span data-test-id="tooltip"><span>açıklama metni 99.99 TL</span></span>`
         : `<div><button><span>${label}</span></button><span class="wt-badge">Plus</span></div>`}</div>
  <div data-clg-id="WtGridItem" class="wt-position-right wt-text-right-xs wt-grid__item-xs-3">${value}</div></div>`;
const section = (key, ...rows) => `<div data-test-id="${key}-section">${rows.join("")}</div>`;
const mod = (title, total, ...sections) => `<div data-test-id="summary-module"><button><h3 class="wt-text-title-01">${title}</h3></button>
  <div>${sections.join("")}</div><span><h3 data-test-id="accordion-total">${total}</h3></span></div>`;
const PAGE = `<div data-test-id="activity-summary"><div data-test-id="activity-summary-profit">Your <h3> net profit </h3>
  <div role="tooltip"><span>Your total <strong>Sales</strong> on Etsy minus any deductions like refunds and your total <strong>Fees</strong>, <strong>Marketing</strong>, and <strong>Shipping</strong> costs for the selected time period.</span></div>
  on Etsy for October 2026 was <h3 data-test-id="profit-amount">1,180.00 TL</h3></div>
  ${mod("Sales", "1,950.00 TL", section("total_sales", row("Total sales", "2,000.00 TL")), section("refunds", row("Refunds", "-60.00 TL")), section("buyer_paid_taxes_and_fees", row("Duties", "---"), row("Credits", "10.00 TL", false)))}
  ${mod("Fees", "-270.00 TL", section("listing_fees", row("Listing fees", "-100.00 TL"), row("Credits", "30.00 TL", false)), section("transaction_fees", row("Transaction fees", "-200.00 TL")), section("deposit_fees", row("Deposit fees", "--")))}
  ${mod("Marketing", "-500.00 TL", section("etsy_ads", row("Etsy Ads", "-450.00 TL")), section("etsy_plus", row("Etsy Plus subscription", "-50.00 TL")))}
  ${mod("Shipping", "0.00 TL", section("shipping_labels", row("Shipping labels", "--")))}
</div>`;

test("aylık özet: satırlar, kredi satırları, net kâr ve para birimi okunur; yanlış ay reddedilir", { skip: !CHROME && "Chromium yok" }, async () => {
  const out = await build({ entryPoints: ["src/agent/statement.ts"], bundle: true, format: "iife", globalName: "ST", write: false, logLevel: "silent" });
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${PAGE}</body>`);
    await page.addScriptTag({ content: out.outputFiles[0].text });
    const r = await page.evaluate(() => globalThis.ST.readMonthlyStatement(document, 10, 2026));
    assert.equal(r.profit, "1,180.00 TL");
    assert.equal(r.currency, "TRY");
    assert.deepEqual(r.modules.map((m) => m.title), ["Sales", "Fees", "Marketing", "Shipping"]);
    const fees = r.modules[1].rows;
    assert.deepEqual(fees.map((x) => [x.key, x.label, x.value, x.credit]), [
      ["listing_fees", "Listing fees", "-100.00 TL", false],
      ["listing_fees", "Credits", "30.00 TL", true],
      ["transaction_fees", "Transaction fees", "-200.00 TL", false],
      ["deposit_fees", "Deposit fees", "--", false],
    ]);
    // Tooltip metni etikete karışmaz
    assert.equal(r.modules[0].rows[0].label, "Total sales");
    const wrong = await page.evaluate(() => { try { globalThis.ST.readMonthlyStatement(document, 9, 2026); return null; } catch (e) { return e.code; } });
    assert.equal(wrong, "wrong_page");
    // Özet henüz çizilmediyse null (çalıştırıcı bekler)
    await page.setContent("<!doctype html><body><div>yükleniyor</div></body>");
    await page.addScriptTag({ content: out.outputFiles[0].text });
    assert.equal(await page.evaluate(() => globalThis.ST.readMonthlyStatement(document, 10, 2026)), null);
  } finally {
    await browser.close();
  }
});
