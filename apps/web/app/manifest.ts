import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ExpenseWise',
    short_name: 'ExpenseWise',
    description: 'Receipts, mileage and trips, filed for you.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f6f3',
    theme_color: '#2d43c2',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
