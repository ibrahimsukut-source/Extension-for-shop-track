# Etsy Çok-Mağaza İzleme & Analitik Sistemi — Teknik Spec

> **Amaç:** Farklı VPS'lerde, farklı kişiler adına açılmış çok sayıda Etsy mağazasında yapılan **her günlük aksiyonu** (ürün ekleme/silme/deactive/edit/foto değişimi, reklam açma/kapama, fiyat değişimi, mesaj yanıtları, review'ler, siparişler) ve **her durum metriğini** (stats, trafik kaynakları, conversion, listing durumu) merkezî bir veritabanında toplamak; ardından "hangi stratejiyi uyguladım → sonuç ne oldu" korelasyonunu ölçerek doğru mağaza yönetimi yöntemini bulmak.
>
> **Bu doküman Claude Code ile kod üretimi için yazılmıştır.** Somut şema, endpoint stratejisi ve modül sınırları içerir. Etsy'nin dahili endpoint isimleri zamanla değişebileceğinden, parse mantığı **config-driven** (URL pattern eşleştirme) tasarlanmalıdır — endpoint isimleri koda gömülmemeli.

---

## 0. Kritik tasarım kararı

Etsy'nin **public API'si** stats, mesaj thread'leri, granular reklam verisi ve edit geçmişini vermez. Ama satıcı panelini kullanırken tarayıcı, Etsy'nin **dahili (internal) endpoint'lerine** istek atar ve bu cevaplar bu verilerin hepsini içerir.

**Strateji:** Public API'yi omurga (stabil veri) için kullan; boşlukları tarayıcıdaki **dahili API cevaplarını yakalayarak** (interception) doldur.

