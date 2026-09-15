import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Obsy — VPS observability",
  description: "A focused dashboard for VPS and Docker container resources.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
