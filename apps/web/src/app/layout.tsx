import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

const title = 'LagShield · Autonomous Market Protection';
const description =
  'Watch LagShield autonomously protect in-play World Cup markets with TxLINE data and Solana-verifiable decision receipts.';

const metadataBase = new URL(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000');

export const metadata: Metadata = {
  description,
  metadataBase,
  openGraph: {
    description,
    images: [
      {
        alt: 'LagShield intercepts an out-of-sync sports market and moves it from open to paused to recovery.',
        height: 630,
        url: '/og.png',
        width: 1200,
      },
    ],
    title,
    type: 'website',
  },
  title,
  twitter: {
    card: 'summary_large_image',
    description,
    images: ['/og.png'],
    title,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
