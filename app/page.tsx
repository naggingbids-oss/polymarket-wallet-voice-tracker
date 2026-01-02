"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type WalletRow = { name: string; wallet: string };

type Trade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
  title: string;
  outcome?: string; // "Yes" / "No" sometimes
  transactionHash?: string;
};

type LogItem = {
  id: string;
  side: "BUY" | "SELL";
  traderName: string;
  shares: number;
  price: number;
  notional: number;
  marketTitle: string;
  outcome?: string;
  timeMs: number;
};

function keyForTrade(t: Trade) {
  return `${t.transactionHash ?? "nohash"}:${t.timestamp}:${t.size}:${t.price}:${t.title}:${t.side}:${t.outcome ?? ""}`;
}

function fmtUsd(x: number) {
  if (!Number.isFinite(x)) return "$0.00";
  return `$${x.toFixed(2)}`;
}

function fmtShares(n: number) {
  if (!Number.isFinite(n)) return "0";
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function fmtPricePerShare(price: number) {
  if (!Number.isFinite(price)) return "$0.00";
  // Polymarket often < $1; show cents cleanly
  if (price > 0 && price < 1) return `${Math.round(price * 100)}¢`;
  return `$${price.toFixed(2)}`;
}

function Verb({ side }: { side: "BUY" | "SELL" }) {
  return (
    <span className={side === "BUY" ? "text-emerald-300 font-semibold" : "text-red-300 font-semibold"}>
      {side === "BUY" ? "bought" : "sold"}
    </span>
  );
}

function Outcome({ outcome }: { outcome?: string }) {
  if (!outcome) return null;
  const o = outcome.trim().toLowerCase();
  if (o === "yes") return <span className="text-emerald-300 font-semibold">Yes</span>;
  if (o === "no") return <span className="text-red-300 font-semibold">No</span>;
  return <span className="text-foreground font-semibold">{outcome}</span>;
}

export default function Page() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [running, setRunning] = useState(false);
  const [logItems, setLogItems] = useState<LogItem[]>([]);
  const [banner, setBanner] = useState<LogItem | null>(null);

  const [trackMode, setTrackMode] = useState<"BUY" | "SELL" | "BOTH">("BOTH");
  const [minFilterEnabled, setMinFilterEnabled] = useState(true);
  const [minUsd, setMinUsd] = useState(500);

  const seenRef = useRef<Record<string, Record<string, true>>>({});
  const delayMsRef = useRef<number>(2500);
  const stopRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);

  const walletMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of wallets) m[w.wallet.toLowerCase()] = w.name;
    return m;
  }, [wallets]);

  function addLog(item: LogItem) {
    setLogItems((prev) => [item, ...prev].slice(0, 250));
  }

  function shouldTrackSide(side: "BUY" | "SELL") {
    if (trackMode === "BOTH") return true;
    return trackMode === side;
  }

  function passesMinUsdFilter(t: Trade) {
    if (!minFilterEnabled) return true;
    const notional = Number(t.size) * Number(t.price);
    return notional >= Number(minUsd);
  }

  async function loadWallets() {
    const res = await fetch("/api/wallets", { cache: "no-store" });
    const data = await res.json();
    if (data.error) {
      addLog({
        id: `sys-err:${Date.now()}`,
        side: "SELL",
        traderName: "System",
        shares: 0,
        price: 0,
        notional: 0,
        marketTitle: `Wallet load error: ${data.error}`,
        timeMs: Date.now()
      });
      return;
    }
    setWallets(data.wallets ?? []);
    addLog({
      id: `sys:${Date.now()}`,
      side: "BUY",
      traderName: "System",
      shares: 0,
      price: 0,
      notional: 0,
      marketTitle: `Loaded ${data.wallets?.length ?? 0} wallets from your Google Sheet.`,
      timeMs: Date.now()
    });
  }

  function beep(side: "BUY" | "SELL") {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = side === "BUY" ? 920 : 520;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.08;
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, 130);
  }

  function speak(sentence: string) {
    const u = new SpeechSynthesisUtterance(sentence);
    u.rate = 1.18; // slightly faster
    u.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  async function primeSeen() {
    for (const w of wallets) {
      const wallet = w.wallet.toLowerCase();
      try {
        const res = await fetch(`/api/trades?user=${encodeURIComponent(wallet)}&limit=10`, {
          cache: "no-store"
        });
        const data = await res.json();
        const trades: Trade[] = data.trades ?? [];
        seenRef.current[wallet] ||= {};
        for (const t of trades) {
          seenRef.current[wallet][keyForTrade(t)] = true;
        }
      } catch {}
    }
    addLog({
      id: `sys-prime:${Date.now()}`,
      side: "BUY",
      traderName: "System",
      shares: 0,
      price: 0,
      notional: 0,
      marketTitle: "Primed recent trades (prevents announcing old activity on start).",
      timeMs: Date.now()
    });
  }

  async function pollOnce(): Promise<{ throttled: boolean }> {
    if (!wallets.length) return { throttled: false };
    if (inFlightRef.current) return { throttled: false };

    inFlightRef.current = true;
    let throttled = false;

    const CONCURRENCY = 10;
    const list = wallets.map((w) => ({ name: w.name, wallet: w.wallet.toLowerCase() }));

    try {
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY);

        await Promise.all(
          batch.map(async (w) => {
            try {
              const res = await fetch(`/api/trades?user=${encodeURIComponent(w.wallet)}&limit=10`, {
                cache: "no-store"
              });

              if (!res.ok) {
                if (res.status === 429 || res.status === 403) throttled = true;
                return;
              }

              const data = await res.json();
              const trades: Trade[] = data.trades ?? [];

              for (const t of trades) {
                if (!shouldTrackSide(t.side)) continue;
                if (!passesMinUsdFilter(t)) continue;

                const k = keyForTrade(t);
                seenRef.current[w.wallet] ||= {};
                if (seenRef.current[w.wallet][k]) continue;
                seenRef.current[w.wallet][k] = true;

                const whoWallet = (t.proxyWallet ?? w.wallet).toLowerCase();
                const traderName = walletMap[whoWallet] ?? w.name;

                const shares = Number(t.size);
                const price = Number(t.price);
                const notional = shares * price;

                const item: LogItem = {
                  id: `${w.wallet}:${k}`,
                  side: t.side,
                  traderName,
                  shares,
                  price,
                  notional,
                  marketTitle: t.title,
                  outcome: t.outcome,
                  timeMs: Date.now()
                };

                addLog(item);
                setBanner(item);

                const verb = t.side === "BUY" ? "bought" : "sold";
                const sentence = `${traderName} ${verb} ${fmtShares(shares)} shares at ${fmtPricePerShare(
                  price
                )} per share of ${t.title}${t.outcome ? ` (${t.outcome})` : ""}.`;

                beep(t.side);
                speak(sentence);

                if (Notification.permission === "granted") {
                  const dot = t.side === "BUY" ? "🟢" : "🔴";
                  const msg = `${dot} ${traderName} ${verb} ${fmtShares(shares)} @ ${fmtPricePerShare(price)}/share — ${t.title}`;
                  new Notification("Polymarket Trade Alert", { body: msg });
                }
              }
            } catch {
              throttled = true;
            }
          })
        );
      }
    } finally {
      inFlightRef.current = false;
    }

    return { throttled };
  }

  async function loop() {
    stopRef.current = false;

    while (!stopRef.current) {
      const { throttled } = await pollOnce();

      if (throttled) delayMsRef.current = Math.min(delayMsRef.current * 1.5, 20000);
      else delayMsRef.current = Math.max(delayMsRef.current * 0.9, 1400);

      await new Promise((r) => setTimeout(r, delayMsRef.current));
    }
  }

  async function start() {
    if (running) return;
    await loadWallets();
    setRunning(true);
    await primeSeen();
    loop();
  }

  function stop() {
    setRunning(false);
    stopRef.current = true;
  }

  async function enableNotifications() {
    await Notification.requestPermission();
  }

  useEffect(() => {
    loadWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1200px] p-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <div className="text-2xl font-semibold tracking-tight">Polymarket Wallet Tracker</div>
              <div className="text-sm text-muted-foreground">
                Clean “New York” UI • voice alerts • auto-speed polling • filters
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              Current delay: {(delayMsRef.current / 1000).toFixed(1)}s
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.45fr_1fr]">
          {/* LEFT: Live Log */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Live Log</CardTitle>
              <CardDescription>
                🟢 buys and 🔴 sells. Includes shares, <span className="font-medium">price per share</span>, and est. $.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[560px] overflow-auto pr-1 space-y-3">
                {logItems.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No events yet.</div>
                ) : (
                  logItems.map((it) => {
                    const isBuy = it.side === "BUY";
                    const dot = isBuy ? "🟢" : "🔴";

                    return (
                      <div
                        key={it.id}
                        className={[
                          "rounded-xl border p-3",
                          isBuy ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"
                        ].join(" ")}
                      >
                        <div className="text-sm leading-relaxed">
                          <span className="mr-2">{dot}</span>
                          <span className="font-semibold">{it.traderName}</span> <Verb side={it.side} />{" "}
                          <span className="font-semibold">{fmtShares(it.shares)}</span> shares at{" "}
                          <span className="font-semibold">{fmtPricePerShare(it.price)}</span>
                          <span className="text-muted-foreground">/share</span> of{" "}
                          <span className="font-semibold">{it.marketTitle}</span>
                          {it.outcome ? (
                            <>
                              {" "}
                              (<Outcome outcome={it.outcome} />)
                            </>
                          ) : null}
                          <span className="text-muted-foreground"> — est. {fmtUsd(it.notional)}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          {/* RIGHT: Controls + Latest + Wallets */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Controls</CardTitle>
                <CardDescription>Fast by default. It backs off automatically if throttled.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={enableNotifications}>
                    Enable Notifications
                  </Button>
                  {!running ? (
                    <Button onClick={start}>Start Tracking</Button>
                  ) : (
                    <Button variant="outline" onClick={stop}>
                      Stop
                    </Button>
                  )}
                  <Button variant="ghost" onClick={loadWallets}>
                    Reload Wallet List
                  </Button>
                </div>

                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <div className="text-sm text-muted-foreground">Track mode</div>
                    <Select
                      value={trackMode}
                      onValueChange={(v) => setTrackMode(v as any)}
                      disabled={running}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BOTH">Buy + Sell</SelectItem>
                        <SelectItem value="BUY">Buy only</SelectItem>
                        <SelectItem value="SELL">Sell only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Min $ filter</div>
                      <div className="text-xs text-muted-foreground">Only announce trades above your threshold.</div>
                    </div>
                    <Switch checked={minFilterEnabled} onCheckedChange={setMinFilterEnabled} />
                  </div>

                  <div className="grid gap-2">
                    <div className="text-sm text-muted-foreground">Minimum trade value</div>
                    <input
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      type="number"
                      min={0}
                      step={50}
                      value={minUsd}
                      disabled={!minFilterEnabled}
                      onChange={(e) => setMinUsd(Number(e.target.value))}
                    />
                    <div className="text-xs text-muted-foreground">
                      Estimated as <span className="font-medium">shares × price</span>.
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {banner ? (
              <Card>
                <CardHeader>
                  <CardTitle>Latest</CardTitle>
                  <CardDescription>What just happened (with your color rules).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={banner.side === "BUY" ? "buy" : "sell"}>
                      {banner.side === "BUY" ? "BUY" : "SELL"}
                    </Badge>
                    <div className="text-sm">
                      <span className="mr-2">{banner.side === "BUY" ? "🟢" : "🔴"}</span>
                      <span className="font-semibold">{banner.traderName}</span> <Verb side={banner.side} />{" "}
                      <span className="font-semibold">{fmtShares(banner.shares)}</span> @{" "}
                      <span className="font-semibold">{fmtPricePerShare(banner.price)}</span>
                      <span className="text-muted-foreground">/share</span> •{" "}
                      <span className="font-semibold">{banner.marketTitle}</span>
                      {banner.outcome ? (
                        <>
                          {" "}
                          (<Outcome outcome={banner.outcome} />)
                        </>
                      ) : null}
                      <span className="text-muted-foreground"> • est. {fmtUsd(banner.notional)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Tracked wallets</CardTitle>
                <CardDescription>From Google Sheet (A=name, B=wallet).</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[220px] overflow-auto space-y-2 pr-1">
                  {wallets.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No wallets loaded yet.</div>
                  ) : (
                    wallets.map((w) => (
                      <div key={w.wallet} className="rounded-lg border border-border bg-card/30 p-3">
                        <div className="font-semibold">{w.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">{w.wallet}</div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground">
              Browser note: audio can be muted if the tab is fully backgrounded. Best reliability is keeping this open
              in a small window or installing as an app.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
