import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/app.ts';

// The committed contract. The iOS client is generated from this file, so CI fails
// when code and contract drift apart (gate G3).
const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
const generated = `${JSON.stringify(openApiDocument(), null, 2)}\n`;

const mode = process.argv[2];
if (mode === 'write') {
  await writeFile(target, generated);
  console.log(`Wrote ${target}`);
} else if (mode === 'check') {
  const committed = await readFile(target, 'utf8').catch(() => '');
  if (committed !== generated) {
    console.error(
      'openapi.json is out of date with the code. Run `pnpm --filter @expensewise/api contract:generate` and commit the result.',
    );
    process.exit(1);
  }
  console.log('openapi.json matches the code.');
} else {
  console.error('Usage: tsx scripts/openapi.ts write|check');
  process.exit(2);
}
