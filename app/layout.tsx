import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const outfit = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-outfit',
});

export const metadata: Metadata = {
  title: 'BookFerry 书渡 · 智能图书推荐系统',
  description: '基于 Agentic RAG 的个性化智能图书推荐系统',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const themeScript = `
    try {
      var mode = localStorage.getItem('bookstore-theme');
      if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'dark';
      var resolved = mode === 'system'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : mode;
      document.documentElement.classList.add(resolved);
      document.documentElement.style.colorScheme = resolved;
    } catch (_) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    }
  `;

  return (
    <html
      lang="zh-CN"
      className={`${inter.variable} ${outfit.variable} scroll-smooth`}
      suppressHydrationWarning
    >
      <head>
        <meta name="darkreader-lock" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
