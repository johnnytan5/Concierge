import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Room Service Ops',
  description: 'Admin surface for the voice-dispatched hotel delivery fleet',
};

// Archivo is pulled in by globals.css's own @import — one mechanism for the
// webfont, not a <link> here as well.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
