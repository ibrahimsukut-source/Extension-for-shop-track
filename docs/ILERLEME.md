# Etsy Çok-Mağaza Nedensellik & Etki Analizi Sistemi — İlerleme Raporu

> Bu belge, şu ana kadar yapılan tüm işi özetler. Branch:
> `claude/etsy-multi-shop-tracker-1q4jh2` · Son commit: `1774437`

---

## 1. Sistem ne yapıyor? (Mimari)

İki katman üst üste çalışıyor:

**Katman 1 — Toplama:** Etsy satıcı panelinde gezerken, Etsy'nin **kendi iç
JSON API'lerini** tarayıcıda yakalayıp merkezi bir servise gönderir, ayrıştırır
(parse), normalize tablolara yazar.

**Katman 2 — Nedensellik motoru (asıl ürün):** Toplanan veriden **"ne yaptım →
sonucunda ne oldu"** sorusunu cevaplar. Bir A/B testi değil — gözlemsel/quasi-
deneysel çıkarım (ITS + DiD + kontrol eşleştirme), her zaman temkinli, her
zaman alternatif açıklamalarla.

```
Etsy iç API (fetch/XHR)
      │  (MV3 eklenti / self-service console script yakalar)
      ▼
Ingestion API (Fastify + Zod + pg)   →   PostgreSQL / bellek-içi DB
      │  raw_captures (ham) → parsers → normalize tablolar
      ▼
Snapshot-diff / interception → müdahaleler (interventions) + long-format metrikler
      │
      ▼
Nedensellik motoru: control_selector → effect_estimator (ITS/DiD) → clean_window_flagger
      │
      ├──→ event_study_aggregator (havuzlanmış etki)
      ├──→ shop_level_analyzer (değişim noktaları)
      └──→ AI katmanı: yapısal özet export + doğal dil soru-cevap (Claude API)
      │
      ▼
Canlı Dashboard — karar arayüzü (Müdahale Defteri, Etki Kartları, Strateji
Paneli, Değişim Noktaları, AI'ya Sor)
```

**Tasarım ilkeleri:**
- **Ham veri önce** (`raw_captures`) — hiçbir şey kaybolmaz.
- **Asla kesin nedensellik iddiası yok** — her etki tahmini "X'ten SONRA Y
  değişti; net etki tahmini şu; ama şu alternatif açıklamalar da mümkün"
  çerçevesinde, `confidence_label` hiçbir zaman otomatik "high" olmaz.
- **PII minimizasyonu** — alıcı verisi asla ham saklanmaz; sadece `buyer_hash`.
- **Sıfır-kurulum** — Docker/Postgres olmadan bellek-içi DB ile çalışır.
- **AI özelliği tamamen opsiyonel** — `ANTHROPIC_API_KEY` yoksa geri kalan her
  şey (toplama, müdahale defteri, etki kartları, strateji paneli) sorunsuz çalışır.

---

## 2. Fazlar ve tamamlananlar

### Faz 1-3 — Eklenti, toplama API'si, parser'lar + snapshot-diff
MV3 eklenti (fetch/XHR yakalama) → Fastify ingestion API → normalize tablolar
→ listing snapshot farkı → türetilmiş olaylar. Gerçek OrnamentsPoint
(shop 32467610) verisiyle kalibre edildi.

### Canlı yerel çalışma modu
Bellek-içi DB (pg-mem), otomatik `.env` yükleme, sıfır-config forwarding
(varsayılan dev token + AUTO_PARSE), canlı dashboard, CORS düzeltmesi.

### P0 — Müdahale defteri + long-format metrikler (`155b28d`)
5 yeni tablo (`interventions`, `metric_timeseries`, `experiments`,
`control_assignments`, `effects`); `intervention_detector` (snapshot-diff →
birinci sınıf müdahale: `price_changed`, `listing_deactivated/reactivated`,
`photo_changed`, `title_changed`, `tags_changed`, `quantity_changed`,
`state_changed`); `metric_builder` (günlük tabloları long-format'a çeviren
`buildMetricTimeseries`); Müdahale Defteri dashboard bölümü.

