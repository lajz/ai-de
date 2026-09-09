import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'FDE Context',
  description: 'Read-only engagement view over the FDE context platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
