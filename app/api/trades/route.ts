import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("user");

  if (!user) {
    return NextResponse.json({ error: "Missing ?user=0x..." }, { status: 400 });
  }

  const limit = searchParams.get("limit") ?? "10";

  // Polymarket data API trades endpoint
  const url = `https://data-api.polymarket.com/trades?user=${encodeURIComponent(
    user
  )}&limit=${encodeURIComponent(limit)}&takerOnly=true`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Polymarket API error (${res.status})` },
      { status: 500 }
    );
  }

  const data = await res.json();
  return NextResponse.json({ trades: data });
}
