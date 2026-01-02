export type TrackedWallet = {
  trader: string;
  wallet: string;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur.trim());
  return out.map((s) => s.replace(/^"|"$/g, "").trim());
}

function detectHeader(row: string[]): boolean {
  const a = (row[0] || "").toLowerCase();
  const b = (row[1] || "").toLowerCase();
  return a.includes("name") || b.includes("wallet") || b.includes("address");
}

export async function fetchTrackedWallets(): Promise<TrackedWallet[]> {
  const csvUrl =
    process.env.SHEET_CSV_URL ||
    (() => {
      const sheetUrl = process.env.GOOGLE_SHEET_URL;
      if (!sheetUrl) return "";
      const match = sheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!match) throw new Error("Invalid GOOGLE_SHEET_URL");
      const id = match[1];
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`;
    })();

  if (!csvUrl) {
    throw new Error("Missing SHEET_CSV_URL (preferred) or GOOGLE_SHEET_URL");
  }

  const res = await fetch(csvUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch sheet CSV: ${res.status}`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const rows = lines.map(parseCsvLine);
  const dataRows = detectHeader(rows[0]) ? rows.slice(1) : rows;

  const wallets: TrackedWallet[] = [];
  for (const r of dataRows) {
    const trader = (r[0] || "").trim();
    const wallet = (r[1] || "").trim();
    if (!trader || !wallet) continue;
    wallets.push({ trader, wallet });
  }

  return wallets;
}
