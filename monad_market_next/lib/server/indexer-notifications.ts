import "server-only";
import { Client } from "pg";

type Scope = { market: string; trader: string };
type Subscriber = Scope & { notify: () => void; disconnect: () => void };

class IndexerNotifications {
  private subscribers = new Set<Subscriber>();
  private client?: Client;
  private connecting?: Promise<void>;

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const client = new Client({
      connectionString: process.env.ENVIO_DATABASE_URL ?? "postgresql://postgres:testing@127.0.0.1:5433/envio-dev",
      application_name: "market-sse-listener",
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      keepAlive: true,
    });
    this.client = client;
    let pruneTimer: ReturnType<typeof setInterval> | undefined;
    const fail = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.connecting = undefined;
      clearInterval(pruneTimer);
      for (const subscriber of [...this.subscribers]) subscriber.disconnect();
      void client.end().catch(() => {});
    };
    client.on("error", fail);
    client.on("end", fail);
    client.on("notification", message => {
      if (message.channel !== "market_realtime" || !message.payload) return;
      void client.query<Scope>(
        "SELECT market, trader FROM market_realtime.changes WHERE transaction_id = $1",
        [message.payload],
      ).then(({ rows }) => {
        for (const subscriber of this.subscribers) {
          if (rows.some(scope =>
            (!scope.market || scope.market === subscriber.market) &&
            (!scope.trader || scope.trader === subscriber.trader))) subscriber.notify();
        }
      }).catch(fail);
    });
    this.connecting = (async () => {
      try {
        await client.connect();
        await client.query("LISTEN market_realtime");
        // Verify installation before accepting streams. Keep one day for all listeners.
        await client.query("DELETE FROM market_realtime.changes WHERE created_at < now() - interval '1 day'");
        pruneTimer = setInterval(() => {
          void client.query("DELETE FROM market_realtime.changes WHERE created_at < now() - interval '1 day'").catch(fail);
        }, 3600000);
        pruneTimer.unref();
      } catch (error) {
        fail();
        throw error;
      }
    })();
    return this.connecting;
  }

  async subscribe(subscriber: Subscriber): Promise<() => void> {
    await this.connect();
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }
}

// Share a listener across routes and development reloads in this Node process.
const globalState = globalThis as typeof globalThis & { marketIndexerNotifications?: IndexerNotifications };
export const indexerNotifications = globalState.marketIndexerNotifications ??= new IndexerNotifications();
