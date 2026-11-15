# Etsy Komuta Merkezi — Kurulum ve Kullanım

> **Canlı merkez MağazaCRM'in içinde** (`magaza-saas`: Araçlar → Etsy Reklam Merkezi, mağaza → Reklam sekmesi; ayrıntı `magaza-saas/docs/ETSY-REKLAM-AJANI.md`). Bu repodaki `api/` sürümü aynı protokolün analitik/test sunucusudur; eklenti ikisiyle de çalışır.

Her mağazanın Chrome'undaki eklenti (ajan) merkeze bağlanır. Merkez işi verir, ajan Etsy'de yapar ve sonucu geri yollar.

Ajanın yaptığı işler:

- **Raporlama:** Etsy Ads ve mağaza istatistiklerini toplar.
- **Talimat uygulama:** Merkezden gelen değişiklikleri uygular:
  - listing reklamını açar veya kapatır,
  - anahtar kelime kapatır,
  - bütçeyi değiştirir.
- **Doğrulama:** Her değişiklikten sonra Etsy'yi yeniden okur ve gerçekten olup olmadığını kontrol eder.

```
Komuta paneli (/komuta) ──talimat──▶ Merkez (agent_jobs kuyruğu)
                                         ▲            │ dakikada bir "iş var mı?"
                                         │ sonuç      ▼
                               Eklenti (her VPS'te, mağazanın kendi Chrome'u)
                                         │ arka plandaki Etsy sekmesinde, oturum açık hesapla
                                         ▼
                               Etsy iç API'leri (docs/ETSY-API-KESIF.md)
```

## Neler yapıyor

