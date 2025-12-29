"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WalletRow = { name: string; wallet: string };

type Trade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  size: number; // shares
  price: number; // USD per share (typical)
  timestamp: number;
  title: string;
  outcome?: string;
  transactionHash?: string;
};

function keyForTrade(t: Trade) {
  return `${t.transactionHash ?? "nohash"}:${t.timestamp}:${t.size}:${t.price}:${t.title}:${t.side}`;
}

export default function Page() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  // NEW: banner text on screen
  const [banner, setBannerState] = useState<string>("");

  // NEW: track BUY/SELL/BOTH
  const [trackMode, setTrackMode] = useState<"BUY" | "SELL" | "BOTH">("BUY");

  // NEW: min $ filter
  const [minFilterEnabled, setMinFilterEnabled] = useState(true);
  const [minUsd, setMinUsd] = useState(500);

  // seen trades
  const seenRef = useRef<Record<string, Record<string, true>>>({});

  // adaptive polling
  const delayMsRef = useRef<number>(2500); // start fairly fast
  const stopRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);

  const walletMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of wallets) m[w.wallet.toLowerCase()] = w.name;
    return m;
  }, [wallets]);

  function pushLog(line: string) {
    setLog((prev) => [line, ...prev].slice(0, 200));
  }

  function setBanner(msg: string) {
    setBannerState(msg);
    window.setTimeout(() => setBannerState(""), 9000);
  }

  async function loadWallets() {
    const res = await fetch("/api/wallets", { cache: "no-store" });
    const data = await res.json();
    if (data.error) {
      pushLog(`❌ Wallet load error: ${data.error}`);
      return;
    }
    setWallets(data.wallets ?? []);
    pushLog(`✅ Loaded ${data.wallets?.length ?? 0} wallets`);
  }

  function beep() {
    const AudioCtx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.08;
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, 140);
  }

  function speak(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function shouldTrackSide(side: "BUY" | "SELL") {
    if (trackMode === "BOTH") return true;
    return trackMode === side;
  }

  function passesMinUsdFilter(t: Trade) {
    if (!minFilterEnabled) return true;
    const notional = Number(t.size) * Number(t.price); // approx $ value
    return notional >= Number(minUsd);
  }

  async function primeSeen() {
    // Don’t announce old trades when you hit Start
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
          // mark both BUY and SELL as seen so you don’t get spam on start
          seenRef.current[wallet][keyForTrade(t)] = true;
        }
      } catch {}
    }
    pushLog("✅ Primed recent trades");
  }

  async function pollOnce(): Promise<{ throttled: boolean }> {
    if (!wallets.length) return { throttled: false };

    // Don’t overlap polls
    if (inFlightRef.current) return { throttled: false };
    inFlightRef.current = true;

    let throttled = false;

    // limit parallelism
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
                // common throttle statuses
                if (res.status === 429 || res.status === 403) throttled = true;
                pushLog(`❌ API status ${res.status} for ${w.name}`);
                return;
              }

              const data = await res.json();
              if (data.error) {
                // treat as potential throttle too
                throttled = true;
                pushLog(`❌ Trades error for ${w.name}: ${data.error}`);
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
                const marketTitle = t.title;
                const outcome = t.outcome ? ` (${t.outcome})` : "";
                const notional = shares * Number(t.price);

                const verb = t.side === "BUY" ? "bought" : "sold";
                const sentence = `${traderName} ${verb} ${shares} shares of ${marketTitle}${outcome}.`;

                // TEXT + AUDIO + VOICE + DESKTOP NOTIF
                const logLine = `🔔 ${sentence} (~$${notional.toFixed(2)})`;
                pushLog(logLine);
                setBanner(logLine);

                beep();
                speak(sentence);

                if (Notification.permission === "granted") {
                  new Notification("Polymarket Trade Alert", { body: logLine });
                }
              }
            } catch (e: any) {
              throttled = true;
              pushLog(`❌ Poll error for ${w.name}: ${String(e?.message ?? e)}`);
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

      // Adaptive delay:
      // - if we seem throttled: back off
      // - if not throttled: gradually speed up (but don’t go insane)
      if (throttled) {
        delayMsRef.current = Math.min(delayMsRef.current * 1.5, 20000); // max 20s
      } else {
        delayMsRef.current = Math.max(delayMsRef.current * 0.9, 1500); // min 1.5s
      }

      await new Promise((r) => setTimeout(r, delayMsRef.current));
    }
  }

  async function start() {
    if (running) return;
    await loadWallets();
    setRunning(true);
    pushLog("▶️ Tracking started (auto-speed)");
    await primeSeen();
    loop();
  }

  function stop() {
    setRunning(false);
    stopRef.current = true;
    pushLog("⏸️ Tracking stopped");
  }

  async function enableNotifications() {
    const p = await Notification.requestPermission();
    pushLog(`🔔 Notifications permission: ${p}`);
  }

  useEffect(() => {
    loadWallets();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 20, maxWidth: 980 }}>
      <h1 style={{ marginBottom: 6 }}>Polymarket Wallet Tracker (Auto Speed + Filters)</h1>
      <p style={{ marginTop: 0, opacity: 0.75 }}>
        This runs as fast as possible, and automatically slows down if Polymarket starts rate-limiting.
      </p>

      {banner && (
        <div
          style={{
            margin: "12px 0",
            padding: "12px 14px",
            border: "2px solid #111",
            borderRadius: 10,
            fontWeight: 700,
            background: "#fff",
          }}
        >
          {banner}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={enableNotifications}>Enable Notifications</button>

        {!running ? (
          <button onClick={start}>Start Tracking</button>
        ) : (
          <button onClick={stop}>Stop</button>
        )}

        <button onClick={loadWallets}>Reload Wallet List</button>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Track
          <select
            value={trackMode}
            onChange={(e) => setTrackMode(e.target.value as any)}
            disabled={running}
          >
            <option value="BUY">BUY only</option>
            <option value="SELL">SELL only</option>
            <option value="BOTH">BUY + SELL</option>
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={minFilterEnabled}
            onChange={(e) => setMinFilterEnabled(e.target.checked)}
          />
          Min $ filter
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          $
          <input
            type="number"
            min={0}
            step={50}
            value={minUsd}
            onChange={(e) => setMinUsd(Number(e.target.value))}
            style={{ width: 110 }}
            disabled={!minFilterEnabled}
          />
        </label>

        <span style={{ opacity: 0.7 }}>
          Current delay: {(delayMsRef.current / 1000).toFixed(1)}s
        </span>
      </div>

      <h3 style={{ marginBottom: 6 }}>Wallets</h3>
      <ul>
        {wallets.map((w) => (
          <li key={w.wallet}>
            <b>{w.name}</b> — <code>{w.wallet}</code>
          </li>
        ))}
      </ul>

      <h3 style={{ marginBottom: 6 }}>Live Log</h3>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          height: 320,
          overflow: "auto",
          background: "#fafafa",
          whiteSpace: "pre-wrap",
        }}
      >
        {log.length ? log.join("\n") : "No events yet."}
      </div>
    </main>
  );
}
