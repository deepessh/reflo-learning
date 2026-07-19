import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Reflo",
  description: "A self-improving tutor built around verified retention.",
  manifest: "/manifest.webmanifest",
  title: "Reflo",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
