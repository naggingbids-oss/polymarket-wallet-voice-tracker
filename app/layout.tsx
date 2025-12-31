import "./globals.css";

export const metadata = {
  title: "Polymarket Wallet Voice Tracker",
  description: "Voice + text alerts for tracked Polymarket wallets"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
