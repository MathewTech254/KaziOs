import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  /**
   * Machine readable context for the caller.
   *
   * Entitlement refusals carry the feature, the plan and where to upgrade, so the browser
   * can offer the next step on the page the request came from instead of printing a
   * sentence and leaving the owner to work out what to do. It is additive and optional:
   * every existing throw of this class is unaffected.
   */
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Wraps an async route handler so a rejection becomes a normal 500 response.
 *
 * Express 4 does not await a handler: an async function that throws leaves a rejected
 * promise that Express never sees. Node treats that as an unhandled rejection and
 * terminates the process, so one bad request anywhere takes down the whole API rather
 * than returning an error to the caller. Every async handler in this codebase therefore
 * goes through here, and a route that throws for real reasons still reaches the error
 * handler with its own message.
 */
export function asyncRoute(
  handler: (req: any, res: any, next: any) => Promise<unknown>
): (req: any, res: any, next: any) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * The last line of defence. Registered after every route, so anything that reaches it
 * has already failed its own handling; without this the process would simply stop.
 */
export function lastResortGuard(): (err: any, _req: any, res: any, _next: any) => void {
  return (err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "An unexpected error occurred" });
  };
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  console.error("Error:", err);
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      // Present only when the error carries it, so existing responses are byte identical.
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.issues });
    return;
  }
  if (err.name === "ZodError") {
    res.status(400).json({ error: "Validation failed", details: err.issues || err.errors });
    return;
  }
  if (err.name === "ValidationError") {
    res.status(400).json({ error: "Validation failed", details: err.details || err.errors });
    return;
  }
  if (err.name === "PrismaClientKnownRequestError") {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Record already exists" });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Record not found" });
      return;
    }
  }
  res.status(500).json({ error: "Internal server error" });
}
