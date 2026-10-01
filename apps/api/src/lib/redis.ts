import Redis from "ioredis";

export const redisClient = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

redisClient.on("connect", () => console.log("Redis connected"));
redisClient.on("error", err => console.error("Redis error:", err.message));

export async function connectRedis() {
  try {
    await redisClient.connect();
  } catch (err) {
    console.warn("Redis not available, continuing without cache:", (err as Error).message);
  }
}

export function getRedis() {
  return redisClient;
}
