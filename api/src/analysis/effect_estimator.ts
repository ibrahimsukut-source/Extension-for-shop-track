// effect_estimator (spec §7, methods ITS + DiD from §3). Given one
// intervention and one metric, estimates the net effect — control-adjusted
// when a matched control exists, plain before/after otherwise — and always
// returns caveats naming the alternative explanations the product spec
// requires (freshness boost, overlapping interventions, missing control,
// small sample). Never asserts certainty: confidence tops out at "medium".
import type { Queryable } from "../repository.js";
import { addDays } from "./dates.js";
import { getMetricSeries, mean, type MetricPoint } from "./metric_series.js";
import { selectControls } from "./control_selector.js";

export interface EffectResult {
  method: "its" | "did";
  pointEstimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  controlAdjusted: boolean;
  confidenceLabel: "low" | "medium";
  caveats: string[];
  baselineMean: number | null;
  postMean: number | null;
  baselineN: number;
  postN: number;
  baselineStart: string;
  baselineEnd: string;
  postStart: string;
  postEnd: string;
}

const BASELINE_DAYS = 14;
// v1: a single "short-term" post window (t+1..t+14). The full spec's 3-way
// split (t+1..t+3 freshness / t+4..t+14 / t+15..t+30 persistent) is a natural
// extension once there's enough real daily history for each to be meaningful
// on its own — right now most listings simply don't have 30 days of metric
// history yet.
const EFFECT_DAYS = 14;
export const EFFECT_WINDOW = "t+1..t+14";

/** Sample standard deviation (n-1); null if fewer than 2 points. */
function stdDev(points: MetricPoint[], m: number): number | null {
  if (points.length < 2) return null;
  const variance = points.reduce((s, p) => s + (p.value - m) ** 2, 0) / (points.length - 1);
  return Math.sqrt(variance);
}

// Intervention types known to produce a short-lived visibility bump on their
// own merits alone — always worth naming as an alternative explanation
// (spec's confounder map: "freshness/newness boost").
const FRESHNESS_TYPES = new Set(["listing_created", "listing_reactivated", "photo_changed", "title_changed", "listing_renewed"]);

export async function estimateEffect(
  q: Queryable,
  params: {
    shopId: number;
    scope: "shop" | "listing";
    entityId: string; // "" for shop scope
    metric: string;
    occurredAt: string; // ISO
    interventionType: string;
    isCleanWindow: boolean | null;
  }
): Promise<EffectResult> {
  const day0 = params.occurredAt.slice(0, 10);
  const baselineStart = addDays(day0, -BASELINE_DAYS);
  const baselineEnd = addDays(day0, -1);
  const postStart = addDays(day0, 1);
  const postEnd = addDays(day0, EFFECT_DAYS);

  const [baselinePts, postPts] = await Promise.all([
    getMetricSeries(q, params.shopId, params.scope, params.entityId, params.metric, baselineStart, baselineEnd),
    getMetricSeries(q, params.shopId, params.scope, params.entityId, params.metric, postStart, postEnd),
  ]);

  const baselineMean = mean(baselinePts);
  const postMean = mean(postPts);
  const shared = { baselineMean, postMean, baselineN: baselinePts.length, postN: postPts.length, baselineStart, baselineEnd, postStart, postEnd };

  if (baselineMean === null || postMean === null) {
    return {
      ...shared,
      method: "its",
      pointEstimate: null,
      ciLow: null,
      ciHigh: null,
      controlAdjusted: false,
      confidenceLabel: "low",
      caveats: ["Öncesi veya sonrası pencerede yeterli veri yok; etki hesaplanamadı."],
    };
  }

  let pointEstimate = postMean - baselineMean;
  let method: "its" | "did" = "its";
  let controlAdjusted = false;
  const caveats: string[] = [];

  if (params.scope === "listing") {
    const controls = await selectControls(q, params.shopId, Number(params.entityId), params.occurredAt);
    if (controls.length > 0) {
      const deltas: number[] = [];
      for (const c of controls) {
        const [cBase, cPost] = await Promise.all([
          getMetricSeries(q, params.shopId, "listing", c.controlEntity, params.metric, baselineStart, baselineEnd),
          getMetricSeries(q, params.shopId, "listing", c.controlEntity, params.metric, postStart, postEnd),
        ]);
        const cBaseMean = mean(cBase);
        const cPostMean = mean(cPost);
        if (cBaseMean !== null && cPostMean !== null) deltas.push(cPostMean - cBaseMean);
      }
      if (deltas.length > 0) {
        const controlDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
        pointEstimate = postMean - baselineMean - controlDelta;
        method = "did";
        controlAdjusted = true;
      } else {
        caveats.push("Benzer ürünler bulundu ama onların da veri geçmişi yetersiz; kontrol düzeltmesi yapılamadı.");
      }
    } else {
      caveats.push(
        "Karşılaştırma için benzer (aynı bölümde, yakın fiyatlı, kendi başına müdahale görmemiş) bir kontrol ürün bulunamadı; sonuç genel trend veya mevsimsellik etkisini içerebilir."
      );
    }
  } else {
    caveats.push("Mağaza geneli bir müdahale; karşılaştırılacak başka bir mağaza yok — sonuç yalnızca öncesi/sonrası karşılaştırmasıdır, mevsimsellik veya genel trend ayrıştırılamadı.");
  }

  if (FRESHNESS_TYPES.has(params.interventionType)) {
    caveats.push("Tazelik etkisi olası bir alternatif açıklama: yeni veya güncellenen içerikler kısa süreliğine ekstra görünürlük kazanabilir.");
  }
  if (params.isCleanWindow === false) {
    caveats.push("Bu pencerede başka bir müdahale (veya mağaza geneli bir değişiklik) ile örtüşme var; etkiyi tek bir değişikliğe bağlamak yanıltıcı olabilir.");
  }

  const n = Math.min(baselinePts.length, postPts.length);
  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  const sd = stdDev(baselinePts, baselineMean);
  if (sd !== null && n >= 3) {
    const se = sd / Math.sqrt(n);
    ciLow = pointEstimate - 1.96 * se;
    ciHigh = pointEstimate + 1.96 * se;
  }

  const adequateData = baselinePts.length >= 5 && postPts.length >= 3;
  if (!adequateData) caveats.push("Örneklem küçük (öncesi/sonrası gün sayısı az); tahmin gürültülü olabilir.");
  caveats.push("Bu bir gözlemsel tahmindir, kesin nedensellik iddiası değildir.");

  // Never auto-assign "high": this is a heuristic v1 estimator, and the
  // product spec's own principle is to stay cautious rather than assert
  // certainty — "medium" is the ceiling until a stricter stats pipeline exists.
  const confidenceLabel: "low" | "medium" =
    adequateData && params.isCleanWindow !== false && (params.scope === "shop" || controlAdjusted) ? "medium" : "low";

  return { ...shared, method, pointEstimate, ciLow, ciHigh, controlAdjusted, confidenceLabel, caveats };
}
