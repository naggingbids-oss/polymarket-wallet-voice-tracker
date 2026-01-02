export type PolymarketTrade = {
  proxyWallet: string;
  timestamp: number; // unix seconds or ms depending on endpoint; we normalize
  side: "BUY" | "SELL";
  title?: string;
  outcome?: string; // "Yes" / "No"
  size?: number; // shares
  usdcSize?: number; // dollars
  price?: number; // price per share
  transactionHash?: string;
  slug?: string;
};

function normalizeTimestamp(ts: number): number {
  // Some APIs return seconds, some milliseconds
  if (ts > 10_000_000_000) return ts; // ms
  return ts * 1000; // seconds -> ms
}

export async function fetchLatestTradesForWallet(wallet: string, limit = 20): Promise<PolymarketTrade[]> {
  const url = new URL("https://data-api.polymarket.com/activity");
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sortDirection", "DESC");
  url.searchParams.set("sortBy", "TIMESTAMP");
  url.searchParams.set("type", "TRADE");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Polymarket Data API error: ${res.status}`);

  const data = (await res.json()) as any[];
  return (data || [])
    .map((x) => {
      const t: PolymarketTrade = {
        proxyWallet: String(x.proxyWallet || wallet),
        timestamp: normalizeTimestamp(Number(x.timestamp ?? 0)),
        side: x.side === "SELL" ? "SELL" : "BUY",
        title: x.title,
        outcome: x.outcome,
        size: typeof x.size === "number" ? x.size : Number(x.size),
        usdcSize: typeof x.usdcSize === "number" ? x.usdcSize : Number(x.usdcSize),
        price: typeof x.price === "number" ? x.price : Number(x.price),
        transactionHash: x.transactionHash,
        slug: x.slug,
      };
      return t;
    })
    .filter((t) => t.timestamp > 0);
}
