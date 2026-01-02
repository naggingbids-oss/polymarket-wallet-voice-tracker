export type TrackedWallet = {
  trader: string;
  wallet: string;
};

function sheetToCsvExportUrl(sheetUrl: string): string {
  // Accepts a normal Google Sheet URL and converts to CSV export
  // Example input:
  // https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing
  const m = sheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("Invalid GOOGLE_SHEET_URL. Paste the full Google Sheets URL.");
  const id = m[1];

  // Default: first sheet tab (gid=0). If you need a different tab later we can extend this.
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`;
}

function parseCsvLine(line: string): string[] {
  // Minimal CSV parsing (handles quoted commas)
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) {
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

export async function fetchTrackedWallets(): Promise<TrackedWallet[]> {
  const sheetUrl = process.env.GOOGLE_SHEET_URL;
  if (!sheetUrl) throw new Error("Missing env var GOOGLE_SHEET_URL");

  const csvUrl = sheetToCsvExportUrl(sheetUrl);
  const res = await fetch(csvUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch Google Sheet CSV: ${res.status}`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  // If your first row is a header, this will skip it automatically if it contains "wallet" or "address".
  const rows = lines.map(parseCsvLine);
  const looksLikeHeader = (rows[0]?.[0] || "").toLowerCase().includes("name") ||
    (rows[0]?.[1] || "").toLowerCase().includes("wallet") ||
    (rows[0]?.[1] || "").toLowerCase().includes("address");

  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  const items: TrackedWallet[] = [];
  for (const r of dataRows) {
    const trader = (r[0] || "").trim();
    const wallet = (r[1] || "").trim();
    if (!trader || !wallet) continue;
    items.push({ trader, wallet });
  }
  return items;
}
