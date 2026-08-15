'use strict';
// Generates assets/icon.ico, assets/icon.png, assets/tray.png from the official
// DeepSeek favicon SVG (assets/source/favicon.svg), recoloured to the DeepSeek
// brand blue #4D6BFE for visibility on light and dark surfaces.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const SRC = path.join(ASSETS, 'source', 'favicon.svg');

async function main() {
  let svg = fs.readFileSync(SRC, 'utf8');
  // librsvg ignores @media, so drop the dark-mode override and fix the colour.
  svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
  svg = svg.replace(/fill="#000"/g, 'fill="#4D6BFE"');

  // Render once at high resolution, then downscale for crisp smaller sizes.
  const master = await sharp(Buffer.from(svg), { density: 400 }).png().toBuffer();

  const sizes = [16, 32, 48, 256];
  const pngs = {};
  for (const s of sizes) {
    pngs[s] = await sharp(master).resize(s, s).png().toBuffer();
  }

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs[256]);
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), pngs[32]);

  const { default: pngToIco } = await import('png-to-ico');
  const ico = await pngToIco([pngs[16], pngs[32], pngs[48], pngs[256]]);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);

  console.log('icons generated: icon.ico, icon.png, tray.png');
}

main().catch((e) => {
  console.error('icon generation failed:', e);
  process.exit(1);
});
