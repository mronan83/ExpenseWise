import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SecondFactorGate, StepUpPrompt } from './second-factor';
import { TabBar } from './tab-bar';

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
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        {children}
        <TabBar />
        <StepUpPrompt />
        <SecondFactorGate />
      </body>
    </html>
  );
}
