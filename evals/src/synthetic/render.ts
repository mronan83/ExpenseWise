import type { DocumentMediaType } from '@expensewise/extraction';
import { chromium, type Browser } from 'playwright-core';
import type { SyntheticDocument } from './types.ts';

export async function withBrowser<T>(work: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  try {
    return await work(browser);
  } finally {
    await browser.close();
  }
}

/**
 * PDFs keep their text layer, like a folio emailed by a hotel. Photos are tilted, softened
 * JPEGs, like a receipt snapped on a phone. The tilt comes from `variant`, so it is reproducible.
 */
export async function render(
  browser: Browser,
  doc: SyntheticDocument,
  variant: number,
): Promise<{ bytes: Uint8Array; mediaType: DocumentMediaType }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  try {
    await page.setContent(doc.html);
    if (doc.format === 'pdf') {
      return {
        bytes: await page.pdf({ format: 'Letter', printBackground: true }),
        mediaType: 'application/pdf',
      };
    }
    const angle = ((variant % 9) - 4) * 0.6;
    await page.addStyleTag({
      content: `body { transform: rotate(${angle}deg); filter: blur(0.45px) contrast(0.9) brightness(0.96); }`,
    });
    return {
      bytes: await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true }),
      mediaType: 'image/jpeg',
    };
  } finally {
    await page.close();
  }
}
