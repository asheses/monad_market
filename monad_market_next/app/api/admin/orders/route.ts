import { NextResponse } from "next/server";
import { db } from "@/lib/server/admin";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams; const market = q.get("market"); const price = Number(q.get("price")); const yes = q.get("isYes") === "true";
  if (!market || !Number.isInteger(price) || price < 1 || price > 99) return NextResponse.json({ error: "查询条件无效" }, { status: 400 });
  const c = await db(); try { const r = await c.query('SELECT id,"traderAddress",price,"orderIndex","shareAmount","isBuy","isYes",version,"endTimestamp" FROM "MarketOrders" WHERE "marketAddress"=$1 AND price=$2 AND "isYes"=$3 AND "shareAmount">0 ORDER BY "orderIndex"', [market.toLowerCase(), price, yes]); return NextResponse.json(r.rows); } finally { await c.end(); }
}
