"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

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

type LogItem = {
  id: string;
  side: "BUY" | "SELL";
  text: string;
};

function fmtShares(n: number) {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}
function fmtPrice(p: number) {
  return p > 0 && p < 1 ? `${Math.round(p * 100)}¢` : `$${p.toFixed(2)}`;
}
function fmtUsd(n: number) {
  return `$${n.toFixed(2)}`;
}

export default function Page() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);
  const [trackMode, setTrackMode] = useState<"BUY" | "SELL" | "BOTH">("BOTH");
  const [minFilterEnabled, setMinFilterEnabled] = useState(true);
  const [minUsd, setMinUsd] = useState(500);

  const seenRef = useRef<Record<string, true>>({});
  const stopRef = useRef(false);

  function addLog(text: string, side: "BUY" | "SELL" = "BUY") {
    setLog((l) => [{ id: `${Date.now()}-${Math.random()}`, text, side }, ...l].slice(0, 200));
  }

  async function loadWallets() {
    const r = await fetch("/api/wallets");
    const j = await r.json();
    setWallets(j.wallets || []);
    addLog(`Loaded ${j.wallets?.length ?? 0} wallets`);
  }

  function speak(text: string) {
    if (document.visibilityState !== "visible") return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.18;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  async function pollOnce() {
    for (const w of wallets) {
      const r = await fetch(`/api/trades?user=${w.wallet}`);
      const j = await r.json();
      for (const t of j.trades || []) {
        const key = `${t.transactionHash}:${t.timestamp}`;
        if (seenRef.current[key]) continue;
        if (trackMode !== "BOTH" && t.side !== trackMode) continue;

        const usd = t.size * t.price;
        if (minFilterEnabled && usd < minUsd) continue;

        seenRef.current[key] = true;

        const dot = t.side === "BUY" ? "🟢" : "🔴";
        const verb = t.side === "BUY" ? "bought" : "sold";
        const text = `${dot} ${w.name} ${verb} ${fmtShares(t.size)} @ ${fmtPrice(
          t.price
        )}/share — ${t.title}${t.outcome ? ` (${t.outcome})` : ""} — ~${fmtUsd(usd)}`;

        addLog(text, t.side);
        speak(`${w.name} ${verb} ${fmtShares(t.size)} shares at ${fmtPrice(t.price)} per share`);

        await fetch("/api/push/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
      }
    }
  }

  async function loop() {
    stopRef.current = false;
    while (!stopRef.current) {
      await pollOnce();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async function start() {
    setRunning(true);
    await loadWallets();
    loop();
  }

  function stop() {
    stopRef.current = true;
    setRunning(false);
  }

  async function enablePush() {
    try {
      addLog("Starting push setup…");

      const perm = await Notification.requestPermission();
      addLog(`Notification permission: ${perm}`);
      if (perm !== "granted") return;

      const reg = await navigator.serviceWorker.register("/sw.js");
      addLog("Service worker registered");

      const pkRes = await fetch("/api/push/public-key");
      const { publicKey } = await pkRes.json();

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub)
      });

      addLog("✅ Push enabled successfully");
    } catch (e: any) {
      addLog(`❌ Push failed: ${e.message}`, "SELL");
    }
  }

  async function sendTestPush() {
    await fetch("/api/push/test", { method: "POST" });
    addLog("Sent test push");
  }

  useEffect(() => {
    loadWallets();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-6xl mx-auto grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Live Log</CardTitle>
            <CardDescription>Push notifications mirror this exactly</CardDescription>
          </CardHeader>
          <CardContent className="h-[600px] overflow-auto space-y-2">
            {log.map((l) => (
              <div
                key={l.id}
                className={`rounded-lg border p-3 text-sm ${
                  l.side === "BUY"
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : "border-red-500/30 bg-red-500/10"
                }`}
              >
                {l.text}
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={enablePush}>
                  Enable Push
                </Button>
                <Button variant="outline" onClick={sendTestPush}>
                  Send test push
                </Button>
                {!running ? (
                  <Button onClick={start}>Start</Button>
                ) : (
                  <Button variant="outline" onClick={stop}>
                    Stop
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <div>Track mode</div>
                <Select value={trackMode} onValueChange={(v) => setTrackMode(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BOTH">Buy + Sell</SelectItem>
                    <SelectItem value="BUY">Buy only</SelectItem>
                    <SelectItem value="SELL">Sell only</SelectItem>
                  </SelectContent>
                </Select>

                <div className="flex items-center justify-between">
                  <span>Min $ filter</span>
                  <Switch checked={minFilterEnabled} onCheckedChange={setMinFilterEnabled} />
                </div>

                <input
                  type="number"
                  value={minUsd}
                  onChange={(e) => setMinUsd(Number(e.target.value))}
                  className="w-full border rounded-md p-2 bg-background"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Wallets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {wallets.map((w) => (
                <div key={w.wallet} className="border rounded-md p-2">
                  <div className="font-semibold">{w.name}</div>
                  <div className="text-xs text-muted-foreground">{w.wallet}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
