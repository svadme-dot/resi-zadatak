import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const WIDTH = 900;
const HEIGHT = 600;
const CHANNELS = 3;
const pixels = Buffer.alloc(WIDTH * HEIGHT * CHANNELS, 255);

const GLYPHS = {
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '=': ['00000', '11111', '00000', '11111', '00000', '00000', '00000']
};

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * CHANNELS;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function fillRect(x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      setPixel(px, py, color);
    }
  }
}

function strokeRect(x, y, width, height, thickness, color) {
  fillRect(x, y, width, thickness, color);
  fillRect(x, y + height - thickness, width, thickness, color);
  fillRect(x, y, thickness, height, color);
  fillRect(x + width - thickness, y, thickness, height, color);
}

function drawGlyph(character, x, y, scale, color) {
  const rows = GLYPHS[character];
  if (!rows) return;
  rows.forEach((row, rowIndex) => {
    [...row].forEach((cell, columnIndex) => {
      if (cell === '1') {
        fillRect(
          x + columnIndex * scale,
          y + rowIndex * scale,
          scale,
          scale,
          color
        );
      }
    });
  });
}

function drawText(text, x, y, scale, color) {
  let cursor = x;
  for (const character of text) {
    drawGlyph(character, cursor, y, scale, color);
    cursor += scale * 6;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

strokeRect(28, 28, WIDTH - 56, HEIGHT - 56, 6, [198, 210, 225]);
fillRect(70, 100, WIDTH - 140, 8, [48, 94, 154]);
drawText('2X+3=11', 72, 205, 20, [20, 86, 170]);
fillRect(205, 430, 490, 5, [111, 131, 158]);
fillRect(280, 475, 340, 5, [160, 174, 193]);

const scanlines = Buffer.alloc((WIDTH * CHANNELS + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const target = y * (WIDTH * CHANNELS + 1);
  scanlines[target] = 0;
  pixels.copy(
    scanlines,
    target + 1,
    y * WIDTH * CHANNELS,
    (y + 1) * WIDTH * CHANNELS
  );
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 2;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0))
]);

const output = new URL('./linear-equation.png', import.meta.url);
await fs.writeFile(output, png);
process.stdout.write('Generated ' + fileURLPath(output) + ' (' + png.length + ' bytes)\n');

function fileURLPath(url) {
  return decodeURIComponent(url.pathname)
    .replace(/^\/([A-Za-z]:\/)/, '$1')
    .replace(/\//g, process.platform === 'win32' ? '\\' : '/');
}
