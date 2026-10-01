import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Check, Inbox, Loader2 } from "lucide-react";
import { api, apiHost, getApiError } from "../lib/api";

interface NotificationItem {
  id: string;
  channel: string;
  type: string;
  title: string;
  body: string;
  status: string;
  link?: string | null;
  actorName?: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Colour of the unread dot, so severity is readable at a glance. */
const TONE: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
  info: "bg-accent",
};

function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

/**
 * The notification bell, fed by a live server sent event stream.
 *
 * Alerts arrive over an open connection rather than a poll, so the badge reflects what
 * has actually happened the moment it happens. The stream is opened once per signed in
 * user and torn down on sign out, so leaving one session cannot leak another's alerts
 * into the next.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Every alert id this bell has ever seen. A stream redelivers frames after a
  // reconnect, and without this the badge would climb for an alert the user has
  // already been shown.
  const seenIds = useRef<Set<string>>(new Set());
  const navigate = useNavigate();

  /**
   * Reads the list from the server.
   *
   * The rows are merged into what is already on screen rather than replacing it. A push
   * that arrived over the stream a moment ago would otherwise be wiped by simply opening
   * the menu, and the alert would vanish exactly as the user went to read it.
   */
  const mergeLoaded = useCallback((rows: NotificationItem[]) => {
    rows.forEach(row => seenIds.current.add(row.id));
    setItems(current => {
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const existing of current) {
        if (!byId.has(existing.id)) byId.set(existing.id, existing);
      }
      return [...byId.values()]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20);
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: NotificationItem[]; meta: { unread: number } }>(
        "/notifications?limit=20"
      );
      const rows = res.data.data || [];
      mergeLoaded(rows);
      setUnread(res.data.meta?.unread ?? 0);
      setError("");
    } catch (err) {
      setError(getApiError(err));
    }
  }, [mergeLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // The live feed. The token is read again on every attempt, because a reconnect after
  // a fresh sign in has to use the new session rather than the one that was closed.
  useEffect(() => {
    if (!localStorage.getItem("kazios_token")) return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const token = localStorage.getItem("kazios_token");
      if (!token) return;

      source = new EventSource(
        `${apiHost()}/api/v1/notifications/stream?access_token=${encodeURIComponent(token)}`
      );

      // The browser reconnects on its own for a network blip, but not when the server
      // closes the stream or refuses it, so a backoff loop covers that case too.
      source.onopen = () => {
        attempt = 0;
        setLive(true);
      };

      source.addEventListener("sync", event => {
        try {
          const data = JSON.parse(event.data);
          if (typeof data?.unread === "number") setUnread(data.unread);
        } catch {
          // A malformed sync frame is not worth surfacing to the user.
        }
      });

      source.addEventListener("notification", event => {
        try {
          const incoming = JSON.parse(event.data) as NotificationItem;
          // The badge is advanced here rather than inside the setItems updater: React
          // defers that callback, so a flag set inside it would still be false when the
          // next line runs and a genuine new alert would never raise the count.
          // Deriving "is this new" from the ids already held needs the current list,
          // so it is tracked in a ref that the updater can read and the reader can trust.
          const alreadyHeld = seenIds.current.has(incoming.id);
          if (alreadyHeld) return;
          seenIds.current.add(incoming.id);
          setItems(current => {
            if (current.some(row => row.id === incoming.id)) return current;
            return [incoming, ...current].slice(0, 20);
          });
          setUnread(count => count + 1);
        } catch {
          // Ignore an unreadable frame rather than breaking the feed.
        }
      });

      source.onerror = () => {
        setLive(false);
        source?.close();
        if (closed) return;
        // Backoff up to about half a minute so a server restart is not hammered.
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        attempt += 1;
        retry = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  // A click anywhere else closes the menu, and Escape works like every other menu.
  useEffect(() => {
    if (!open) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load().finally(() => setLoading(false));
    const onPointer = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  const markAllRead = async () => {
    if (!unread) return;
    try {
      await api.post("/notifications/read", {});
      await load();
    } catch (err) {
      setError(getApiError(err));
    }
  };

  const openItem = async (item: NotificationItem) => {
    // The dot is only cleared once the server confirms it, so the badge can never claim
    // something is read that the database still thinks is unread.
    if (!item.readAt) {
      try {
        await api.post("/notifications/read", { ids: [item.id] });
        setItems(rows =>
          rows.map(row => (row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row))
        );
        setUnread(count => Math.max(0, count - 1));
      } catch {
        // Still navigate: failing to clear the dot must not trap the user on the alert.
      }
    }
    if (item.link) {
      setOpen(false);
      navigate(item.link);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="kazi-shell-icon-button relative flex h-10 w-10 items-center justify-center rounded-lg"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && (
          <span
            className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-foreground"
            aria-hidden="true"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        {/* A quiet dot while the stream is down, so a silent failure is visible rather
            than being mistaken for "nothing is happening". */}
        {!live && (
          <span
            className="absolute bottom-1.5 left-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground"
            title="Live updates reconnecting"
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="kazi-card absolute right-0 top-12 z-40 w-80 overflow-hidden shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && !items.length ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading...
              </div>
            ) : error && !items.length ? (
              <p className="px-4 py-6 text-center text-sm text-danger">{error}</p>
            ) : !items.length ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <Inbox className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">You're all caught up</p>
                <p className="text-xs text-muted-foreground">
                  Sales, payments and low stock will appear here the moment they happen.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void openItem(item)}
                      className={`flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-accent/10 ${
                        item.readAt ? "" : "bg-accent/5"
                      }`}
                    >
                      {!item.readAt ? (
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[item.type] || "bg-accent"}`}
                          aria-label="Unread"
                        />
                      ) : (
                        <span className="mt-1.5 h-2 w-2 shrink-0" />
                      )}
                      <span className={`min-w-0 flex-1 ${item.readAt ? "pl-4" : ""}`}>
                        <span className="block text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.body}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {timeAgo(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
