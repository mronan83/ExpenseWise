import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// IBM Plex, served with the app rather than from a font host (docs/brand.md): each weight the
// screens use, and only the scripts a page needs are downloaded.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import {
  AuthenticatorRequiredScreen,
  NotLetInScreen,
  SecondFactorGate,
  StepUpPrompt,
} from './second-factor';
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
    { media: '(prefers-color-scheme: light)', color: '#f4f5f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1018' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        {children}
        <TabBar />
        <StepUpPrompt />
        <AuthenticatorRequiredScreen />
        <NotLetInScreen />
        <SecondFactorGate />
      </body>
    </html>
  );
}
