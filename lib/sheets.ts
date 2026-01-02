export type TrackedWallet = {
  trader: string;
  wallet: string;
};

/**
 * Very small CSV parser that supports quoted commas.
 */
function parseCsvLine(line: string): string[] {
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

/**
 * Fetch tracked wallets from Google Sheets.
 *
 * Priority:
 * 1) SHEET_CSV_URL (already-exported CSV URL)  ← RECOMMENDED
 * 2) GOOGLE_SHEET_URL (normal sheet URL, converted internally)
 */
export async function fetchTrackedWallets(): Promise<TrackedWallet[]> {
  const csvUrl =
    process.env.SHEET_CSV_URL ??
    (() => {
      const sheetUrl = process.env.GOOGLE_SHEET_URL;
      if (!sheetUrl) return null;

      const match = sheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!match) {
        throw new Error("Invalid GOOGLE_SHEET_URL format");
      }

      const sheetId = match[1];
      return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    })();

  if (!csvUrl) {
    throw new Error(
      "Missing environment variable: set SHEET_CSV_URL (preferred) or GOOGLE_SHEET_URL"
    );
  }

  const res = await fetch(csvUrl, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV: ${res.status}`);
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);

  if (lines.length === 0) return [];

  const rows = lines.map(parseCsvLine);

  // Detect header row automatically
  const firstRow = rows[0] || [];
  const looksLikeHeader =
    (firstRow[0] || "").toLowerCase().includes("name") ||
    (firstRow[1] || "").toLowerCase().includes("wallet") ||
    (first
