import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Polymarket Wallet Voice Tracker",
  description: "Real-time Polymarket wallet activity with voice alerts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-black text-white antialiased">{children}</body>
    </html>
  );
}
