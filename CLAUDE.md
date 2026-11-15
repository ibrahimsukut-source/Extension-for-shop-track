# Proje kuralları

## Kural 1 — Etsy hiçbir ortak iz görmemeli (her şeyden önce gelir)
Eklentinin/ajanın Etsy'nin kendi JavaScript'inin görebileceği hiçbir şeyi değiştirmemesi ve
mağazalar arasında ortak/aynı bir iz bırakmaması gerekir:
- Etsy sayfasının MAIN world'üne kod enjekte etme; `window` üzerinde global, `fetch`/XHR sarmalama,
  DOM değişikliği yok. Ajan işleri ISOLATED (veya userScripts USER_SCRIPT) world'de çalışır;
  `Etsy.Context` sayfanın satır içi script metninden okunur (`parseEtsyContext`).
- Pasif yakalama (`interceptor.js`, sayfanın fetch'ini sarar) varsayılan KAPALI; yalnız `passiveCapture`
  açıkken dinamik kaydedilir.
- İstek ritmi mağazaya/çalıştırmaya özgü olmalı: rastgele tempo, sayfa boyutu, çağrı sırası; merkezde
  zamanlayıcı işleri rastgele gecikmeyle başlar.
- Engel/captcha/403/429 görülürse dur, tekrar deneme.
- `e2e/agent.mjs` sayfa dünyasında iz kalmadığını test eder; bu test hep geçmeli.

Not: Aynı VPS'teki mağazalar aynı kişilere ait (kural dışı değil); bazı mağazalara farklı VPS/PC'lerden
de girilir — ajan yalnız kurulduğu Chrome'da çalışır.
