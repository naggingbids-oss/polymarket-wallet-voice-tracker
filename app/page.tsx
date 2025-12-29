"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WalletRow = { name: string; wallet: string };

type Trade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  size: number; // shares
  price: number; // USD per share (usually 0-1)
  timestamp: number;
  title: string;
  outcome?: string; // "Yes" / "No" sometimes
  transactionHash?: string;
};

type LogItem = {
  id: string;
  side: "BUY" | "SELL";
  text: string;
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

function fmtPricePerShare(price: number) {
  if (!Number.isFinite(price)) return "$0.00";
  if (price < 1) return `${Math.round(price * 100)}¢`;
  return `$${price.toFixed(2)}`;
}

function fmtShares(n: number) {
  if (!Number.isFinite(n)) return "0";
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function ColoredWord({
  side,
  children,
}: {
  side: "BUY" | "SELL";
  children: React.ReactNode;
}) {
  const color = side === "BUY" ? "#3ee281" : "#ff5a6a";
  return <span style={{ color, fontWeight: 800 }}>{children}</span>;
}

function OutcomeWord({ outcome }: { outcome?: string }) {
  if (!outcome) return null;

  const normalized = outcome.trim().toLowerCase();
  if (normalized === "yes") {
    return <span style={{ color: "#3ee281", fontWeight: 800 }}>Yes</span>;
  }
  if (normalized === "no") {
    return <span style={{ color: "#ff5a6a", fontWeight: 800 }}>No</span>;
  }
  return <span style={{ opacity: 0.9, fontWeight: 700 }}>{outcome}</span>;
}

export default function Page() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [running, setRunning] = useState(false);

  // left-side structured log
  const [logItems, setLogItems] = useState<LogItem[]>([]);

  // banner at top-right area
  const [banner, setBanner] = useState<LogItem | null>(null);

  // track BUY/SELL/BOTH
  const [trackMode, setTrackMode] = useState<"BUY" | "SELL" | "BOTH">("BOTH");

  // min $ filter
  const [minFilterEnabled, setMinFilterEnabled] = useState(true);
  const [minUsd, setMinUsd] = useState(500);

  // seen trades
  const seenRef = useRef<Record<string, Record<string, true>>>({});

  // adaptive polling (fast but safe)
  const delayMsRef = useRef<number>(2500);
  const stopRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);

  const walletMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of wallets) m[w.wallet.toLowerCase()] = w.name;
    return m;
  }, [wallets]);

  function addLogItem(item: LogItem) {
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
      addLogItem({
        id: `err:${Date.now()}`,
        side: "SELL",
        text: `Wallet load error: ${data.error}`,
        traderName: "System",
        shares: 0,
        price: 0,
        notional: 0,
        marketTitle: "",
        timeMs: Date.now(),
      });
      return;
    }
    setWallets(data.wallets ?? []);
    addLogItem({
      id: `sys:${Date.now()}`,
      side: "BUY",
      text: `Loaded ${data.wallets?.length ?? 0} wallets from your Google Sheet.`,
      traderName: "System",
      shares: 0,
      price: 0,
      notional: 0,
      marketTitle: "",
      timeMs: Date.now(),
    });
  }

  function beep(side: "BUY" | "SELL") {
    // tiny cue (different pitch)
    const AudioCtx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
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
    u.rate = 1.15; // slightly faster (your request)
    u.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  async function primeSeen() {
    // mark recent trades as seen so Start doesn't spam
    for (const w of wallets) {
      const wallet = w.wallet.toLowerCase();
      try {
        const res = await fetch(
          `/api/trades?user=${encodeURIComponent(wallet)}&limit=10`,
          { cache: "no-store" }
        );
        const data = await res.json();
        const trades: Trade[] = data.trades ?? [];
        seenRef.current[wallet] ||= {};
        for (const t of trades) {
          seenRef.current[wallet][keyForTrade(t)] = true;
        }
      } catch {}
    }
    addLogItem({
      id: `sys:prime:${Date.now()}`,
      side: "BUY",
      text: "Primed recent trades (prevents announcing old activity on start).",
      traderName: "System",
      shares: 0,
      price: 0,
      notional: 0,
      marketTitle: "",
      timeMs: Date.now(),
    });
  }

  async function pollOnce(): Promise<{ throttled: boolean }> {
    if (!wallets.length) return { throttled: false };
    if (inFlightRef.current) return { throttled: false };

    inFlightRef.current = true;
    let throttled = false;

    const CONCURRENCY = 10;

    const list = wallets.map((w) => ({
      name: w.name,
      wallet: w.wallet.toLowerCase(),
    }));

    try {
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY);

        await Promise.all(
          batch.map(async (w) => {
            try {
              const res = await fetch(
                `/api/trades?user=${encodeURIComponent(w.wallet)}&limit=10`,
                { cache: "no-store" }
              );

              if (!res.ok) {
                if (res.status === 429 || res.status === 403) throttled = true;
                addLogItem({
                  id: `api:${w.wallet}:${Date.now()}`,
                  side: "SELL",
                  text: `API status ${res.status} for ${w.name}`,
                  traderName: w.name,
                  shares: 0,
                  price: 0,
                  notional: 0,
                  marketTitle: "",
                  timeMs: Date.now(),
                });
                return;
              }

              const data = await res.json();
              if (data.error) {
                throttled = true;
                addLogItem({
                  id: `err:${w.wallet}:${Date.now()}`,
                  side: "SELL",
                  text: `Trades error for ${w.name}: ${data.error}`,
                  traderName: w.name,
                  shares: 0,
                  price: 0,
                  notional: 0,
                  marketTitle: "",
                  timeMs: Date.now(),
                });
                return;
              }

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

                const verb = t.side === "BUY" ? "bought" : "sold";
                const sentence = `${traderName} ${verb} ${fmtShares(shares)} shares at ${fmtPricePerShare(
                  price
                )} per share of ${t.title}${t.outcome ? ` (${t.outcome})` : ""}.`;

                const dot = t.side === "BUY" ? "🟢" : "🔴";
                const text = `${dot} ${traderName} ${verb} ${fmtShares(
                  shares
                )} shares @ ${fmtPricePerShare(price)}/share — ${t.title}${
                  t.outcome ? ` (${t.outcome})` : ""
                } — ~${fmtUsd(notional)}`;

                const item: LogItem = {
                  id: `${w.wallet}:${k}`,
                  side: t.side,
                  text,
                  traderName,
                  shares,
                  price,
                  notional,
                  marketTitle: t.title,
                  outcome: t.outcome,
                  timeMs: Date.now(),
                };

                addLogItem(item);
                setBanner(item);

                // alerting
                beep(t.side);
                speak(sentence);

                if (Notification.permission === "granted") {
                  new Notification("Polymarket Trade Alert", { body: text });
                }
              }
            } catch (e: any) {
              throttled = true;
              addLogItem({
                id: `pollerr:${w.wallet}:${Date.now()}`,
                side: "SELL",
                text: `Poll error for ${w.name}: ${String(e?.message ?? e)}`,
                traderName: w.name,
                shares: 0,
                price: 0,
                notional: 0,
                marketTitle: "",
                timeMs: Date.now(),
              });
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

      // Adaptive delay: back off on throttling, otherwise gently speed up
      if (throttled) {
        delayMsRef.current = Math.min(delayMsRef.current * 1.5, 20000);
      } else {
        delayMsRef.current = Math.max(delayMsRef.current * 0.9, 1400);
      }

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
    const p = await Notification.requestPermission();
    addLogItem({
      id: `notif:${Date.now()}`,
      side: "BUY",
      text: `Desktop notifications permission: ${p}`,
      traderName: "System",
      shares: 0,
      price: 0,
      notional: 0,
      marketTitle: "",
      timeMs: Date.now(),
    });
  }

  useEffect(() => {
    loadWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0b0f14",
    color: "#eaf0f6",
  };

  const cardStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 14,
    boxShadow: "0 10px 28px rgba(0,0,0,0.35)",
  };

  const subtle: React.CSSProperties = { opacity: 0.75 };

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 0.2 }}>
            Polymarket Wallet Tracker
          </h1>
          <div style={subtle}>
            Voice + text alerts for tracked wallets — auto-speed polling
          </div>
        </div>

        <div style={{ marginTop: 10, ...subtle, lineHeight: 1.45 }}>
          Keep this page open while you work. When a tracked wallet trades, you’ll get:
          a sound cue, a spoken sentence (slightly faster), and a clear on-screen log entry
          showing <b>shares</b>, <b>price per share</b>, and an estimated <b>$ value</b>.
        </div>

        <div style={{ display: "flex", gap: 14, marginTop: 16 }}>
          {/* LEFT: Live log */}
          <div style={{ flex: 1.35, minWidth: 420 }}>
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>Live Log</h2>
                <div style={{ fontSize: 12, ...subtle }}>
                  Delay: {(delayMsRef.current / 1000).toFixed(1)}s
                </div>
              </div>

              <div style={{ marginTop: 10, height: 520, overflow: "auto", paddingRight: 6 }}>
                {logItems.length === 0 ? (
                  <div style={subtle}>No events yet.</div>
                ) : (
                  logItems.map((it) => {
                    const isBuy = it.side === "BUY";
                    const dot = isBuy ? "🟢" : "🔴";
                    const verb = isBuy ? "bought" : "sold";

                    return (
                      <div
                        key={it.id}
                        style={{
                          padding: "10px 10px",
                          marginBottom: 10,
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: isBuy
                            ? "rgba(62,226,129,0.06)"
                            : "rgba(255,90,106,0.06)",
                        }}
                      >
                        <div style={{ fontSize: 13, lineHeight: 1.4 }}>
                          <span style={{ marginRight: 8 }}>{dot}</span>
                          <span style={{ fontWeight: 800 }}>{it.traderName}</span>{" "}
                          <ColoredWord side={it.side}>{verb}</ColoredWord>{" "}
                          <span style={{ fontWeight: 800 }}>{fmtShares(it.shares)}</span>{" "}
                          shares at{" "}
                          <span style={{ fontWeight: 800 }}>
                            {fmtPricePerShare(it.price)}
                          </span>
                          <span style={{ ...subtle }}> /share</span>{" "}
                          of{" "}
                          <span style={{ fontWeight: 800 }}>{it.marketTitle}</span>
                          {it.outcome ? (
                            <>
                              {" "}
                              (
                              <OutcomeWord outcome={it.outcome} />)
                            </>
                          ) : null}
                          <span style={{ ...subtle }}>
                            {" "}
                            — est. {fmtUsd(it.notional)}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: Controls + Wallets */}
          <div style={{ flex: 1, minWidth: 360 }}>
            {banner ? (
              <div style={{ ...cardStyle, marginBottom: 14 }}>
                <div style={{ fontSize: 12, ...subtle, marginBottom: 6 }}>
                  Latest alert
                </div>

                <div style={{ fontSize: 14, lineHeight: 1.45 }}>
                  <span style={{ marginRight: 8 }}>
                    {banner.side === "BUY" ? "🟢" : "🔴"}
                  </span>
                  <span style={{ fontWeight: 900 }}>{banner.traderName}</span>{" "}
                  <ColoredWord side={banner.side}>
                    {banner.side === "BUY" ? "bought" : "sold"}
                  </ColoredWord>{" "}
                  <span style={{ fontWeight: 900 }}>{fmtShares(banner.shares)}</span>{" "}
                  shares at{" "}
                  <span style={{ fontWeight: 900 }}>
                    {fmtPricePerShare(banner.price)}
                  </span>
                  <span style={{ ...subtle }}> /share</span>{" "}
                  of <span style={{ fontWeight: 900 }}>{banner.marketTitle}</span>
                  {banner.outcome ? (
                    <>
                      {" "}
                      (
                      <OutcomeWord outcome={banner.outcome} />)
                    </>
                  ) : null}
                  <span style={{ ...subtle }}>
                    {" "}
                    — est. {fmtUsd(banner.notional)}
                  </span>
                </div>
              </div>
            ) : null}

            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Controls</h2>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                <button
                  onClick={enableNotifications}
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    color: "#eaf0f6",
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    cursor: "pointer",
                  }}
                >
                  Enable Notifications
                </button>

                {!running ? (
                  <button
                    onClick={start}
                    style={{
                      background: "rgba(62,226,129,0.18)",
                      color: "#eaf0f6",
                      border: "1px solid rgba(62,226,129,0.35)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      cursor: "pointer",
                      fontWeight: 800,
                    }}
                  >
                    Start Tracking
                  </button>
                ) : (
                  <button
                    onClick={stop}
                    style={{
                      background: "rgba(255,90,106,0.16)",
                      color: "#eaf0f6",
                      border: "1px solid rgba(255,90,106,0.35)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      cursor: "pointer",
                      fontWeight: 800,
                    }}
                  >
                    Stop
                  </button>
                )}

                <button
                  onClick={loadWallets}
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    color: "#eaf0f6",
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    cursor: "pointer",
                  }}
                >
                  Reload Wallet List
                </button>
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={subtle}>Track</span>
                  <select
                    value={trackMode}
                    onChange={(e) => setTrackMode(e.target.value as any)}
                    disabled={running}
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      color: "#eaf0f6",
                      border: "1px solid rgba(255,255,255,0.14)",
                      borderRadius: 10,
                      padding: "8px 10px",
                      width: 170,
                      cursor: running ? "not-allowed" : "pointer",
                    }}
                  >
                    <option value="BOTH">Buy + Sell</option>
                    <option value="BUY">Buy only</option>
                    <option value="SELL">Sell only</option>
                  </select>
                </label>

                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={subtle}>Min $ filter</span>
                  <input
                    type="checkbox"
                    checked={minFilterEnabled}
                    onChange={(e) => setMinFilterEnabled(e.target.checked)}
                    style={{ transform: "scale(1.1)" }}
                  />
                </label>

                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={subtle}>Minimum trade value</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={subtle}>$</span>
                    <input
                      type="number"
                      min={0}
                      step={50}
                      value={minUsd}
                      onChange={(e) => setMinUsd(Number(e.target.value))}
                      disabled={!minFilterEnabled}
                      style={{
                        width: 130,
                        background: "rgba(255,255,255,0.06)",
                        color: "#eaf0f6",
                        border: "1px solid rgba(255,255,255,0.14)",
                        borderRadius: 10,
                        padding: "8px 10px",
                      }}
                    />
                  </div>
                </label>

                <div style={{ ...subtle, fontSize: 12, lineHeight: 1.4 }}>
                  Tip: Polymarket prices are usually under $1 per share, so you’ll see values like{" "}
                  <b>62¢/share</b>. The $ value shown is an estimate: <b>shares × price</b>.
                </div>
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Tracked Wallets</h2>
              <div style={{ marginTop: 10, ...subtle, fontSize: 12 }}>
                Loaded from your Google Sheet (Column A = name, Column B = wallet).
              </div>

              <div style={{ marginTop: 12, maxHeight: 260, overflow: "auto", paddingRight: 6 }}>
                {wallets.length === 0 ? (
                  <div style={subtle}>No wallets loaded yet.</div>
                ) : (
                  wallets.map((w) => (
                    <div
                      key={w.wallet}
                      style={{
                        padding: "10px 10px",
                        marginBottom: 10,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.03)",
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>{w.name}</div>
                      <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, ...subtle }}>
                        {w.wallet}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, ...subtle, fontSize: 12 }}>
          Audio note: some browsers mute background tabs. Best reliability is keeping this page visible
          or installed as an app window.
        </div>
      </div>
    </div>
  );
}
