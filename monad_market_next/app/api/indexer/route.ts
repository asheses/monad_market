import { NextResponse } from "next/server";
import { indexerNotifications } from "@/lib/server/indexer-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const endpoint = process.env.ENVIO_GRAPHQL_URL ?? "http://127.0.0.1:8080/v1/graphql";
const query = `query MarketData($market: String!, $trader: String!) {
  MarketState(where: { marketAddress: { _eq: $market } }, limit: 1) {
    marketAddress marketState bestNoBuyPrice bestNoSellPrice bestYesBuyPrice bestYesSellPrice
  }
  MarketOrders(where: { marketAddress: { _eq: $market } }, order_by: { id: asc }) {
    marketAddress traderAddress isYes isBuy price orderIndex shareAmount endTimestamp
  }
  VaultBalance(where: { traderAddress: { _eq: $trader } }, limit: 1) { balance }
  MarketPosition(where: { marketAddress: { _eq: $market }, traderAddress: { _eq: $trader } }, limit: 1) {
    usdcLocked yesAmount yesLocked noAmount noLocked
  }
}`;

export async function GET(request: Request) {
  const market = new URL(request.url).searchParams.get("market")?.toLowerCase();
  if (!market || !/^0x[0-9a-f]{40}$/.test(market)) {
    return NextResponse.json({ error: "Invalid market address" }, { status: 400 });
  }
  const trader = new URL(request.url).searchParams.get("trader")?.toLowerCase() ?? "";
  if (trader && !/^0x[0-9a-f]{40}$/.test(trader)) return NextResponse.json({ error: "Invalid trader address" }, { status: 400 });
  async function read() {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { market, trader } }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.[0]?.message ?? `Indexer HTTP ${response.status}`);
    return payload.data;
  }
  if (new URL(request.url).searchParams.get("stream") === "1") {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      async start(controller) {
        let stopped = false;
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(heartbeat);
          unsubscribe();
          request.signal.removeEventListener("abort", stop);
          try { controller.close(); } catch { /* Stream may already be cancelled. */ }
        };
        cleanup = stop;
        const notify = () => {
          if (!stopped) controller.enqueue(encoder.encode("event: refresh\ndata: {}\n\n"));
        };
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) { stop(); return; }
        try {
          unsubscribe = await indexerNotifications.subscribe({ market: market!, trader, notify, disconnect: stop });
          if (stopped) { unsubscribe(); return; }
          // Subscribe first, then ask the browser for a fresh snapshot, including reconnects.
          notify();
          heartbeat = setInterval(() => {
            if (!stopped) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }, 15000);
        } catch {
          if (!stopped) {
            controller.enqueue(encoder.encode("event: indexer-error\ndata: {}\n\n"));
            stop();
          }
        }
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    } });
  }

  try {
    return NextResponse.json(await read(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Indexer unavailable" }, { status: 503 });
  }
}
