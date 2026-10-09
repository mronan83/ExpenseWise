import type { MetadataRoute } from 'next';

/** Installed to a home screen: the Carbon mark, on paper (docs/brand.md). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ExpenseWise',
    short_name: 'ExpenseWise',
    description: 'Receipts, mileage and trips, filed for you.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f5f8',
    theme_color: '#f4f5f8',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
