import { NextResponse } from "next/server";
import { db } from "@/lib/server/admin";
export const runtime = "nodejs";
export async function GET() { const c=await db(); try { const r=await c.query('SELECT "marketAddress",product,"productLabel","targetUsd","settleAt",status FROM market_realtime.market_metadata ORDER BY "createdAt" DESC'); return NextResponse.json(r.rows,{headers:{"Cache-Control":"no-store"}}); } finally { await c.end(); } }
