/**
 * Draws every brand file from one geometry (docs/brand.md, ADR-0049): the mark, the wordmark
 * and lockups as SVG, with the wordmark's letters as outlines so no font is needed to show it;
 * the app icons and the share image as PNG, rendered by Chromium.
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=… pnpm --filter @expensewise/web brand:assets
 *
 * Its output is committed, so builds never run it. Run it again after changing anything here.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import opentype from 'opentype.js';

const require = createRequire(import.meta.url);
const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const fontFile = (weight) =>
  require.resolve(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff`);

/** The brand's fixed colors, the light theme's tokens (apps/web/app/globals.css). */
const CARBON = '#2d43c2';
const PAPER = '#f4f5f8';
const INK = '#141729';
const INK_2 = '#4a4f66';
const INK_DARK = '#e6e8f0';

/**
 * The mark on a 64-point grid: a receipt whose torn bottom edge is a W, with two printed lines.
 * The tear runs from the right edge down to 51, up to 43 at the middle, down again and back up.
 */
const RECEIPT = 'M20 12h24a3 3 0 0 1 3 3v27l-6 9-9-8-9 8-6-9V15a3 3 0 0 1 3-3z';
const LINES = 'M23.5 21h17M23.5 28h11';

/** The mark as a rounded tile, for the favicon and anywhere the tile sits on a page. */
const mark = (tile = CARBON, paper = '#ffffff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${tile}"/><path d="${RECEIPT}" fill="${paper}"/><path d="${LINES}" stroke="${tile}" stroke-width="3.2" stroke-linecap="round"/></svg>`;

/**
 * The mark filling its square, for icons a platform rounds or masks itself (iOS, Android's
 * maskable icons). `scale` keeps the receipt inside a maskable icon's safe circle.
 */
const fullBleed = (scale = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${CARBON}"/><g transform="translate(32 31.5) scale(${scale}) translate(-32 -31.5)"><path d="${RECEIPT}" fill="#ffffff"/><path d="${LINES}" stroke="${CARBON}" stroke-width="3.2" stroke-linecap="round"/></g></svg>`;

/** "Expense" in Plex Sans SemiBold and "Wise" in Regular, as outlines, with its width. */
async function wordmark(size) {
  const [bold, regular] = await Promise.all(
    [600, 400].map(async (w) => opentype.parse((await readFile(fontFile(w))).buffer)),
  );
  const first = bold.getPath('Expense', 0, 0, size);
  const firstWidth = bold.getAdvanceWidth('Expense', size);
  const second = regular.getPath('Wise', firstWidth, 0, size);
  const width = firstWidth + regular.getAdvanceWidth('Wise', size);
  return { d: first.toPathData(2) + second.toPathData(2), width, capHeight: size * 0.698 };
}

async function lockups() {
  const size = 40;
  const { d, width, capHeight } = await wordmark(size);
  const gap = 16;
  const height = 64;
  // The wordmark's capitals sit centred on the mark.
  const baseline = height / 2 + capHeight / 2;
  const total = Math.ceil(64 + gap + width);
  const lockup = (ink, tile, paper) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}"><g>${mark(tile, paper).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g><path transform="translate(${64 + gap} ${baseline.toFixed(2)})" d="${d}" fill="${ink}"/></svg>`;
  const wordOnly = (ink) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${(-capHeight - 6).toFixed(2)} ${Math.ceil(width)} ${(capHeight + 16).toFixed(2)}"><path d="${d}" fill="${ink}"/></svg>`;
  return {
    'lockup.svg': lockup(INK, CARBON, '#ffffff'),
    'lockup-dark.svg': lockup(INK_DARK, '#9aa7ff', '#0e1018'),
    'wordmark.svg': wordOnly(INK),
    'wordmark-dark.svg': wordOnly(INK_DARK),
  };
}

async function render(browser, html, width, height, file, transparent = true) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? 'transparent' : PAPER}}svg{display:block;width:100%;height:100%}</style></head><body>${html}</body></html>`,
  );
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
  console.log('wrote', file.replace(`${web}/`, ''));
}

async function main() {
  const brand = join(web, 'public', 'brand');
  await mkdir(brand, { recursive: true });
  const files = {
    'mark.svg': mark(),
    'mark-dark.svg': mark('#9aa7ff', '#0e1018'),
    'mark-full-bleed.svg': fullBleed(),
    ...(await lockups()),
  };
  for (const [name, svg] of Object.entries(files)) {
    await writeFile(join(brand, name), `${svg}\n`);
    console.log('wrote', `public/brand/${name}`);
  }
  // The favicon Next serves for every page.
  await writeFile(join(web, 'app', 'icon.svg'), `${mark()}\n`);
  console.log('wrote app/icon.svg');

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    // iOS rounds the icon itself, so it is full-bleed with no transparency.
    await render(browser, fullBleed(), 180, 180, join(web, 'app', 'apple-icon.png'), false);
    await render(browser, mark(), 192, 192, join(web, 'public', 'icon-192.png'));
    await render(browser, mark(), 512, 512, join(web, 'public', 'icon-512.png'));
    // Android masks to any shape inside a circle of 80% of the width: the receipt stays inside.
    await render(
      browser,
      fullBleed(0.86),
      512,
      512,
      join(web, 'public', 'icon-maskable-512.png'),
      false,
    );
    // The share image: the lockup on paper, with the line the app is described by.
    const plex = (w) =>
      `url(data:font/woff;base64,${readFileSync(fontFile(w)).toString('base64')})`;
    const share = `<style>@font-face{font-family:Plex;font-weight:400;src:${plex(400)}}
      .card{width:1200px;height:630px;background:${PAPER};display:grid;place-content:center;gap:36px;justify-items:center;font-family:Plex}
      .card svg{width:560px;height:auto}.card p{margin:0;font-size:34px;color:${INK_2}}
      .tear{position:absolute;left:0;right:0;bottom:0;height:22px;background:${CARBON};clip-path:polygon(0 100%,0 40%,4% 0,8% 40%,12% 0,16% 40%,20% 0,24% 40%,28% 0,32% 40%,36% 0,40% 40%,44% 0,48% 40%,52% 0,56% 40%,60% 0,64% 40%,68% 0,72% 40%,76% 0,80% 40%,84% 0,88% 40%,92% 0,96% 40%,100% 0,100% 100%)}</style>
      <div class="card">${files['lockup.svg']}<p>Receipts, mileage and trips, filed for you.</p></div><div class="tear"></div>`;
    await render(browser, share, 1200, 630, join(web, 'app', 'opengraph-image.png'), false);
  } finally {
    await browser.close();
  }
}

await main();