| İş | Ne toplar / ne yapar | Ne zaman |
|---|---|---|
| `collect.ads` | Bütçe ve kampanya durumu, 30 günlük günlük harcama/gösterim/tık/sipariş/gelir/ROAS, **tüm listinglerin** reklam metrikleri ve açık/kapalı durumu, dünün listing bazlı rakamları, en çok harcayan N listingin **arama terimleri** | 6 saatte bir otomatik (`COLLECT_EVERY_HOURS`) + "Şimdi topla" |
| `collect.shop_stats` | Ziyaret, sipariş, gelir, dönüşüm, ortalama sepet, trafik kaynakları, en çok ziyaret alan listingler | aynı |
| `ads.set_promoted` | Seçili listinglerin reklamını aç/kapa (50'lik parçalar halinde) | Senin talimatınla |
| `ads.set_query_relevance` | Bir listing için arama terimini kapat / tekrar aç | Senin talimatınla |
| `ads.set_budget` | Günlük bütçe (kuruş olarak gönderilir, doğrulandı) | Senin talimatınla |

Öneri motoru her toplamadan sonra çalışır. **Hiçbir şeyi kendisi uygulamaz**, öneriyi panelde senin onayına sunar:

- 30 günde ≥ $10 harcayıp 0 sipariş getiren listing → reklamı kapat.
- ROAS < 1 ve ≥ $20 harcama → reklamı kapat.
- ≥ $3 harcayan, ≥ 5 tık alan, 0 siparişli arama terimi → terimi kapat.
- Mağaza ROAS ≥ 3 ve bütçe son 7 günün en az 5'inde dolmuş → bütçeyi %25 artır.
- Mağaza ROAS < 1.2 ve ≥ $50 harcama → bütçeyi %25 azalt.

Eşikleri değiştirmek için `RULES_CONFIG` kullanılır, ör. `{"zeroSaleSpendUsd":15}`. Yoksaydığın bir öneri 14 gün boyunca tekrar gelmez.

Uygulanan her değişiklik iki yere kaydedilir:

- **Yapılan değişiklikler** kaydı: önce/sonra durumu ve doğrulandı mı bilgisi.
- **Müdahale defteri:** Böylece mevcut neden-sonuç motoru "reklamı kapattıktan sonra ne oldu" sorusunu otomatik ölçer.

## Güvenlik kuralları

- **Komutlar kısıtlı:** Ajan sadece yukarıdaki iş türlerini çalıştırır, serbest komut almaz.
- **Şifre girmez:** Etsy oturumu Chrome'da zaten açık olmalı. Oturum kapanırsa ajan iş almayı bırakır ve panelde "Etsy oturumu kapalı" yazar.
- **Engel algılarsa durur:** Etsy 403/429 döndürür ya da captcha veya JSON olmayan bir sayfa görürse ajan işi durdurur ve 2 saat bekler.
- **İnsan hızında çalışır:** İstekler arasında 0,3–1,6 sn rastgele bekleme var. Her mağazada aynı anda tek iş çalışır.
- **Limitler:**
  - `MAX_DAILY_BUDGET_USD` (varsayılan 100),
  - `MAX_LISTINGS_PER_TOGGLE` (varsayılan 200),
  - panelden mağaza bazında **Duraklat**.
- **Bütçe:** Etsy'nin bütçe isteği canlı doğrulandı (kuruş). Güvenlik sınırı varsayılan $100/gün.

## 1. Merkezi kurma

Merkez şu anda bu repodaki Fastify API'nin içinde (`api/`). Rotalar bir Fastify eklentisi olarak yazıldı (`api/src/agent/routes.ts → agentHub`). magaza-crm de Fastify ise aynı eklenti oraya `app.register(agentHub, {...})` ile takılabilir. Değilse merkez ayrı bir Fly uygulaması olarak çalışır ve magaza-crm'den bağlantı verilir.

Gerekli ortam değişkenleri:

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | Postgres (kalıcı veri için şart). Tablolar `npm run migrate` ile oluşur. |
| `INGEST_TOKENS` | `{"oldcitycherry":"tok_…","newtrendshirts":"tok_…"}` — mağaza başına bir anahtar |
| `ADMIN_KEY` | Komuta paneli şifresi |
| `PUBLIC_URL` | Merkezin dış adresi (eklenti güncellemeleri için) |
| `COLLECT_EVERY_HOURS` | Otomatik toplama aralığı (0 = sadece elle) |
| `MODULE_SIGNING_KEY` | Uzaktan mantık güncellemesi imza anahtarı (aşağıda) |
| `RULES_CONFIG`, `MAX_DAILY_BUDGET_USD`, `BUDGET_WRITE_ENABLED`, `MAX_LISTINGS_PER_TOGGLE` | Kurallar ve limitler |

Panel: `https://<merkez>/komuta`

## 2. Eklentiyi Web Store'suz dağıtma ve otomatik güncelleme

İki katman var:

1. **Eklentinin kendisi (CRX):**
   - `extension/scripts/pack.mjs` eklentiyi imzalı `.crx` olarak paketler.
   - Merkez `/ext/updates.xml` ve `/ext/agent-<sürüm>.crx` adreslerinden sunar.
   - Chrome birkaç saatte bir kontrol edip yeni sürümü kendisi kurar. Sürüm çıkarmak için `src/manifest.json`'daki `version`'ı artırıp tekrar paketlemek yeterli.
   ```
   cd extension
   EXT_SIGNING_KEY=~/guvenli/agent-ext.pem COMMAND_CENTER_URL=https://<merkez> node scripts/pack.mjs
   ```
   `.pem` dosyası eklentinin kimliğidir. Repoya koyma ve yedekle: kaybolursa eklenti kimliği değişir, tüm VPS'leri yeniden kurmak gerekir.
2. **İş mantığı (uzaktan modül):**
   - Etsy'yle konuşan kod (`page-runner`) merkezden imzalı olarak da iner. Etsy bir şeyi değiştirdiğinde düzeltme, eklentiyi yeniden paketlemeden dakikalar içinde tüm mağazalara gider.
   - Kurulum adımları:
     1. Bir kez `node api/scripts/module-keys.mjs` çalıştır.
     2. Çıkan özel anahtarı `MODULE_SIGNING_KEY` olarak sunucuya koy.
     3. Eklentiyi yeniden paketle; açık anahtar eklentinin içine gömülür.
   - İmzası tutmayan modül asla çalıştırılmaz.
   - Bu katman Chrome'da eklentinin "Kullanıcı komut dosyalarına izin ver" ayarının açık olmasını ister. Kapalıysa eklenti kendi içindeki sürümle çalışmaya devam eder.

## 3. Her Windows VPS için bir kerelik kurulum

1. **Chrome Enterprise Core'u hazırla:** Google Yönetici Konsolu'nda (ücretsiz) bir **kayıt kodu** al. Chrome, Web Store dışı eklentiyi ancak yönetilen bir tarayıcıya zorunlu kurar.
2. **Kurulum betiğini çalıştır:** VPS'te yönetici PowerShell ile:
   ```
   .\vps-kurulum.ps1 -ExtensionId <pack çıktısındaki id> -CommandCenter https://<merkez> `
       -ShopTag oldcitycherry -Token tok_… -EnrollmentToken <kayıt kodu>
   ```
3. **Politikaları yükle:** Chrome'u kapat-aç, `chrome://policy` sayfasında "Politikaları yeniden yükle"ye bas.
4. **Ayarları kontrol et:** Mağaza hesabıyla Etsy'de oturumun açık olduğundan emin ol. Eklentinin ayar sayfasında "Komuta merkezi ajanı" bölümünde "Etsy oturumu: açık" görünmeli.
5. **Panelden doğrula:** Panelde mağaza "Çevrimiçi" görünür. "Şimdi topla"ya basınca birkaç dakika içinde veriler gelir.

Bir VPS'te birden fazla mağaza varsa her mağaza kendi Chrome profilinde çalışır. Ayarlar politika yerine o profildeki eklenti ayar sayfasından girilir.

## 4. Doğrulama

- `api`: `npm test` → birim ve rota testleri (ajan protokolü, kurallar, imza).
- `extension`: `npm run build && xvfb-run -a node e2e/agent.mjs` → gerçek Chromium + eklenti + sahte etsy.com ile uçtan uca test: toplama, sayfalama, öneri ve doğrulanmış "reklamı kapat" yazması.
- Canlı salt-okuma testi: OldCityCherry'de (16 Kasım 2026) `collect.ads` 20 saniyede ve 12 istekte şunları getirdi:
  - 421 listing,
  - 168 reklamdaki listing,
  - dünün listing bazlı rakamları,
  - 3 listingin arama terimleri.
