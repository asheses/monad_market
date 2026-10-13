// Integration test: requires initialized Envio DB, realtime.sql and a running Next server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const base = process.env.TEST_FRONTEND_URL ?? "http://localhost:3002";
const database = process.env.ENVIO_DATABASE_URL ?? "postgresql://postgres:testing@127.0.0.1:5433/envio-dev";
const address = () => `0x${randomBytes(20).toString("hex")}`;
const market = address(), trader = address(), otherMarket = address();
const db = new Client({ connectionString: database });
const listener = new Client({ connectionString: database });
const notifications = [];
const streams = [];
let connected = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await pause(50);
  }
  assert.fail("Timed out waiting for realtime event");
}
async function stream(marketAddress, wallet = "") {
  const abort = new AbortController();
  const state = { count: 0, abort, task: undefined };
  streams.push(state);
  const response = await fetch(`${base}/api/indexer?${new URLSearchParams({ market: marketAddress, trader: wallet, stream: "1" })}`, { signal: abort.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  state.task = (async () => {
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (event.startsWith("event: refresh")) state.count++;
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
  await until(() => state.count === 1);
  return state;
}
try {
  await db.connect();
  connected = true;
  await listener.connect();
  listener.on("notification", message => notifications.push(message.payload));
  await listener.query("LISTEN market_realtime");
  const matching = await stream(market, trader);
  const bookOnly = await stream(market);
  const sameWallet = await stream(otherMarket, trader);
  const unrelated = await stream(otherMarket);

  await db.query("BEGIN");
  const { rows: [{ tx }] } = await db.query("SELECT pg_current_xact_id()::text AS tx");
  await db.query(`INSERT INTO public."MarketState" VALUES ($1,$1,0,0,0,$2,$2,0,0,100,0,100,0,0)`, [market, trader]);
  await db.query(`INSERT INTO public."VaultBalance" VALUES ($1,$1,123,0,0)`, [trader]);
  await db.query(`INSERT INTO public."MarketPosition" VALUES ($1,$2,$3,1,2,3,4,5,0,0)`, [`${market}-${trader}`, market, trader]);
  await db.query(`UPDATE public."VaultBalance" SET balance = 456 WHERE id = $1`, [trader]);
  await pause(200);
  assert.equal(notifications.filter(id => id === tx).length, 0, "must not notify before commit");
  assert.equal(matching.count, 1);
  await db.query("COMMIT");
  await until(() => matching.count === 2 && bookOnly.count === 2 && sameWallet.count === 2);
  assert.equal(notifications.filter(id => id === tx).length, 1, "one notification for multi-table batch");
  assert.equal(unrelated.count, 1, "unrelated viewer must not be notified");
  const snapshot = await fetch(`${base}/api/indexer?${new URLSearchParams({ market, trader })}`).then(r => r.json());
  assert.equal(snapshot.VaultBalance[0].balance, "456");
  assert.equal(snapshot.MarketPosition[0].yesAmount, "2");

  await db.query("BEGIN");
  const rolledBack = (await db.query("SELECT pg_current_xact_id()::text AS tx")).rows[0].tx;
  await db.query(`UPDATE public."VaultBalance" SET balance = 789 WHERE id = $1`, [trader]);
  await db.query("ROLLBACK");
  await pause(300);
  assert.equal(notifications.filter(id => id === rolledBack).length, 0);
  assert.equal(matching.count, 2);

  await db.query(`UPDATE public."VaultBalance" SET balance = balance WHERE id = $1`, [trader]);
  await pause(200);
  assert.equal(matching.count, 2, "no-op writes must not notify");

  await db.query(`UPDATE public."MarketPosition" SET "yesAmount" = 8 WHERE id = $1`, [`${market}-${trader}`]);
  await until(() => matching.count === 3);
  await pause(100);
  assert.equal(bookOnly.count, 2, "position update is wallet-specific");
  assert.equal(sameWallet.count, 2, "position update is market-specific");

  await db.query(`DELETE FROM public."MarketPosition" WHERE id = $1`, [`${market}-${trader}`]);
  await until(() => matching.count === 4);
  const reconnected = await stream(market, trader);
  assert.equal(reconnected.count, 1, "reconnected stream requests a fresh snapshot");
  assert.equal((await db.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'market-sse-listener'")).rows[0].count, "1");
  await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'market-sse-listener'");
  await Promise.race([Promise.all(streams.map(stream => stream.task)), pause(5000).then(() => assert.fail("SSE did not close after DB disconnection"))]);
  await stream(market, trader);
  console.log("PASS: commit batching, rollback, no-op, scoped routing, deletion, snapshot, reconnect, shared listener and DB connection recovery");
} finally {
  for (const stream of streams) stream.abort.abort();
  await Promise.allSettled(streams.map(stream => stream.task));
  if (connected) {
  await db.query("ROLLBACK").catch(() => {});
  await db.query(`DELETE FROM public."MarketPosition" WHERE "marketAddress" = $1`, [market]).catch(() => {});
  await db.query(`DELETE FROM public."VaultBalance" WHERE id = $1`, [trader]).catch(() => {});
  await db.query(`DELETE FROM public."MarketState" WHERE id = $1`, [market]).catch(() => {});
  await db.query("DELETE FROM market_realtime.changes WHERE market = $1 OR trader = $2", [market, trader]).catch(() => {});
  }
  await listener.end();
  await db.end();
}
