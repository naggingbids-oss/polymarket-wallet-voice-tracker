"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TradeEvent = {
  id: string;
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

function fmtTimeNY(tsMs: number) {
  const d = new Date(tsMs);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function fmtNum(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function speak(text: string, rate = 1.15) {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;

  // cancel any backlog so it stays “snappy”
  synth.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  u.pitch = 1.0;
  u.volume = 1.0;
  synth.speak(u);
}

export default function Page() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [voiceOn, setVoiceOn] = useState(true);
  const [minUsdEnabled, setMinUsdEnabled] = useState(false);
  const [minUsd, setMinUsd] = useState(500);

  const esRef = useRef<EventSource | null>(null);

  const filtered = useMemo(() => {
    const base = [...events].sort((a, b) => b.timestampMs - a.timestampMs);
    if (!minUsdEnabled) return base;
    return base.filter((e) => (e.usdc ?? 0) >= minUsd);
  }, [events, minUsdEnabled, minUsd]);

  useEffect(() => {
    const url = new URL("/api/stream", window.location.origin);
    // (server-side poll is fixed; filter is client-side for instant toggles)
    const es = new EventSource(url.toString());
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data?.type === "events" && Array.isArray(data.events)) {
          const incoming: TradeEvent[] = data.events;

          setEvents((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const merged = [...prev];
            for (const e of incoming) {
              if (!seen.has(e.id)) merged.push(e);
            }
            // cap memory
            if (merged.length > 2000) return merged.slice(-1500);
            return merged;
          });

          // voice + text at same time:
          if (voiceOn) {
            for (const e of incoming) {
              // apply same filter rules to voice
              if (minUsdEnabled && (e.usdc ?? 0) < minUsd) continue;

              const sideWord = e.side === "BUY" ? "bought" : "sold";
              const shares = e.shares ? fmtNum(e.shares, 0) : "";
              const title = e.title || "a market";
              const outcome = (e.outcome || "").toLowerCase().includes("no") ? "No" : "Yes";
              const p = Number.isFinite(e.price ?? NaN) ? ` at ${fmtNum(e.price!, 3)} dollars per share` : "";
              const usd = Number.isFinite(e.usdc ?? NaN) ? ` for ${fmtNum(e.usdc!, 2)} dollars` : "";

              const line = `${e.trader} ${sideWord} ${shares} shares of ${outcome} in ${title}${p}${usd}`;
              speak(line, 1.15);
            }
          }
        }
      } catch {
        // ignore
      }
    };

    return () => {
      try {
        es.close();
      } catch {}
      esRef.current = null;
    };
  }, [voiceOn, minUsdEnabled, minUsd]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-2xl font-semibold tracking-tight">Polymarket Wallet Voice Tracker</div>
            <div className="mt-1 text-sm text-white/60">
              Live trade alerts for your Google Sheet wallet list. Includes BUY and SELL, price per share, and timestamps (NY).
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm">
              <span
                className={[
                  "inline-block h-2.5 w-2.5 rounded-full",
                  connected ? "bg-emerald-400" : "bg-white/30",
                ].join(" ")}
              />
              <span className="text-white/80">{connected ? "Connected" : "Reconnecting…"}</span>
            </div>

            <button
              className={[
                "rounded-xl border px-3 py-2 text-sm transition",
                voiceOn ? "border-white/20 bg-white/10" : "border-white/10 bg-transparent text-white/70",
              ].join(" ")}
              onClick={() => setVoiceOn((v) => !v)}
            >
              Voice: {voiceOn ? "On" : "Off"}
            </button>

            <button
              className={[
                "rounded-xl border px-3 py-2 text-sm transition",
                minUsdEnabled ? "border-white/20 bg-white/10" : "border-white/10 bg-transparent text-white/70",
              ].join(" ")}
              onClick={() => setMinUsdEnabled((v) => !v)}
            >
              Filter: {minUsdEnabled ? `≥ $${minUsd}` : "Off"}
            </button>

            {minUsdEnabled && (
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm">
                <span className="text-white/60">Min $</span>
                <input
                  className="w-24 rounded-lg bg-black/60 px-2 py-1 text-white outline-none ring-1 ring-white/10 focus:ring-white/20"
                  type="number"
                  value={minUsd}
                  min={0}
                  step={50}
                  onChange={(e) => setMinUsd(Number(e.target.value || 0))}
                />
              </div>
            )}
          </div>
        </div>

        {/* Main */}
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-12">
          {/* Left: Live log */}
          <div className="md:col-span-8">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <div className="text-sm font-medium text-white/85">Live Log</div>
                <div className="text-xs text-white/50">{filtered.length} events</div>
              </div>

              <div className="max-h-[70vh] overflow-auto px-2 py-2">
                {filtered.length === 0 ? (
                  <div className="px-3 py-10 text-center text-sm text-white/50">
                    Waiting for trades…
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {filtered.slice(0, 250).map((e) => {
                      const isBuy = e.side === "BUY";
                      const dot = isBuy ? "bg-emerald-400" : "bg-red-500";

                      const verb = isBuy ? "bought" : "sold";
                      const verbClass = isBuy ? "text-emerald-400" : "text-red-500";

                      const outcome = (e.outcome || "").toLowerCase().includes("no") ? "No" : "Yes";
                      const outcomeClass =
                        outcome === "Yes" ? "text-emerald-400" : "text-red-500";

                      const shares = Number.isFinite(e.shares ?? NaN) ? `${fmtNum(e.shares!, 0)} shares` : "";
                      const price = Number.isFinite(e.price ?? NaN) ? `$${fmtNum(e.price!, 3)}/share` : "";
                      const usd = Number.isFinite(e.usdc ?? NaN) ? `$${fmtNum(e.usdc!, 2)}` : "";

                      return (
                        <li
                          key={e.id}
                          className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 hover:bg-white/[0.04]"
                        >
                          <div className="flex items-start gap-3">
                            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="text-xs text-white/50">{fmtTimeNY(e.timestampMs)}</span>
                                <span className="font-semibold text-white">{e.trader}</span>
                                <span className={`font-semibold ${verbClass}`}>{verb}</span>
                                <span className="text-white/90">{shares}</span>
                                <span className={`font-semibold ${outcomeClass}`}>{outcome}</span>
                                <span className="text-white/60">in</span>
                                <span className="text-white/90">{e.title || "Unknown market"}</span>
                              </div>

                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/55">
                                {price && <span>{price}</span>}
                                {usd && <span>notional {usd}</span>}
                                <span className="truncate">wallet {e.wallet}</span>
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Right: info panel */}
          <div className="md:col-span-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-white/85">How it works</div>
              <div className="mt-2 space-y-2 text-sm text-white/60">
                <p>
                  Wallets are loaded from your Google Sheet (Column A = trader name, Column B = wallet).
                </p>
                <p>
                  The server polls Polymarket and pushes updates instantly to this page (no manual refresh).
                </p>
                <p>
                  Voice uses your browser’s built-in speech engine. Turn it off any time.
                </p>
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/55">
                Tip: keep this tab open all day. If voice ever “stops,” toggle Voice off/on once.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 text-xs text-white/35">
          Times shown in America/New_York (24h).
        </div>
      </div>
    </div>
  );
}
