# Sistemi kendi bilgisayarında canlı çalıştır (localhost)

Amaç: Etsy panelinde gezerken verinin **anında** yerel bir panele düşmesini
görmek. Adımlar (tek makinede):

## 1. API'yi başlat (Docker/Postgres GEREKMEZ)

En kolay yol — **hiçbir şey kurmadan**, bellek-içi veritabanıyla:

```bash
cd api
npm install
npm run dev        # API + canlı dashboard → http://localhost:8080
```

Bu kadar. `DATABASE_URL` verilmezse sistem **bellek-içi** (in-memory) bir
veritabanı kullanır — Docker/PostgreSQL kurmana gerek yok. Tek uyarı: sunucuyu
kapatınca veri sıfırlanır (canlı test için ideal).

Varsayılan giriş token'ı `my-shop-01` mağazası için
`tok_replace_me_0123456789abcdef` (kod içinde). Kendi token'ını vermek istersen
`cp .env.example .env` yapıp `INGEST_TOKENS`'i düzenle — `.env` otomatik yüklenir.

**Verinin kalıcı olmasını istersen** (opsiyonel): gerçek bir PostgreSQL kur
(ör. Mac'te [Postgres.app](https://postgresapp.com) — indir, aç, Start), sonra
`cp .env.example .env` yapıp `DATABASE_URL`'i ona çevir ve bir kez
`npm run migrate` çalıştır.

## 2. Dashboard'u aç

Tarayıcıda **http://localhost:8080** → "Etsy Shop Tracker" paneli açılır. Sağ
üstte yeşil nokta + "live" yazar; her 4 saniyede kendini yeniler. Henüz veri
yoksa tablolar boştur — birazdan dolacak.

## 3. Eklentiyi yerel API'ye bağla

1. Eklentiyi güncel `extension/dist` ile yükle/yenile (manifest'e `localhost`
   izni eklendi).
2. Eklenti → **Options**:
   - **Shop tag**: `my-shop-01` (varsayılan; `.env` kullanıyorsan oradaki)
   - **Ingestion API host**: `http://localhost:8080`
   - **Bearer token**: `tok_replace_me_0123456789abcdef` (varsayılan;
     `.env` kullanıyorsan oradaki token)
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

- **`npm install` yaptın mı?** `tsx: command not found` görürsen yapmamışsındır.
  `cd api && npm install`.
- **Doğru klasörde misin?** Terminalde `ls` (Mac) çıktısında `package.json`,
  `src`, `public` görünmeli. Görünmüyorsa `cd .../Extension-.../api`.
- **API çalışıyor mu?** `npm run dev` çalışan terminalde AÇIK kalmalı; loglar
  akmalı. Kapanıp hata veriyorsa o satırı bana yolla.
- **Port dolu mu?** 8080 başka bir şeyde ise `PORT=8081 npm run dev` yapıp
  `http://localhost:8081` aç.

> Not: Artık **Docker/Postgres gerekmiyor** — `DATABASE_URL` verilmezse
> bellek-içi veritabanı kullanılır. Bu sistem **senin makinende** çalışır;
> internette hazır bir adres yoktur. `npm run dev` çalışırken
> `http://localhost:8080` açılır.

## Notlar
- Bu panel **salt-okunur** ve yereldir. İnternete açacaksan `.env`'de
  `DASHBOARD_KEY=...` ver ve paneli `http://host:8080/?key=...` ile aç.
- `AUTO_PARSE=false` yaparsan parse'ı elle çalıştırırsın: `npm run parse`.
- Reklam ham verisi: reklam endpoint'leri (`prolist/*`, `offsite-ads*`,
  `etsyads`) **ads** olarak sınıflanıp ham katmanda saklanır — hiçbir şey
  kaybolmaz. Yapısal alanlar (harcama/gösterim/ROAS) için ilgili reklam
  cevaplarının gövdesi geldikçe parser genişletilir.
