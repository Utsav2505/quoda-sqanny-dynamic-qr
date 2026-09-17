import type { FC, PropsWithChildren } from "hono/jsx";

// Sets data-theme before first paint to avoid a flash of the wrong theme.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`;

type LayoutProps = PropsWithChildren<{
  title?: string;
  description?: string;
  /** suppress nav/footer for focused flows (auth, onboarding) */
  bare?: boolean;
}>;

export const Layout: FC<LayoutProps> = ({ title, description, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title ? `${title} · Sqanny` : "Sqanny — The QR code that never breaks"}</title>
      <meta
        name="description"
        content={description ?? "Dynamic QR codes that never break, with scan analytics. Open-source, self-hostable, built on Cloudflare."}
      />
      <link rel="stylesheet" href="/styles/tokens.css" />
      <link rel="stylesheet" href="/styles/base.css" />
      <link rel="stylesheet" href="/styles/app.css" />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
    </head>
    <body>
      {children}
      <script src="/js/theme.js" defer />
    </body>
  </html>
);
