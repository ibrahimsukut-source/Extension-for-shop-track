# Sistemi kendi bilgisayarında canlı çalıştır (localhost)

Amaç: Etsy panelinde gezerken verinin **anında** yerel bir panele düşmesini
görmek. Adımlar (tek makinede):

## 1. Veritabanı + API'yi başlat

Docker varsa en kolayı:

```bash
cd api
cp .env.example .env      # AUTO_PARSE=true zaten açık; INGEST_TOKENS içindeki token'ı not al
docker compose up -d      # PostgreSQL
npm install
npm run migrate           # tabloları kurar
npm run dev               # API + canlı dashboard  → http://localhost:8080
```

Docker yoksa: `.env` içindeki `DATABASE_URL`'i kendi Postgres'ine çevir, aynı
`migrate` + `dev` adımlarını çalıştır.

`.env` içindeki **INGEST_TOKENS** şuna benzer:
`{"my-shop-01":"tok_....."}` — buradaki **shop_tag** ve **token**'ı birazdan
eklentiye gireceğiz.

## 2. Dashboard'u aç

Tarayıcıda **http://localhost:8080** → "Etsy Shop Tracker" paneli açılır. Sağ
üstte yeşil nokta + "live" yazar; her 4 saniyede kendini yeniler. Henüz veri
yoksa tablolar boştur — birazdan dolacak.

## 3. Eklentiyi yerel API'ye bağla

1. Eklentiyi güncel `extension/dist` ile yükle/yenile (manifest'e `localhost`
   izni eklendi).
2. Eklenti → **Options**:
   - **Shop tag**: `.env`'deki shop_tag (ör. `my-shop-01`)
   - **Ingestion API host**: `http://localhost:8080`
   - **Bearer token**: `.env`'deki o mağazanın token'ı
   - **Enable forwarding** kutusunu işaretle → **Save**
   - (Kaydederken Chrome `localhost` için izin isteyebilir → izin ver.)

## 4. Canlı test

Etsy satıcı panelinde gez: **Stats**, **Listings**, **Ads**, **Orders**,
**Messages**. Her açtığın sayfa:
`eklenti → http://localhost:8080/ingest/http → PostgreSQL → (AUTO_PARSE) parse`
zincirinden geçer ve **dashboard birkaç saniye içinde güncellenir**:

- **Etsy Ads** — günlük tıklama/gösterim/harcama
- **Shop stats** — ziyaret/görüntülenme/sipariş/dönüşüm + trafik kaynakları
- **Derived events** — fiyat/etiket/foto/durum değişimlerin (senin aksiyonların)
- **Top listings / snapshots** — ürün performansı ve durum geçmişi
- **Capture pipeline** — ham → parse edilen sayıları

## Açılmıyorsa (sorun giderme)

`http://localhost:8080` açılmıyorsa sırayla kontrol et:

- **API çalışıyor mu?** `npm run dev` çalışan bir terminalde durmalı. Kapanıp
  hata veriyorsa mesajı oku:
  - `DATABASE_URL is required` → `api/.env` yok ya da boş. `cp .env.example .env`
    yaptın mı? (`.env` artık otomatik yükleniyor, ayrıca export gerekmez.)
  - `ECONNREFUSED ... 5432` → PostgreSQL çalışmıyor. `docker compose up -d` (veya
    kendi Postgres'in) ayakta mı? `.env`'deki `DATABASE_URL` doğru mu?
- **migrate koştu mu?** İlk kez `npm run migrate` gerekiyor (tabloları kurar).
- **Port dolu mu?** 8080 başka bir şeyde ise `.env`'de `PORT=8081` yapıp
  `http://localhost:8081` aç.
- **Docker yok mu?** Docker kurmak istemiyorsan yerel bir PostgreSQL kur ve
  `DATABASE_URL`'i ona göre yaz; gerisi aynı.
- Sadece sayfa açılıp tablolar “disconnected” diyorsa: API ayakta ama DB'ye
  bağlanamıyor → yine Postgres/`DATABASE_URL` kontrolü.

> Not: Bu sistem **senin makinende** çalışır; internette hazır bir adres yoktur.
> `npm run dev` çalışırken tarayıcıda `http://localhost:8080` açılır.

## Notlar
- Bu panel **salt-okunur** ve yereldir. İnternete açacaksan `.env`'de
  `DASHBOARD_KEY=...` ver ve paneli `http://host:8080/?key=...` ile aç.
- `AUTO_PARSE=false` yaparsan parse'ı elle çalıştırırsın: `npm run parse`.
- Reklam ham verisi: reklam endpoint'leri (`prolist/*`, `offsite-ads*`,
  `etsyads`) **ads** olarak sınıflanıp ham katmanda saklanır — hiçbir şey
  kaybolmaz. Yapısal alanlar (harcama/gösterim/ROAS) için ilgili reklam
  cevaplarının gövdesi geldikçe parser genişletilir.
