# Kurulum ve Kullanım (Chrome)

Bu eklentiyi kendi Etsy mağazanın açık olduğu Chrome'a kurup, satıcı panelinde
gezerken verileri yakalatabilirsin. **Node/npm gerekmez** — hazır `dist/` klasörü
depoda mevcut.

## 1. Dosyaları indir

1. GitHub'da depo sayfasına git:
   `https://github.com/ibrahimsukut-source/Extension-for-shop-track`
2. Dalı `claude/etsy-multi-shop-tracker-1q4jh2` seç.
3. Yeşil **Code** düğmesi → **Download ZIP**.
4. İnen ZIP'i bir klasöre çıkart. İçinde `extension/dist` klasörünü göreceksin —
   yükleyeceğimiz şey bu.

## 2. Chrome'a yükle (Load unpacked)

1. Chrome'da adres çubuğuna `chrome://extensions` yaz, Enter.
2. Sağ üstteki **Developer mode / Geliştirici modu**'nu aç.
3. **Load unpacked / Paketlenmemiş öğe yükle** düğmesine bas.
4. Az önce çıkarttığın klasördeki **`extension/dist`** klasörünü seç.
5. "Etsy Shop Tracker" listede görünecek. ✅

> İpucu: Eklenti simgesine sağ tık → **Options / Seçenekler** ile ayar sayfasını aç.

## 3. Ayarla

Seçenekler sayfasında:

- **Shop tag**: mağazan için kısa bir iç ad yaz (ör. `magaza-01`). Zorunlu olan
  tek alan bu.
- **Central API** bölümü: merkezî sunucuya göndermek istiyorsan doldur; şimdilik
  boş bırakabilirsin (veriler yerelde saklanır).

**Save**'e bas.

## 4. "Hiçbir şeyi kaçırma" — Keşif modu

Etsy'nin gerçek iç endpoint'leri zamanla değişebilir. Onları senin panelinden
öğrenmek için:

1. Seçenekler'de **"Record every JSON response…"** (Keşif modu) kutusunu işaretle,
   **Save**.
2. `https://www.etsy.com` üzerinde mağazana giriş yap ve **satıcı panelinde gez**:
   Dashboard, Stats (gün/hafta/ay), Listings, Messages, Ads, Orders… açabildiğin
   her sayfayı bir kez aç.
3. Seçenekler sayfasına dön → **Observed endpoints** bölümünde **Refresh**'e bas.
   Gezdiğin her JSON isteği burada listelenir (sayısal id'ler `{id}` ile
   sadeleştirilir).
4. **Copy summary** ile listeyi kopyala ve bana gönder — gerçek endpoint'lere
   göre `endpoints.config.json`'ı ve parser'ları keskinleştiririm. Böylece hiçbir
   şey "gürültü" diye elenmez.
5. İşin bitince keşif modunu **kapat** (sadece öğrenme için).

> Not: Pasif yakalama yalnızca tarayıcının gerçekten istediği verileri görür —
> yani **açtığın** sayfaları yakalar. Hiç açmadığın sayfa yakalanmaz; onu her gün
> otomatik gezip garanti altına alan "CDP Sweeper" (Faz 4) sonra gelecek.

## 5. Ne yakalandığını gör

- **Recent captures**: eşleşen (sınıflandırılan) son 200 kayıt.
- **Observed endpoints**: keşif modundaki tüm JSON istekleri (özet).

## Güncelleme

Kod güncellendiğinde: yeni ZIP'i indir, `chrome://extensions` sayfasında eklentinin
**Reload / Yenile** simgesine bas (veya kaldırıp `extension/dist`'i tekrar yükle).

## Güvenlik / gizlilik notu

- Kendi mağazanın panelini yakalamak düşük risklidir; yine de Etsy'nin
  otomatik erişim ve çoklu hesap politikaları gri alandır (spec §11).
- Alıcı kişisel verileri merkezî tarafta yalnızca **hash** olarak saklanır; yerel
  tampon ham JSON tutar (yalnızca senin tarayıcında).
- Eklenti sadece `https://www.etsy.com/*` üzerinde çalışır.
