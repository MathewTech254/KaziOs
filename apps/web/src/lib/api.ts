import axios from "axios";

const API_BASE =
  (typeof window !== "undefined" ? (window as Window & { __KAZIOS_API_URL__?: string }).__KAZIOS_API_URL__ : undefined) ||
  import.meta.env.VITE_API_URL ||
  "/api/v1";

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  // Generous timeout: a free hosting tier sleeps when idle, so the first request
  // after a quiet period waits for the instance to wake up.
  timeout: Number(import.meta.env.VITE_API_TIMEOUT_MS || 90_000),
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("kazios_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
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