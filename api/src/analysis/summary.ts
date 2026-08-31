// AI structured summary export (spec §9): serializes everything the causal
// engine has computed — interventions, effect cards, the pooled strategy
// panel, shop-level change points — into one JSON object or a Markdown
// document meant to be pasted into an LLM conversation ("Claude in Claude").
// The Markdown always opens with the spec's cautious framing so a downstream
// LLM inherits it too: never "X increased because of Y", always "X changed
// after Y; here are the alternative explanations".
import type { Queryable } from "../repository.js";
import { getEffectCards, getInterventionLedger } from "./repository.js";
import { getEventStudy, type EventStudyRow } from "./event_study.js";
import { detectAllChangePoints, type ChangePoint } from "./shop_level_analyzer.js";

export interface AnalysisSummary {
  generatedAt: string;
  shops: { id: number; shopTag: string }[];
  totals: { interventions: number; effects: number };
  interventions: any[];
  effects: any[];
  strategyPanel: EventStudyRow[];
  changePoints: (ChangePoint & { shopId: number; shopTag: string })[];
  disclaimer: string;
}

export const DISCLAIMER =
  "Bu özet gözlemsel (observational) veriye dayanır; deneysel bir A/B testi değildir. Hiçbir etki tahmini kesin " +
  "nedensellik iddiası değildir. Her etki kartı olası alternatif açıklamalar taşır (tazelik etkisi, mevsimsellik, " +
  "örtüşen müdahaleler, küçük örneklem, eksik kontrol). Bu veriyi yorumlarken 'X, Y'den DOLAYI arttı' yerine " +
  "'X müdahalesinden SONRA Y değişti; net etki tahmini şu, ama şu alternatif açıklamalar da mümkün' çerçevesini kullan.";

export async function buildAnalysisSummary(q: Queryable): Promise<AnalysisSummary> {
  const shopsRes = await q.query(`SELECT id, shop_tag FROM shops ORDER BY id`);
  const shops = shopsRes.rows.map((r) => ({ id: Number(r.id), shopTag: String(r.shop_tag) }));

  const [interventions, effects, strategyPanel, totalIvRes, totalEfRes] = await Promise.all([
    getInterventionLedger(q, 200),
    getEffectCards(q, 200),
    getEventStudy(q),
    q.query(`SELECT count(*)::int AS n FROM interventions`),
    q.query(`SELECT count(*)::int AS n FROM effects`),
  ]);

  const changePointsPerShop = await Promise.all(
    shops.map(async (s) => {
      const cps = await detectAllChangePoints(q, s.id);
      return cps.map((cp) => ({ ...cp, shopId: s.id, shopTag: s.shopTag }));
    })
  );
  const changePoints = changePointsPerShop.flat().sort((a, b) => b.date.localeCompare(a.date));

  return {
    generatedAt: new Date().toISOString(),
    shops,
    totals: { interventions: totalIvRes.rows[0]?.n ?? 0, effects: totalEfRes.rows[0]?.n ?? 0 },
    interventions,
    effects,
    strategyPanel,
    changePoints,
    disclaimer: DISCLAIMER,
  };
}

function jv(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length + " öğe";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toMarkdown(s: AnalysisSummary): string {
  const L: string[] = [];
  L.push("# Etsy Mağaza Analiz Özeti");
  L.push("");
  L.push(`_Üretildi: ${s.generatedAt}_`);
  L.push("");
  L.push(`> ${s.disclaimer}`);
  L.push("");

  L.push("## Mağazalar");
  if (s.shops.length === 0) L.push("_Henüz mağaza yok._");
  for (const shop of s.shops) L.push(`- ${shop.shopTag} (id ${shop.id})`);
  L.push("");

  L.push(`## Strateji Paneli — müdahale tipi → ortalama etki (toplam ${s.totals.effects} etki ölçümü)`);
  if (s.strategyPanel.length === 0) L.push("_Henüz havuzlanacak etki yok._");
  for (const r of s.strategyPanel) {
    const sign = r.meanEffect > 0 ? "+" : "";
    L.push(
      `- **${r.interventionType}** → ${r.metric}: ortalama ${sign}${r.meanEffect.toFixed(2)} (n=${r.n}, kontrol düzeltmeli=${r.nControlAdjusted}/${r.n}, orta güven=${r.nMedium}/${r.n})`
    );
  }
  L.push("");

  L.push("## Son Etki Kartları");
  if (s.effects.length === 0) L.push("_Henüz hesaplanmış etki yok._");
  for (const e of s.effects.slice(0, 30)) {
    L.push(`### ${e.intervention_type} — ${e.metric} (${e.effect_window})`);
    L.push(`- Tarih: ${e.occurred_at}`);
    L.push(`- Varlık: ${e.entity_type}${e.entity_id ? " #" + e.entity_id : ""}`);
    L.push(`- Yöntem: ${e.method}${e.control_adjusted ? " (kontrol düzeltmeli)" : ""}`);
    L.push(`- Tahmini etki: ${e.point_estimate}`);
    L.push(`- Güven: ${e.confidence_label}`);
    if (Array.isArray(e.caveats) && e.caveats.length) {
      L.push("- Uyarılar:");
      for (const c of e.caveats) L.push(`  - ${c}`);
    }
    L.push("");
  }

  L.push("## Değişim Noktaları (müdahaleyle açıklanamayan mağaza-geneli kaymalar)");
  if (s.changePoints.length === 0) L.push("_Tespit edilmiş değişim noktası yok._");
  for (const cp of s.changePoints.slice(0, 20)) {
    const pct = cp.relDelta == null ? "—" : (cp.relDelta * 100).toFixed(0) + "%";
    L.push(`- ${cp.shopTag} · ${cp.date} · ${cp.metric}: ${cp.before.toFixed(2)} → ${cp.after.toFixed(2)} (${cp.direction === "up" ? "+" : ""}${pct})`);
  }
  L.push("");

  L.push(`## Müdahale Defteri (son ${Math.min(s.interventions.length, 50)})`);
  if (s.interventions.length === 0) L.push("_Henüz kaydedilmiş müdahale yok._");
  for (const iv of s.interventions.slice(0, 50)) {
    L.push(`- ${iv.occurred_at} · ${iv.intervention_type} · ${iv.entity_type}${iv.entity_id ? " #" + iv.entity_id : ""} · ${jv(iv.before_value)} → ${jv(iv.after_value)}`);
  }

  return L.join("\n");
}
