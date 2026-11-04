// SPDX-License-Identifier: GPL-3.0-or-later
// A made-up printer profile for the print case: a v2 matrix/TRC profile of
// output class whose colorants are sRGB's pulled halfway to white, so
// saturated colors fall outside it. verify/print.py writes the same one.
const D50 = [0.9642, 1.0, 0.8249];
const SRGB = [[0.4361, 0.2225, 0.0139], [0.3851, 0.7169, 0.0971], [0.1431, 0.0606, 0.7141]];

const be32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const s15 = v => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b; };
const ascii = s => Buffer.from(s, 'latin1');
const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)]);

export function narrowPrinterProfile(name = 'Immage test narrow printer', squeeze = 0.5) {
  const xyz = v => Buffer.concat([ascii('XYZ '), Buffer.alloc(4), ...v.map(s15)]);
  const cols = SRGB.map(col => col.map((c, k) => squeeze * c + (1 - squeeze) * D50[k] / 3));
  const text = Buffer.concat([ascii(name), Buffer.alloc(1)]);
  const desc = Buffer.concat([ascii('desc'), Buffer.alloc(4), be32(text.length), text, Buffer.alloc(4 + 4 + 2 + 1 + 67)]);
  const curve = Buffer.concat([ascii('curv'), Buffer.alloc(4), be32(1), Buffer.from([0x02, 0x33]), Buffer.alloc(2)]);
  const cprt = Buffer.concat([ascii('text'), Buffer.alloc(4), ascii('no copyright\0')]);
  const tags = [['desc', desc], ['cprt', cprt], ['wtpt', xyz(D50)], ['rXYZ', xyz(cols[0])], ['gXYZ', xyz(cols[1])],
                ['bXYZ', xyz(cols[2])], ['rTRC', curve], ['gTRC', curve], ['bTRC', curve]];
  const offset = 128 + 4 + 12 * tags.length;
  const table = [], data = [];
  let at = 0;
  for (const [sig, body] of tags) {
    const b = pad4(body);
    table.push(ascii(sig), be32(offset + at), be32(b.length));
    data.push(b); at += b.length;
  }
  const size = offset + at;
  const header = Buffer.concat([be32(size), Buffer.alloc(4), be32(0x02100000), ascii('prtr'), ascii('RGB '), ascii('XYZ '),
    Buffer.alloc(12), ascii('acsp'), Buffer.alloc(24), be32(0), ...D50.map(s15), Buffer.alloc(48)]);
  if (header.length !== 128) throw Error('ICC header is not 128 bytes');
  return Buffer.concat([header, be32(tags.length), ...table, ...data]);
}
