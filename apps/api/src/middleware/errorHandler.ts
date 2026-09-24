import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  console.error("Error:", err);
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
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