### Priority 1 — Etsy Ads gerçek veri (`084a623`…`ca72716`)
Claude for Chrome ile gerçek Etsy Shop Manager'dan yakalanan API şekilleriyle:
- `etsy_ads_on`/`etsy_ads_off` (reklam aç/kapa, `POST /prolist/listings`)
- On-site Etsy Ads günlük spend/impressions/ROAS (`GET /prolist/stats`) —
  **kritik düzeltme**: iki ayrı reklam programı (on-site/offsite) aynı satırı
  ezmesin diye `channel` kolonu eklendi
- `ad_budget_changed` (bütçe değişikliği, `PUT /prolist/campaign-budget`)
- **Kritik koruma**: `/prolist/stats` aralığa göre `granularity` değiştiriyor
  (gün/ay); aylık toplamların günlük tabloya tek gün gibi yazılıp veriyi
  bozması engellendi

### Priority 2 (kısmi) — Shop Stats (`a6b4ebe`)
`GET /stats/slim-stats` (dashboard stat kartları) gerçek şekliyle parse
edildi; yalnızca `today`/`yesterday` günlük tabloya yazılıyor, `last_7` gibi
toplamlar (aynı granularity tuzağı) bilerek atlanıyor.

### P1 — Nedensellik motoru çekirdeği (`c8e78e3`)
- **`control_selector`**: aynı bölümdeki, fiyatı yakın, kendi başına müdahale
  görmemiş "kardeş" ürünü buluyor (DiD'in karşılaştırma referansı)
- **`clean_window_flagger`**: bir müdahalenin penceresinde başka bir müdahale
  (aynı üründe veya mağaza genelinde) örtüşüyorsa işaretliyor
- **`effect_estimator`**: ITS (öncesi/sonrası) + kontrol varsa DiD (net etki);
  hiçbir zaman "high" güven vermez, her zaman alternatif açıklamalar listeler
- **Etki Kartları** dashboard bölümü
- **Gerçek sayılarla uçtan uca doğrulandı**: 14 gün öncesi/sonrası sentetik
  veri (ürün +10 ham artış, kardeş ürün +2 genel trend) → `parseAll()` →
  dashboard → `point_estimate: 8` (= 10-2, DiD kontrolün driftini doğru çıkardı)

### P2 — Havuzlama + değişim noktaları (`32a3e6f`)
- **`event_study_aggregator`**: tüm etkileri `(müdahale tipi, metrik)`
  bazında havuzlar — "bu değişikliği daha önce N kez yaptım, ortalama etkisi
  şuydu" (Strateji Paneli)
- **`shop_level_analyzer`**: müdahaleyle açıklanamayan mağaza-geneli kaymaları
  tespit eder (iki-pencere karşılaştırması + non-max suppression)

### P3 — AI katmanı (`1059397`, `1774437`)
- **Yapısal özet export**: `GET /analysis/summary?format=json|md` — tüm
  müdahaleler/etkiler/strateji paneli/değişim noktaları, LLM'e yapıştırılabilir
  Markdown, temkinli çerçeveyle açılıyor
- **Doğal dil soru-cevap** ("Claude in Claude"): `POST /analysis/ask` —
  `@anthropic-ai/sdk` ile `claude-opus-5`'e SADECE yapısal özeti bağlam olarak
  veriyor, asla sayı uydurmuyor, aynı temkinli çerçeveyi (asla kesin
  nedensellik, her zaman alternatif açıklama) sistem promptunda zorunlu
  kılıyor. `ANTHROPIC_API_KEY` yoksa özellik sessizce kapalı, geri kalan her
  şey etkilenmiyor. Dashboard'da "AI'ya Sor" kutusu.

---

## 3. Şu an ne çalışıyor? (Canlı doğrulandı ✅)

- Uçtan uca toplama zinciri: eklenti/console script → ingest → parse → dashboard
- Müdahale Defteri: gerçek fiyat/foto/reklam/bütçe değişiklikleri deftere düşüyor
- Etki Kartları: gerçek DiD/ITS hesaplaması, gerçek sayılarla doğrulandı
- Strateji Paneli + Değişim Noktaları: boş DB'de çökmeden zarifçe boş dönüyor
- AI özet export + soru-cevap: canlı sunucu ile duman testi geçti (API key'siz
  durumda doğru şekilde kapalı davranıyor; gerçek bir soruyu yanıtlamak
  kullanıcının kendi `ANTHROPIC_API_KEY`'ini gerektiriyor — bu oturumda test
  edilemedi)

**Testler**: 95/95 geçiyor, typecheck temiz (gerçek `@anthropic-ai/sdk`
tipleri dahil).

---

## 4. Henüz eksik / bilinçli ertelenen

| Alan | Neden | Not |
|------|-------|-----|
| **bulk-edit intervention'ı** | Ayrı bir tasarım gerektiriyor | Gerçek şekli yakalandı (`POST /bulk-edit`), spec'in "confounded interventions" örneği tam bu — clean_window_flagger'ın doğal bir uzantısı |
| **Etsy Ads bütçe/strateji dropdown'u** | Kısmi veri | Bütçe değişikliği tam çalışıyor, strateji seçimi yakalanmadı |
| **Marketplace Insights, Star Seller, ödeme/finans verileri** | Gerçek şekiller yakalandı ama taxonomy dışı | `docs/*` capture'larında mevcut, ileride parser eklenebilir |
| **Tam 3-pencereli etki (t+1..t+3 / t+4..t+14 / t+15..t+30)** | v1 tek pencere (t+1..t+14) kullanıyor | Yeterli gerçek geçmiş veri birikince genişletilebilir |
| **Gerçek mağazada 14+ günlük öncesi/sonrası geçmiş** | Zaman meselesi | Sentetik veriyle doğrulandı; gerçek Effect Card gerçek zamanla oluşacak |

---

## 5. Teknik notlar

- **pg-mem uyumsuzlukları** giderildi: `FILTER`, `NULLS LAST`, `GREATEST`,
  korelasyonlu `NOT EXISTS` yerine `SUM(CASE…)`/`ORDER BY`/`LEFT JOIN...IS NULL`.
- **İki kez bulunan "aggregate'i tek güne yazma" tuzağı**: hem Ads
  (`granularity`) hem Stats (`date_range`) endpoint'lerinde toplu veriyi günlük
  tabloya yazmadan önce koruma eklendi — ikisi de commit'e geçmeden test edildi.
- **Güvenlik**: `.env`, token'lar ve `ANTHROPIC_API_KEY` repoda değil
  (`.gitignore`). Dashboard/AI endpoint'leri `DASHBOARD_KEY` ile kapatılabilir.
- **Testler**: 95/95 geçiyor; typecheck temiz.

---

## 6. Nasıl çalıştırılır (özet)

```bash
cd api
npm install
npm run dev            # → http://localhost:8080 (canlı dashboard)
```
Docker/Postgres gerekmez. AI soru-cevabı için `.env`'e `ANTHROPIC_API_KEY`
ekleyin (opsiyonel, yoksa özellik sessizce kapalı kalır). Ayrıntı: `docs/LOCAL.md`.

Eklenti Options ayarları:
- Shop tag: `my-shop-01`
- API host: `http://localhost:8080`
- Bearer token: `tok_replace_me_0123456789abcdef`
- Enable forwarding: ✔

Veya eklentisiz, tarayıcı konsoluna yapıştırılan bir self-capture script'iyle
JSON yakalayıp bana iletme akışı da kullanılabilir (bkz. sohbet geçmişi).

---

## 7. Sıradaki muhtemel işler

1. bulk-edit intervention'ını ekleyip clean_window_flagger'ı güçlendirmek
2. Gerçek mağazada zamanla veri biriktikçe gerçek Effect Card'ları gözlemlemek
3. 3-pencereli etki modeline geçmek (t+1..t+3 / t+4..t+14 / t+15..t+30)
4. Marketplace Insights / Star Seller verilerini taxonomy'ye eklemek
5. `ANTHROPIC_API_KEY` ile AI soru-cevabını gerçek veriyle uçtan uca test etmek
