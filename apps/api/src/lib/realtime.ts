import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { getRedis } from "./redis";

/**
 * Real time event fan out.
 *
 * A notification is written to the database once, then announced here. Connected
 * browsers receive it over Server Sent Events without polling.
 *
 * One process is not the whole system: the API is deployed as more than one replica,
 * and the worker that detects a low stock level is a separate process again. So an
 * event published on one replica must still reach a user whose browser is connected
 * to another. Redis pub/sub carries it between them.
 *
 * Redis is optional. When it is unavailable the in process emitter still delivers to
 * this replica's own browsers, which is exactly what a single machine development
 * setup needs. Publishing never throws: an alerting path must not be able to take
 * down the request that triggered it.
 */

const CHANNEL = "kazios:events";

/** Distinguishes an event we published from one another replica published. */
const INSTANCE_ID = randomUUID();

export interface RealtimeEvent<T = unknown> {
  organizationId: string;
  userId: string;
  type: string;
  payload: T;
  origin?: string;
}

type Listener = (event: RealtimeEvent) => void;

/**
 * The default limit of ten listeners would start throwing under load, and a busy
 * shop can legitimately hold many open connections.
 */
const local = new EventEmitter();
local.setMaxListeners(0);

let subscriber: Redis | null = null;
let subscriberReady = false;

/**
 * Delivers an event to the browsers attached to this process. Events published
 * elsewhere arrive here from Redis; events published here are emitted directly.
 */
function deliver(event: RealtimeEvent): void {
  local.emit(event.organizationId, event);
}

/**
 * Subscribes to the shared channel. Called once at boot. Failure is not fatal: the
 * API still serves its own events locally and simply never sees other replicas'.
 */
export function startRealtimeSubscriber(): void {
  if (subscriberReady) return;
  subscriberReady = true;

  try {
    const redis = getRedis();
    // A connection in subscriber mode cannot issue ordinary commands, so the
    // subscriber has to be a separate connection from the shared client.
    subscriber = redis.duplicate();
  } catch (err) {
    console.warn(
      "Realtime subscriber unavailable, running single process:",
      (err as Error).message
    );
    return;
  }

  const connection = subscriber;

  connection.on("error", err => console.error("Realtime subscriber error:", err.message));
  connection.on("ready", () => {
    // Re-subscribing is cheap and idempotent, and covers a Redis restart.
    connection
      .subscribe(CHANNEL)
      .catch(err => console.error("Realtime subscribe failed:", err.message));
  });
  connection.on("message", (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const event = JSON.parse(raw) as RealtimeEvent;
      // Our own event already went out through deliver() when it was published.
      if (event.origin === INSTANCE_ID) return;
      deliver(event);
    } catch {
      // A malformed message must not take the subscriber down with it.
    }
  });
}

/** Announces an event to every replica, and to this one immediately. */
export function publishRealtime<T>(event: Omit<RealtimeEvent<T>, "origin">): void {
  const enriched: RealtimeEvent<T> = { ...event, origin: INSTANCE_ID };
  deliver(enriched);
  try {
    getRedis()
      .publish(CHANNEL, JSON.stringify(enriched))
      .catch(err => console.warn("Realtime publish failed:", err.message));
  } catch {
    // Redis being down must never surface as a failed business operation.
  }
}

/**
 * Listens for events addressed to one organization. Returns an unsubscribe function
 * so a closed browser connection leaves nothing behind.
 */
export function subscribeRealtime(organizationId: string, listener: Listener): () => void {
  local.on(organizationId, listener);
  return () => {
    local.removeListener(organizationId, listener);
  };
}

/** Exposed for tests: how many browser connections this process is holding. */
export function realtimeListenerCount(organizationId: string): number {
  return local.listenerCount(organizationId);
}
