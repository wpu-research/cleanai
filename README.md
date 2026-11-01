# CleanAi — PLC Temiz Oda 3D

Teknik çizimden türetilmiş, içinde dolaşılabilen 3D temiz oda + PLC/HMI ekranı için
arka plan görseli ve canlı veri bağlanacak SVG katmanları.

## Çalıştırma

```bash
npm install
npm start          # http://localhost:5177
npm test           # geometri + HMI katman doğrulaması
```

## Kullanım

| Tuş / Düğme | İşlev |
|---|---|
| `1` / `2` | Plan A (kare + koridor) / Plan B (L + soyunma-airlock) |
| `V` | Yürü ↔ Maket görünümü (maket modunda tavan kalkar) |
| Tıkla | Fare kilidi (yürüyüş modu) |
| `W A S D` | Yürü · `Shift` koş · `C` çömel |
| `E` | En yakın kapıyı aç/kapat |
| `R` | Kamerayı başa al |
| `H` veya düğme | HMI arka planı + katmanları indir |

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

`H` ile üç dosya iner:

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
src/app.js   sahne, yürüyüş kontrolü, dışa aktarım
test/        geometri ve katman doğrulaması
hmi/         üretilmiş SVG katmanları ve etiket eşlemeleri
```
