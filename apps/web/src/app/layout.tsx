import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import './globals.css';

const title = 'LagShield · Autonomous Market Protection';
const description =
  'Watch LagShield autonomously protect in-play World Cup markets with TxLINE data and Solana-verifiable decision receipts.';

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const protocol = requestHeaders.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const origin = host ? `${protocol}://${host}` : 'http://localhost:3000';
  const imageUrl = new URL('/og.png', origin).toString();

  return {
    description,
    openGraph: {
      description,
      images: [
        {
          alt: 'LagShield intercepts an out-of-sync sports market and moves it from open to paused to recovery.',
          height: 630,
          url: imageUrl,
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
      images: [imageUrl],
      title,
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
