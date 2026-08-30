// Natural-language question interface (spec §9, "Claude in Claude"): the
// operator asks a plain question ("fiyat değişikliği gerçekten işe yaradı
// mı?") about their own shop; Claude answers using ONLY the structured
// summary this app already computed (analysis/summary.ts) — never invents
// numbers, and inherits the same cautious framing the rest of the engine
// enforces (never bare causation, always name alternative explanations).
import Anthropic from "@anthropic-ai/sdk";
import type { Queryable } from "../repository.js";
import { buildAnalysisSummary, toMarkdown } from "./summary.js";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 2048; // a chat-box answer, deliberately short — not a report

const SYSTEM_PROMPT = `Sen bir Etsy mağazasının "nedensellik analiz motoru" için soru-cevap katmanısın.
Sana verilen ÖZET dışında hiçbir veri veya sayı uydurma; özet içinde bir şeyin cevabı yoksa açıkça
"bu veriyle bilemiyorum" de, tahmin etme. Aşağıdaki kurala kesinlikle uy:
- ASLA "X, Y'den DOLAYI arttı/azaldı" gibi kesin nedensellik iddiası kurma.
- HER ZAMAN "X müdahalesinden SONRA Y değişti; tahmini net etki şu; ama şu alternatif açıklamalar da
  mümkün (tazelik etkisi, mevsimsellik, örtüşen müdahale, küçük örneklem, eksik kontrol)" çerçevesini kullan.
- Elindeki confidence_label ve caveats alanlarını cevabında mutlaka yansıt.
- Kısa ve net cevap ver (birkaç cümle / birkaç madde), gereksiz uzatma.
- Türkçe soruya Türkçe, İngilizce soruya İngilizce cevap ver.`;

export interface AskResult {
  enabled: boolean;
  answer?: string;
  error?: string;
}

/** True when ANTHROPIC_API_KEY is configured — gates the dashboard's question box. */
export function askEnabled(apiKey: string): boolean {
  return apiKey.trim().length > 0;
}

export async function askQuestion(q: Queryable, apiKey: string, question: string): Promise<AskResult> {
  if (!askEnabled(apiKey)) {
    return { enabled: false, error: "ANTHROPIC_API_KEY yapılandırılmamış — bu özellik kapalı." };
  }
  const trimmed = question.trim();
  if (!trimmed) {
    return { enabled: true, error: "Boş soru." };
  }

  const summary = await buildAnalysisSummary(q);
  const context = toMarkdown(summary);

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `ÖZET (mağazanın müdahale defteri, etki kartları, strateji paneli, değişim noktaları):\n\n${context}\n\n---\n\nSORU: ${trimmed}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { enabled: true, error: "Model bu soruyu yanıtlamayı reddetti." };
    }
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    return { enabled: true, answer: text || "(boş yanıt)" };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { enabled: true, error: "Geçersiz ANTHROPIC_API_KEY." };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { enabled: true, error: "Hız sınırına takıldı, birazdan tekrar dene." };
    }
    if (err instanceof Anthropic.APIError) {
      return { enabled: true, error: `API hatası (${err.status}): ${err.message}` };
    }
    return { enabled: true, error: `Beklenmeyen hata: ${(err as Error).message}` };
  }
}
