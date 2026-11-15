# Etsy Satıcı Paneli — İç API Keşfi (Kasım 2026)

Kaynak: OldCityCherry (shop_id 23861781) panelinde canlı inceleme, 16 Kasım 2026.
Yöntem: `performance.getEntriesByType('resource')` ile sayfanın çağırdığı uç noktalar,
GET uç noktalarının yanıt şekilleri, yüklü JS paketlerindeki istek tanımları
(`/api/v3/ajax/shop/{id}/…`, `type`, `data`). Hiçbir ayar değiştirilmedi.

Tüm istekler `https://www.etsy.com/api/v3/ajax/shop/{SHOP_ID}` altında ve oturum
çerezleriyle çalışır. Yazma isteklerinde başlıklar:

- `x-csrf-token`: `document.querySelector('meta[name="csrf_nonce"]').content`
- `x-detected-locale`: `USD|en-US|US` biçimi (para birimi | dil | bölge)
- gövde: JSON (`content-type: application/json`)

Para tutarları kuruş (minor unit) tamsayıdır: `spentTotal 4810` = $48.10.

## 1. Sayfa içi başlangıç verisi

Ads ve Stats sayfaları verinin büyük kısmını HTML içine gömer:
`window.Etsy.Context.data.initial_data`. Sayfa açılınca ayrıca istek atılmaz;
bu yüzden ajan ya sayfayı açıp bu nesneyi okur ya da aşağıdaki uç noktaları çağırır.

- `Etsy.Context.data.shop_id`, `shop_name`, `locale_settings.currency.code`
- Ads sayfası: `initial_data.etsyAds` → `campaign`, `campaignShopStats`,
  `campaignListingsStats` (15'lik sayfa, `filteredListingIds` tam liste),
  `campaignMinBudget`/`campaignMaxBudget` (`budgetInCents`), `promotedListingsCount`,
  `etsyadsMetricsFreshness {latestServeTime,isStale}`, `trendingQueries`.
- Stats sayfası (`/your/shops/me/stats?date_range=last_30`): `initial_data` →
  `metrics_summary {visits,orders,revenue,conversion_rate,average_order_value}`
  (her biri `total` + günlük `entries[{value,timestamp,label}]`),
  `traffic_breakdown {etsy_traffic,user_traffic}.traffic_sources[{source_key,short_key,visits,…}]`,
  `listings {listings[{id,title,visits,orders,revenue,favorites}], pagination{per_page:5,total_count}}`,
  `date_ranges[{key,display_name}]` (today, yesterday, last_7, last_30, this_month, this_year, …),
  `offsite_ads_status`, `offsite_fee_rate`, `share_and_save_stats_summary`.

## 2. Etsy Ads — okuma (GET)

| Uç nokta | Parametreler | Yanıt |
|---|---|---|
| `/prolist/campaign` | – | `{totalDailyBudget, isActive, status, createDate, updateDate}` |
| `/prolist/stats` | `start_date, end_date, comparison_start_date, comparison_end_date` (YYYY-MM-DD) | `{startDate,endDate,granularity,graphStats[],totalStats,comparisonGraphStats[],comparisonTotalStats}` |
| `/prolist/stats/listings` | `start_date,end_date,sort_type,sort_order,offset,limit,query,is_promoted,…` | `campaignListingsStats` ile aynı şekil: `listings[{listing{listingId,title,isPromoted,priceInt,currencyCode,quantity,state,sectionName,tags,listingStrategy{strategy},listingGroup},totalStats}]`, `filteredListingCount`, `totals` |
| `/prolist/stats/listings/{listing_id}` | tarih + karşılaştırma | `{listing, graphStats[31], totalStats, comparison…}` |
| `/prolist/listings/querystats/{listing_id}` | `start_date=MM/DD/YYYY, sort_type=stemmed_query, sort_order=1` | `query_stats[{stemmed_query, impression_counts, click_count, order_count, cost, revenue, roas, click_rate, is_relevant, search_term_mapping{title_phrases,tags}}]` |
| `/prolist/listing-query/{listing_id}` | `limit, offset` | kapatılmış (alakasız) aramalar listesi |
| `/prolist/campaign/revenue/stats` | `listing_id,start_date,end_date` | `{total_revenue,total_number_of_orders,avg_time_from_click_to_sale_in_ms,…}` |
| `/prolist/campaign/revenue/attribution` | `listing_id` | `attribution_events[{receipt_id,revenue,click_date,click_origin_page_type,sold_listings[],purchase_date}]` (reklam tıkı → hangi ürün satıldı) |
| `/api/v3/ajax/member/prolist/recommended-tags` | `listing_id` | `{recommended_tags[], irrelevant_tags[]}` |
| `/prolist/listing-groups` | – | `{groups[]}` |
| `/prolist/campaign/budget/history`, `/prolist/campaign/goals`, `/prolist/credit-limit`, `/prolist/promotion-status`, `/prolist/trending-queries` | – | yardımcı |

Keyword tablosu (panelde "Targeted keywords"): ROAS, Orders, Spend, Revenue, Clicks,
Click rate, Views ve "Relevant keyword?" anahtarı = `is_relevant`.

## 3. Etsy Ads — yazma (JS paketlerinden çıkarılan tanımlar)

| İşlem | İstek | Gövde |
|---|---|---|
| Listing reklamını aç/kapa | `POST /prolist/listings` | `{listings: {"<listing_id>": true/false, …}}` → `{listings, countOfAdvertisedListings}` |
| Arama terimini kapat/aç | `POST /prolist/listing-query` | `{listing_id, query, is_relevant}` |
| Listing stratejisi | `POST /prolist/listings/strategy` | `{listings: …}` (yapı canlı yakalanmalı) |
| Günlük bütçe | `PUT /prolist/campaign-budget` | `{budget, ignore_credit_limit?}` → `{totalDailyBudget,…}` — **birim (kuruş/dolar) canlı doğrulanmadı** |
| Kampanya oluştur | `POST /prolist/campaign` | `{budget}` |
| Kampanyayı yeniden başlat | `PUT /prolist/campaign-restart` | `{budget}` |
| Önerilen tag'leri uygula | `POST /prolist/recommended-tags/update` | `{listing_id, tags, skip_campaign_check?}` |
| Reklam grubu üyeliği | `PUT /prolist/listing-groups/memberships` | `{listing_ids, group_id}` |

Bütçe birimi ve strateji gövdesi doğrulanana kadar ajan bu iki işlemi
"doğrulanmamış" sayar ve çalıştırmaz (bkz. `extension/src/agent/jobs.ts`).

## 4. Stats

- Trafik detayı: `GET /api/v3/ajax/bespoke/shop/{id}/stats/traffic-detail/{kaynak}?date_range=last_30`
  (kaynak: `etsysearch`, `other_pages_on_etsy`, `external_search`, `social`, `misc`)
- Listing istatistik sayfası: `/your/shops/me/stats/listings/{listing_id}`
- Panel kartları: `/stats/slim-stats` (mevcut parser)
