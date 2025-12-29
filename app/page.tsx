"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WalletRow = { name: string; wallet: string };

type Trade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
  title: string;
  outcome?: string;
  transactionHash?: string;
};

function keyForTrade(t: Trade) {
  return `${t.transactionHash ?? "nohash"}:${t.timestamp}:${t.size}:${t.price}:${t.title}`;
}

export default function Page() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [intervalSec, setIntervalSec] = useState(15);

  const seenRef = useRef<Record<string, Record<string, true>>>({});
  const timerRef = useRef<number | null>(null);

  const walletMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of wallets) m[w.wallet.toLowerCase()] = w.name;
    return m;
  }, [wallets]);

  function pushLog(line: string) {
    setLog((prev) => [line, ...prev].slice(0, 120));
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

  async function primeSeen() {
    pushLog("… Priming recent BUY trades (prevents spam on start)");
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
          if (t.side !== "BUY") continue;
          seenRef.current[wallet][keyForTrade(t)] = true;
        }
      } catch {}
    }
    pushLog("✅ Primed");
  }

  async function pollOnce() {
    for (const w of wallets) {
      const wallet = w.wallet.toLowerCase();
      try {
        const res = await fetch(`/api/trades?user=${encodeURIComponent(wallet)}&limit=10`, {
          cache: "no-store"
        });
        const data = await res.json();
        if (data.error) {
          pushLog(`❌ Trades error for ${w.name}: ${data.error}`);
          continue;
        }

        const trades: Trade[] = data.trades ?? [];
        for (const t of trades) {
          if (t.side !== "BUY") continue;

          const k = keyForTrade(t);
          seenRef.current[wallet] ||= {};
          if (seenRef.current[wallet][k]) continue;
          seenRef.current[wallet][k] = true;

          const whoWallet = (t.proxyWallet ?? wallet).toLowerCase();
          const traderName = walletMap[whoWallet] ?? w.name;

          const shares = Number(t.size);
          const marketTitle = t.title;
          const outcome = t.outcome ? ` (${t.outcome})` : "";

          const sentence = `${traderName} bought ${shares} shares of ${marketTitle}${outcome}.`;
          pushLog(`🔔 ${sentence}`);
          beep();
          speak(sentence);

          if (Notification.permission === "granted") {
            new Notification("Polymarket Trade Alert", { body: sentence });
          }
        }
      } catch (e: any) {
        pushLog(`❌ Poll error for ${w.name}: ${String(e?.message ?? e)}`);
      }
    }
  }

  async function start() {
    if (running) return;
    await loadWallets();
    setRunning(true);
    pushLog("▶️ Tracking started");
    await primeSeen();

    timerRef.current = window.setInterval(() => {
      pollOnce();
    }, Math.max(5, intervalSec) * 1000);
  }

  function stop() {
    setRunning(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
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
    <main style={{ fontFamily: "system-ui", padding: 20, maxWidth: 900 }}>
      <h1 style={{ marginBottom: 6 }}>Polymarket Wallet Tracker (Voice Alerts)</h1>
      <p style={{ marginTop: 0, opacity: 0.75 }}>
        Leave this page open while you work. Click Start Tracking.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={enableNotifications}>Enable Notifications</button>
        {!running ? (
          <button onClick={start}>Start Tracking</button>
        ) : (
          <button onClick={stop}>Stop</button>
        )}
        <button onClick={loadWallets}>Reload Wallet List</button>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Poll every
          <input
            type="number"
            min={5}
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            style={{ width: 70 }}
            disabled={running}
          />
          sec
        </label>
      </div>

      <h3 style={{ marginBottom: 6 }}>Wallets (from Google Sheet)</h3>
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
          whiteSpace: "pre-wrap"
        }}
      >
        {log.length ? log.join("\n") : "No events yet."}
      </div>

      <p style={{ marginTop: 14, opacity: 0.7 }}>
        Note: browsers may mute audio if the tab is totally backgrounded. Best setup:
        keep this tab visible in a small window, or install it as an app (Chrome ⋮ → Install).
      </p>
    </main>
  );
}
