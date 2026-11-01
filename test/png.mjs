// Küçük PNG çözücü — testlerin örnek çizimleri bağımlılıksız okuyabilmesi için.
// Yalnız 8 bit gri (colorType 0) ve 8 bit RGB/RGBA (2 / 6) destekler; repodaki
// örnekler bu biçimde. Tarayıcı tarafı bunu kullanmaz, canvas ile çözer.
import zlib from 'node:zlib';
import fs from 'node:fs';

const CHANNELS = { 0: 1, 2: 3, 6: 4 };

export function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG değil: ' + file);

  let pos = 8, hdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      hdr = {
        w: body.readUInt32BE(0), h: body.readUInt32BE(4),
        depth: body[8], colorType: body[9], interlace: body[12],
      };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!hdr) throw new Error('IHDR yok');
  if (hdr.depth !== 8) throw new Error(`Desteklenmeyen bit derinliği: ${hdr.depth}`);
  if (hdr.interlace) throw new Error('Interlace destekli değil');
  const ch = CHANNELS[hdr.colorType];
  if (!ch) throw new Error(`Desteklenmeyen renk türü: ${hdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = hdr;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('Bilinmeyen filtre: ' + filter);
      }
      cur[i] = v & 0xff;
    }
  }

  // ImageData biçimine (RGBA) çevir
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const s = p * ch, d = p * 4;
    if (ch === 1) { data[d] = data[d + 1] = data[d + 2] = out[s]; data[d + 3] = 255; }
    else { data[d] = out[s]; data[d + 1] = out[s + 1]; data[d + 2] = out[s + 2]; data[d + 3] = ch === 4 ? out[s + 3] : 255; }
  }
  return { width: w, height: h, data };
}
