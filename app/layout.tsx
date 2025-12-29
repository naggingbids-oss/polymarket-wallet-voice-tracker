export const metadata = {
  title: "Polymarket Wallet Voice Tracker",
  description: "Voice alerts for tracked Polymarket wallets"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
