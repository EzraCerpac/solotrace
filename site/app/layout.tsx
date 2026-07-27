import type { Metadata } from "next";
import "./globals.css";

const publicOrigin = process.env.SOLOTRACE_PUBLIC_ORIGIN ?? "https://solotrace-app.openai.site";

export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin),
  title: {
    default: "SoloTrace · Free guitar tab example studio",
    template: "%s · SoloTrace",
  },
  description:
    "Play, edit, refinger, compare, and export three free guitar-solo examples. No key or upload required.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    type: "website",
    title: "SoloTrace",
    description: "Hear it. Trace it. Play it — free, editable guitar-solo examples.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "SoloTrace review-first chord lane aligned with guitar tablature",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SoloTrace",
    description: "Hear it. Trace it. Play it — free, editable guitar-solo examples.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
