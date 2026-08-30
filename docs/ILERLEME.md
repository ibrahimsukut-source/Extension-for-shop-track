# Etsy Çoklu-Mağaza Takip & Analitik Sistemi — İlerleme Raporu

> Bu belge, şu ana kadar yapılan tüm işi özetler. Branch:
> `claude/etsy-multi-shop-tracker-1q4jh2` · Son commit: `7848a8b`

---

## 1. Sistem ne yapıyor? (Mimari)

Amaç: Etsy satıcı panelinde gezerken, Etsy'nin **kendi iç JSON API'lerini**
tarayıcıda yakalayıp merkezi bir toplama servisine göndermek, orada
ayrıştırmak (parse) ve analitik/panel olarak göstermek.

```
Etsy iç API (fetch/XHR)
      │  (MV3 eklenti yakalar)
      ▼
interceptor.js (MAIN world)  →  bridge.js (ISOLATED)  →  background SW (kuyruk)
      │  Bearer token ile POST
      ▼
Ingestion API (Fastify + Zod + pg)   →   PostgreSQL / bellek-içi DB
      │  raw_captures (ham) → parsers → normalize tablolar
      ▼
Snapshot-diff → türetilmiş olaylar (fiyat/foto/durum değişimi)
      │
      ▼
Canlı Dashboard (http://localhost:8080)
```

**Tasarım ilkeleri:**
- **Ham veri önce** (`raw_captures`) — hiçbir şey kaybolmaz; parser sonradan
  genişletilebilir.
- **PII minimizasyonu** — alıcı verisi asla ham saklanmaz; sadece `buyer_hash`.
- **Per-VPS token** — her mağaza/VPS için ayrı Bearer token → `shop_tag`.
- **Dedup** — `ON CONFLICT (dedup_key) DO NOTHING` ile tekrar önleme.
- **Sıfır-kurulum** — Docker/Postgres olmadan bellek-içi DB ile çalışır.

---

## 2. Fazlar ve tamamlananlar

### Faz 1 — MV3 Eklenti (commit `07c689d`)
- `fetch` ve `XHR` monkey-patch (MAIN world `interceptor.ts`).
- MAIN → ISOLATED köprü (`bridge.ts`) → background service worker.
- Yapılandırma-güdümlü endpoint sınıflandırma (`endpoints.config.json`).
- Storage-destekli kuyruk + mutex (`lib/queue.ts`, `lib/lock.ts`).
- Options sayfası: shop tag, API host, Bearer token, forwarding aç/kapa.

### Faz 2 — Merkezi Toplama API'si (commit `f440cf1`)
- Node.js/TypeScript ESM, **Fastify 5 + Zod + `pg`**.
- Per-token auth (`Bearer` → `shop_tag`).
- 3 ingest yolu: `/ingest/http`, `/ingest/api`, `/ingest/event`.
- Batch limiti, dedup, `raw_captures` önce yazılır.

### Faz 3 — Parser'lar + Snapshot-diff (commit `e8a4ae3`)
- Ham yakalamalar → normalize tablolar (`parsed_repository.ts`).
- Listing snapshot'ları + zaman içinde **fark (diff)** → türetilmiş olaylar
  (`parse/diff.ts`, `parse/runner.ts`).

### Gerçek Etsy şekillerine uyarlama (commit'ler `cc6e131`…`867cb96`)
Gerçek OrnamentsPoint (shop 32467610) verisiyle parser'lar kalibre edildi:
- `shop-analytics-stats` → `metrics_summary` / `traffic_breakdown`
- `listings/v3/search` → numerik state, `image_id`, fiyat string'i
- `offsite-ads-data/ad-traffic` → `clickCount` / `timestamp`
- `conversations/message-list-data` → düz `messages[]`, `sender_id`

### Canlı yerel çalışma modu (commit'ler `008ae12`…`7848a8b`)
Kullanıcı makinesinde **Docker/Postgres olmadan** canlı test için:
- **Bellek-içi DB** (`pg-mem`) — `DATABASE_URL` verilmezse otomatik (`10011ba`).
- **Otomatik `.env` yükleme** — bağımlılıksız `env.ts` (`4511715`).
- **Varsayılan dev token** + **AUTO_PARSE açık** — sıfır-config forwarding
  (`4f9a5cf`).
- **Canlı dashboard** — `/` sunucu-taraflı HTML, `/dashboard/data` polling
  (`008ae12`).
- **CORS düzeltmesi** — eklenti→localhost preflight (OPTIONS) artık auth'tan
  önce 204 dönüyor; gerçek POST akıyor (`7848a8b`). ← **kritik son düzeltme**

---

## 3. Şu an ne çalışıyor? (Canlı doğrulandı ✅)

Zincir uçtan uca çalışıyor:
`eklenti → http://localhost:8080/ingest/http (202) → DB → AUTO_PARSE → dashboard`

**Dolan alanlar:**
- Mağaza / yakalama / parse sayaçları (SHOP / CAPTURES / PARSED)
- Listing snapshot'ları (ürünler, durum "active", fiyat TRY, foto sayısı)
- Capture pipeline (listing, stats, order)

---

## 4. Henüz boş / eksik olanlar ve nedenleri

| Alan | Neden boş | Ne gerekiyor |
|------|-----------|--------------|
| **Etsy Ads** (harcama/gösterim/ROAS) | Şimdilik yalnız *tıklama* yakalanıyor | `prolist/stats` gövdesi + parser genişletme |
| **Shop Stats** | Stats sayfası tam gezilmedi | O sayfayı açmak (metrics_summary akar) |
| **Derived Events** | Fark için 2 snapshot gerekir | İkinci gezinti (zaman farkı) |
| **Top Listings** | `listing_stats_daily` boş | Ürün-bazlı istatistik gövdesi |
| **Msg Threads** | Messages gezilmedi | Mesajlar sayfasını açmak |

---

## 5. Teknik notlar

- **pg-mem uyumsuzlukları** giderildi: `FILTER`, `NULLS LAST`, `GREATEST`
  yerine `SUM(CASE…)` / `ORDER BY sum()` / `CASE`.
- **Güvenlik**: `.env` ve token'lar repoda değil (`.gitignore`). Dashboard
  internete açılırsa `DASHBOARD_KEY` ile kapatılır.
- **Testler**: 58/58 geçiyor; typecheck temiz.

---

## 6. Nasıl çalıştırılır (özet)

```bash
cd api
npm install
npm run dev            # → http://localhost:8080 (canlı dashboard)
```
Docker/Postgres gerekmez. Kalıcı veri istenirse `DATABASE_URL` ile gerçek
PostgreSQL bağlanır. Ayrıntı: `docs/LOCAL.md`.

Eklenti Options ayarları:
- Shop tag: `my-shop-01`
- API host: `http://localhost:8080`
- Bearer token: `tok_replace_me_0123456789abcdef`
- Enable forwarding: ✔

---

## 7. Sıradaki muhtemel işler

1. **Tüm reklam verisini** yapısal hale getirmek (spend/impressions/ROAS)
   — `prolist/stats` + `prolist/stats/listings` gövdeleri geldikçe.
2. Ads / Stats / Top-listings / Events panellerini doldurmak.
3. (Opsiyonel) Faz 4: CDP Sweeper + çoklu-VPS + public API puller.
4. (Opsiyonel) Faz 5: analitik görünümler.

> Bir sonraki adım kullanıcının geri bildirimine göre belirlenecek
> ("istediğim şekilde yapılmayanlar" listesi).
