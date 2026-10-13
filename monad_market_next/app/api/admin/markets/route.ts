import { NextResponse } from "next/server";
import { db, createMarketOnChain } from "@/lib/server/admin";
export const runtime = "nodejs";
export async function GET() { const c = await db(); try { const r = await c.query('SELECT * FROM market_realtime.market_metadata ORDER BY "settleAt" ASC'); return NextResponse.json(r.rows); } finally { await c.end(); } }
export async function POST(request: Request) {
  try {
    const body = await request.json() as { product: string; productLabel: string; date: string; targetUsd: string; feeRate: string; makerRebateRate: string; oracle: string };
    if (!body.product || !body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !/^\d+(\.\d+)?$/.test(body.targetUsd)) throw new Error("商品、日期或金额无效");
    const settleAt = `${body.date}T15:59:59.000Z`;
    const oracle = process.env.ORACLE_ADDRESS; if (!oracle) throw new Error("ORACLE_ADDRESS 未配置");
    const { market, hash } = await createMarketOnChain(oracle as `0x${string}`, BigInt(body.feeRate), BigInt(body.makerRebateRate));
    const c = await db(); try { await c.query('INSERT INTO market_realtime.market_metadata ("marketAddress",product,"productLabel","targetUsd","settleAt","oracle","createTxHash","status") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [market.toLowerCase(), body.product, body.productLabel, body.targetUsd, settleAt, oracle.toLowerCase(), hash, "OPEN"]); } finally { await c.end(); }
    return NextResponse.json({ market, hash });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 400 }); }
}
