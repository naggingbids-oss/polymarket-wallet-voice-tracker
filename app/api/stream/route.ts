import { fetchTrackedWallets } from "@/lib/sheets";
import { fetchLatestTradesForWallet, type PolymarketTrade } from "@/lib/polymarket";
import { mapWithConcurrency } from "@/lib/concurrency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TradeEvent = {
  id: string; // stable-ish id for dedupe
  wallet: string;
  trader: string;
  side: "BUY" | "SELL";
  outcome?: string;
  title?: string;
  shares?: number;
  usdc?: number;
  price?: number;
  timestampMs: number;
  tx?: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __PM_SSE_STATE__:
    | {
        clients: Set<WritableStreamDefaultWriter>;
        lastSeenByWallet: Map<string, number>; // timestampMs
        lastSentIds: Set<string>;
        started: boolean;
      }
    | undefined;
}

function getState() {
  if (!globalThis.__PM_SSE_STATE__) {
    globalThis.__PM_SSE_STATE__ = {
      clients: new Set(),
      lastSeenByWallet: new Map(),
      lastSentIds: new Set(),
      started: false,
    };
  }
  return globalThis.__PM_SSE_STATE__!;
}

function toTradeEvent(t: PolymarketTrade, trader: string): TradeEvent {
  const tx = t.transactionHash || "";
  const id = tx ? `${t.proxyWallet}:${tx}` : `${t.proxyWallet}:${t.timestamp}:${t.side}:${t.price}:${t.size}`;
  return {
    id,
    wallet: t.proxyWallet,
    trader,
    side: t.side,
    outcome: t.outcome,
    title: t.title,
    shares: typeof t.size === "number" ? t.size : undefined,
    usdc: typeof t.usdcSize === "number" ? t.usdcSize : undefined,
    price: typeof t.price === "number" ? t.price : undefined,
    timestampMs: t.timestamp,
    tx: tx || undefined,
  };
}

function sseLine(obj: any) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function pollLoop() {
  const state = getState();
  if (state.started) return;
  state.started = true;

  const POLL_MS = 2500; // fixed, fast, and safe-ish
  const CONCURRENCY = 8; // avoids hammering API too hard

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const wallets = await fetchTrackedWallets();

      // Fetch each wallet concurrently (bounded)
      const perWallet = await mapWithConcurrency(wallets, CONCURRENCY, async (w) => {
        try {
          const trades = await fetchLatestTradesForWallet(w.wallet, 25);
          return { ...w, trades };
        } catch {
          return { ...w, trades: [] as PolymarketTrade[] };
        }
      });

      const newEvents: TradeEvent[] = [];

      for (const w of perWallet) {
        const lastSeen = state.lastSeenByWallet.get(w.wallet) ?? 0;

        // Only consider trades newer than lastSeen
        const fresh = w.trades
          .map((t) => toTradeEvent(t, w.trader))
          .filter((e) => e.timestampMs > lastSeen);

        if (fresh.length > 0) {
          const newestTs = Math.max(...fresh.map((e) => e.timestampMs));
          state.lastSeenByWallet.set(w.wallet, newestTs);

          for (const e of fresh) {
            // global dedupe (tx hash based id)
            if (state.lastSentIds.has(e.id)) continue;
            state.lastSentIds.add(e.id);

            // keep set from growing forever
            if (state.lastSentIds.size > 5000) {
              const keep = new Set(Array.from(state.lastSentIds).slice(-2500));
              state.lastSentIds = keep;
            }

            newEvents.push(e);
          }
        }
      }

      if (newEvents.length && state.clients.size) {
        // Sort oldest -> newest so the log feels natural
        newEvents.sort((a, b) => a.timestampMs - b.timestampMs);

        const payload = sseLine({ type: "events", events: newEvents });
        await Promise.allSettled(Array.from(state.clients).map((w) => w.write(payload)));
      }
    } catch {
      // ignore loop errors
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minUsd = Number(url.searchParams.get("minUsd") || "0");
  const filterBig = url.searchParams.get("filterBig") === "1";

  const state = getState();
  pollLoop().catch(() => {});

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Register client
  state.clients.add(writer);

  // Initial hello
  await writer.write(
    sseLine({
      type: "hello",
      serverTime: Date.now(),
      filter: { filterBig, minUsd },
    })
  );

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });

  // Remove client on close
  controller.signal.addEventListener(
    "abort",
    () => {
      state.clients.delete(writer);
      try {
        writer.close();
      } catch {}
    },
    { once: true }
  );

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
