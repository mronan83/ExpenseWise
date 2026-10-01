import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fetchCord } from './datasets/cord.ts';
import { CACHE_DIR, MANIFEST } from './paths.ts';
import { seeded } from './random.ts';
import { eTicket } from './synthetic/eticket.ts';
import { hotelFolio } from './synthetic/folio.ts';
import { restaurantReceipt } from './synthetic/receipt.ts';
import { render, withBrowser } from './synthetic/render.ts';
import type { SyntheticDocument } from './synthetic/types.ts';
import type { GroundTruth, Manifest, Source } from './truth.ts';

const { values } = parseArgs({
  // `pnpm … spike -- --flag` passes the `--` through; drop it so both spellings work.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    cord: { type: 'string', default: '60' },
    synthetic: { type: 'string', default: '20' },
    seed: { type: 'string', default: '20261001' },
  },
});
const cordCount = Number(values.cord);
const perType = Number(values.synthetic);
const seed = Number(values.seed);

const extension = (mediaType: string) => (mediaType === 'application/pdf' ? 'pdf' : 'jpg');
const items: GroundTruth[] = [];

await mkdir(`${CACHE_DIR}cord`, { recursive: true });
for await (const { index, truth, bytes } of fetchCord(cordCount)) {
  const file = `cord/${index}.jpg`;
  await writeFile(`${CACHE_DIR}${file}`, bytes);
  items.push({ id: `cord-${index}`, source: 'cord', file, mediaType: 'image/jpeg', ...truth });
}
console.log(`CORD v2: ${items.length} receipts`);

const generators: [Source, (r: ReturnType<typeof seeded>) => SyntheticDocument][] = [
  ['synthetic-folio', hotelFolio],
  ['synthetic-eticket', eTicket],
  ['synthetic-receipt', restaurantReceipt],
];
await withBrowser(async (browser) => {
  for (const [source, generate] of generators) {
    await mkdir(`${CACHE_DIR}${source}`, { recursive: true });
    for (let i = 0; i < perType; i++) {
      const variant = seed + i * 31 + source.length;
      const doc = generate(seeded(variant));
      const { bytes, mediaType } = await render(browser, doc, variant);
      const file = `${source}/${i}.${extension(mediaType)}`;
      await writeFile(`${CACHE_DIR}${file}`, bytes);
      items.push({ id: `${source}-${i}`, source, file, mediaType, ...doc.truth });
    }
    console.log(`${source}: ${perType} documents`);
  }
});

const manifest: Manifest = { createdAt: new Date().toISOString(), items };
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${items.length} documents to ${CACHE_DIR} (ignored by git).`);
