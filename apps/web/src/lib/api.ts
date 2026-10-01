import axios from "axios";

/**
 * The API is served under /api/v1. A configured host may or may not already include
 * that prefix, so normalise it rather than silently dropping it and 404ing every call.
 */
function resolveApiBase(configured?: string): string {
  const base = (configured || "").trim().replace(/\/+$/, "");
  if (!base) return "/api/v1";
  return /\/api\/v\d+$/i.test(base) ? base : `${base}/api/v1`;
}

const API_BASE = resolveApiBase(
  (typeof window !== "undefined"
    ? (window as Window & { __KAZIOS_API_URL__?: string }).__KAZIOS_API_URL__
    : undefined) || import.meta.env.VITE_API_URL
);

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  // Generous timeout: a free hosting tier sleeps when idle, so the first request
  // after a quiet period waits for the instance to wake up.
  timeout: Number(import.meta.env.VITE_API_TIMEOUT_MS || 90_000),
});

/**
 * The API host without the /api/v1 suffix.
 *
 * A browser's EventSource cannot set an Authorization header, so the notification
 * stream is opened as a plain URL and needs the host on its own. Keeping the strip in
 * one place stops the two from disagreeing about where the API lives.
 *
 * It lives here rather than in the component because this module is the single place
 * that reads the bundler's environment, and a test that mocks the API gets it for free
 * instead of having to stub a global.
 */
export function apiHost(): string {
  return API_BASE.replace(/\/api\/v\d+$/i, "");
}

api.interceptors.request.use(config => {
  const token = localStorage.getItem("kazios_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem("kazios_token");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export function getApiError(err: any): string {
  return err.response?.data?.error || err.message || "An error occurred";
}