| Veri | Kaynak |
|------|--------|
| Orders / receipts, listing envanteri, reviews | **Public API** (stabil, DOM'a bağlı değil) |
| Stats (visits/views/conversion/traffic sources/search terms) | **Interception** |
| Mesaj thread'leri ve zaman damgaları | **Interception** |
| Reklam (Etsy Ads) günlük spend/clicks/impressions | **Interception** |
| Senin yaptığın aksiyonlar (edit/sil/deactive/foto) | **Interception + DOM event + snapshot diff** |

---

## 1. Sistem Mimarisi

İki tamamlayıcı toplama yöntemi, tek merkezî ingestion. Pasif interception'ın açığı: bir sayfayı hiç açmazsan o veri hiç gelmez. CDP Sweeper her gün kilit sayfaları otomatik açarak **garantili günlük snapshot** sağlar. Extension ise sen çalışırken **gerçek zamanlı aksiyon + ekstra veri** yakalar.

---

## 2. Chrome Extension (MV3)

### 2.1 Interception mekanizması
MV3'te `chrome.webRequest` **response body veremez**. Çözüm: sayfanın MAIN world'üne script enjekte edip `fetch` ve `XMLHttpRequest`'i monkey-patch et. Akış: MAIN world (patch) → `window.postMessage` → content script (ISOLATED) → `chrome.runtime.sendMessage` → background SW → merkezî API.

### 2.2 URL pattern config
`endpoints.config.json` — endpoint'leri koda gömme; pattern eşleştirme yap, yola özel parse mantığı `parsers/<type>.js` altında izole olsun.

### 2.3 Mağaza kimliği (multi-account izolasyon)
- Her VPS'te ayrı Chrome profili kullan.
- shop_id çözümleme sırası: (1) body'deki `shop_id`, (2) URL'deki shop id, (3) fallback `SHOP_TAG`.
- Her POST'ta `vps_host`, `chrome_profile`, `shop_tag` meta olarak gönderilsin.

### 2.4 DOM aksiyon yakalama
Content script kritik butonlara click listener koyar (`listing_deactivate_click` vb.). **İkincil kanaldır.**

### 2.5 En sağlam aksiyon tespiti: snapshot diff
Ardışık listing snapshot'larını merkezde diff'le. `price`, `state`, `num_images`, `image_hashes`, `title`, `tags` değişmişse türetilmiş event üret. Tarayıcı dışında yapılan değişiklikleri de yakalar.

---

## 3. CDP Sweeper (puppeteer-core)
Chrome her VPS'te `--remote-debugging-port=9222` ile başlatılır. Sweeper cron'la kilit sayfaları gezer (dashboard, stats, listings, conversations, advertising); extension yakalar. Oturum zaten authenticated.

---

## 4. Merkezî Ingestion API
Endpoint'ler: `POST /ingest/http`, `POST /ingest/event`, `POST /ingest/api`.
Zorunlu: per-VPS Bearer token; deterministik `dedup_key` = `sha256(shop_id|type|entity_id|captured_at_bucket|content_hash)`; idempotent upsert; başarısız parse'ı `raw_captures`'a ham at; batch/backpressure.
Stack önerisi: Node.js (TypeScript) + Fastify + PostgreSQL (JSONB) + parametreli SQL.

---

## 5. Veri Modeli
Bkz. [`../db/schema.sql`](../db/schema.sql) — append-only `events` + snapshot zaman serileri (`listing_snapshots`, `stats_daily`, `ads_daily`, `orders`, `reviews`, `messages`) + `raw_captures`.

### 5.1 Mesaj yanıt süresi
Gelen (`in`) mesajdan sonraki ilk giden (`out`) mesaja kadar geçen süre; thread bazında hesapla, materialized view ile özetle.

---

## 6. Analitik Katman (asıl amaç)
1. **Öncesi/sonrası:** event etrafında metrikleri pencerele (N gün önce vs sonra).
2. **Kontrol grubu:** dokunulmayan benzer listing'lerle normalize et.
3. **Mağaza-seviyesi strateji izleme:** değişim noktaları ↔ trend kırılmaları.
4. **Kohort/segment:** kişiselleştirilmiş vs standart, section, fiyat bandı.
5. **Sağlık skorları:** yanıt süresi, review trendi, aktif listing oranı.
İlk sürüm: SQL view / materialized view. Dashboard faz 5.

---

## 7. Public API Puller
Orders, listing envanteri, reviews için Etsy Open API v3 (OAuth2). Omurga; interception boşluk doldurur. `POST /ingest/api`'ye yazar.

---

## 8. Tech Stack
Extension: Vanilla JS/TS, MV3. Sweeper: Node.js + puppeteer-core. Ingestion API: Node.js (TS) + Fastify + Zod. DB: PostgreSQL. Migration: Prisma migrate / node-pg-migrate. Scheduler: cron + BullMQ. Dashboard: Next.js.

---

## 9. Güvenlik & İzolasyon
Her VPS = ayrı Chrome profili = ayrı Etsy hesabı. Ayrı ingestion token (`.env`, repoda değil). HTTPS-only, token yoksa reddet. PII minimizasyonu (`buyer_hash`). Remote-debugging portu localhost'a kapalı.

---

## 10. Faz Planı
1. PoC (extension + interception, config doldur, lokale bas).
2. Merkezî DB + ingestion (`POST /ingest/http`, dedup, `raw_captures`).
3. Parser'lar + snapshot/event + snapshot diff.
4. CDP Sweeper + çoklu VPS + public API puller.
5. Analitik + dashboard.

Monorepo: `/extension`, `/sweeper`, `/api`, `/db`, `/analytics`. Her faz kendi başına test edilebilir.

---

## 11. Bilinen Riskler
- **Etsy ToS:** Otomatik erişim + çoklu hesap gri alan; hesap askıya alma riski.
- **Dahili endpoint kırılganlığı:** parse `raw_captures` üstünden yeniden çalışabilir; config-driven eşleştirme.
- **Selector kırılganlığı:** DOM yakalama ikincil; birincil interception + snapshot diff.
- **Zaman dilimi:** `TIMESTAMPTZ`; stats günlerini Etsy TZ ile hizala.
- **İdempotentlik:** aynı veri extension + sweeper'dan gelir; `dedup_key` şart.
