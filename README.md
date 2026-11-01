# CleanAi — PLC Temiz Oda 3D

Teknik çizimden türetilmiş, içinde dolaşılabilen 3D temiz oda + PLC/HMI ekranı için
arka plan görseli ve canlı veri bağlanacak SVG katmanları.

**Canlı:** https://cleanai-production-a816.up.railway.app

## Çalıştırma

```bash
npm install
npm start          # http://localhost:5177
npm test           # geometri, HMI katmanı ve API testleri
```

## Kullanım

| Tuş / Düğme | İşlev |
|---|---|
| Sağdaki liste | Proje seç / aç |
| `Ctrl+S` | Kaydet |
| `V` | Yürü ↔ Maket görünümü (maket modunda tavan kalkar) |
| Tıkla | Fare kilidi (yürüyüş modu) |
| `W A S D` | Yürü · `Shift` koş · `C` çömel |
| `E` | En yakın kapıyı aç/kapat |
| `R` | Kamerayı başa al |
| `H` veya **İndir** | HMI arka planı + katmanları indir |
| **HMI yayınla** | Çıktıyı sunucuya yazıp PLC için sabit adres üret |

## Projeler

Projeler sunucuda tutulur; her kayıt sürüm numarasını artırır.

| Uç nokta | İşlev |
|---|---|
| `GET /api/projects` | Proje listesi (ad, alan, sürüm, HMI durumu) |
| `GET /api/projects/:id` | Tek proje + plan verisi |
| `POST /api/projects` | Yeni proje (`{name, plan}`) — plan doğrulanmadan kaydedilmez |
| `PUT /api/projects/:id` | Güncelle (sürüm artar) |
| `DELETE /api/projects/:id` | Sil (HMI çıktıları da temizlenir) |
| `POST /api/projects/:id/hmi` | HMI çıktısını yayınla |

Arayüzdeki **Ölçüleri düzenle** panelinden plan JSON'u tarayıcıda değiştirilir;
**Doğrula ve uygula** hatalı ölçüyü (duvar dışına taşan kapı, çakışan açıklık,
tavanı aşan pencere) sahneye yansıtmadan reddeder. **Kaydet** / `Ctrl+S` sunucuya yazar.

Depolama `DATA_DIR` altındadır (Railway'de `/data` kalıcı diski), yani yeniden
dağıtımda projeler ve HMI çıktıları durur.

## Ölçü değiştirme

Tüm geometri `data/plan-a.json` ve `data/plan-b.json` dosyalarından üretilir.
**Gerçek ölçüler geldiğinde sadece bu dosyalar değişir**, kodda değişiklik gerekmez.

- Birim: **metre**. Koordinat `x` sağa, `z` aşağı — teknik çizimdeki gibi.
- `zones[].polygon` → oda sınırı (zemin, tavan ve alan hesabı buradan)
- `walls[]` → `a`/`b` uç noktaları; `openings[]` duvarın `a` ucundan ölçülen
  `center` (m), `w` genişlik, `h` yükseklik, `sill` döşemeden yükseklik
- `wallHeight`, `wallThickness` → kat yüksekliği ve panel kalınlığı
- `ceiling.hepa / lights / returns`, `sensors` → tavan ve duvar ekipmanı
- `spawn` → yürüyüşün başladığı nokta ve bakış açısı (derece)

Değişiklikten sonra `npm test` açıklıkların duvar içinde kaldığını, çakışmadığını
ve kapıdan geçilebildiğini doğrular.

### Simge karşılıkları (teknik çizim → 3D)

| 2D simge | Model |
|---|---|
| Çeyrek daire yay | Standart temiz oda kapısı — çift gözetleme camı, yuvarlak gösterge + kare kumanda paneli |
| Kutu + iki eğik çizgi | Pass-box (malzeme geçiş kutusu) — turkuaz camlı, çift taraflı kapak |

## PLC / HMI çıktısı

**HMI yayınla** düğmesi çıktıyı sunucuya yazar ve PLC'nin doğrudan açabileceği
sabit adresleri üretir — ekran yenilendiğinde son yayınlanan hâli gelir:

```
/hmi/<proje-id>/            katmanlar bindirilmiş hazır ekran
/hmi/<proje-id>/bg.png      arka plan
/hmi/<proje-id>/layers.svg  katmanlar
/hmi/<proje-id>/tags.json   sinyal eşlemesi
```

`H` ile aynı çıktı yerel dosya olarak iner:

- `<plan>-hmi-bg.png` — tepeden ortografik arka plan (tavan plakası gizli)
- `<plan>-hmi-layers.svg` — PNG'nin üstüne **birebir oturan** katmanlar
- `<plan>-hmi-tags.json` — hangi SVG id'sine hangi sinyalin bağlanacağı

SVG'nin `viewBox`'ı plan koordinatlarıyla (metre) aynıdır, `width`/`height` ise PNG
pikseliyle. Bu yüzden PNG'yi büyütüp küçültsen de katman hizalı kalır:

```html
<div style="position:relative">
  <img src="plan-b-hmi-bg.png" style="width:100%">
  <object data="plan-b-hmi-layers.svg" style="position:absolute;inset:0;width:100%"></object>
</div>
```

Katmanlar: `layer-zones`, `layer-doors`, `layer-passboxes`, `layer-hepa`,
`layer-lights`, `layer-return`, `layer-sensors`.

Canlı veri bağlama örneği:

```js
document.getElementById('door-D1').setAttribute('class', open ? 'door' : 'door closed');
document.getElementById('value-DP-1').textContent = dp.toFixed(1) + ' Pa';
document.getElementById('zone-Z1').classList.toggle('alarm', dp < 10);
```

Çözünürlük üst çubuktaki `px/m` kutusundan seçilir (160 px/m = 1 metre 160 piksel).

## Yapı

```
data/        plan tanımları (tek doğruluk kaynağı — ölçüler burada)
src/build.js duvar/kapı/pass-box/tavan geometrisi + çarpışma
src/hmi.js   HMI arka plan render'ı, SVG katmanları, etiket eşlemesi
src/validate.js plan doğrulama (tarayıcı + sunucu + test ortak)
src/app.js   sahne, yürüyüş kontrolü, proje paneli, dışa aktarım
server.js    proje kaydı, kalıcı depolama, HMI sabit adresleri
test/        geometri, katman ve API uçtan uca testleri
hmi/         üretilmiş SVG katmanları ve etiket eşlemeleri
```
