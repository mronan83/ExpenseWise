import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExpenseWise',
  description: 'Receipts, mileage and trips, filed for you.',
  applicationName: 'ExpenseWise',
  appleWebApp: { capable: true, title: 'ExpenseWise', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6f3' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1211' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
