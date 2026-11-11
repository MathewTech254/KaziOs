import Redis from "ioredis";

/**
 * Whether Redis is configured. When REDIS_URL is unset the API runs without it:
 * sessions fall back to an in-memory store, realtime stays in-process, and the
 * BullMQ worker is not started. Redis code is not deleted; it simply isn't used.
 */
export const redisEnabled = Boolean(process.env.REDIS_URL);

export const redisClient = redisEnabled
  ? new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    })
  : (null as unknown as Redis);

if (redisClient) {
  redisClient.on("connect", () => console.log("Redis connected"));
  redisClient.on("error", err => console.error("Redis error:", err.message));
}

export async function connectRedis(): Promise<void> {
  if (!redisEnabled) {
    console.log("Redis: disabled, using in-memory fallback");
    return;
  }
  try {
    await redisClient.connect();
    console.log("Redis: enabled");
  } catch (err) {
    console.warn("Redis not available, continuing without cache:", (err as Error).message);
  }
}

export function getRedis(): Redis | null {
  return redisEnabled ? redisClient : null;
}
