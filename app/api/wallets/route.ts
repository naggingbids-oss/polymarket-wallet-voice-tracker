import { NextResponse } from "next/server";

type WalletRow = { name: string; wallet: string };

function parseCsv(csv: string): WalletRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: WalletRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const name = (parts[0] ?? "").replace(/^"|"$/g, "").trim();
    const wallet = (parts[1] ?? "").replace(/^"|"$/g, "").trim();
    if (!name || !wallet) continue;

    // Skip header if present
    if (i === 0 && /name/i.test(name) && /wallet/i.test(wallet)) continue;

    rows.push({ name, wallet });
  }
  return rows;
}

export async function GET() {
  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    return NextResponse.json(
      { error: "Missing SHEET_CSV_URL env var" },
      { status: 500 }
    );
  }

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Failed to fetch sheet CSV (${res.status})` },
      { status: 500 }
    );
  }

  const csv = await res.text();
  const wallets = parseCsv(csv);
  return NextResponse.json({ wallets });
}
