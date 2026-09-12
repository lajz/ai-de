import type { Metadata } from 'next';
import { IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import Link from 'next/link';

import './globals.css';

const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FDE Context',
  description: 'Read-only engagement view over the FDE context platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${publicSans.variable} ${plexMono.variable}`}>
      <body>
        <header className="app-bar">
          <Link href="/" className="app-mark">
            <span className="app-mark-glyph" aria-hidden="true" />
            FDE Context
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
