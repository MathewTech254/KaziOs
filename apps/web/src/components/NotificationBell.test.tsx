import { render, screen, fireEvent, act } from "@testing-library/react";
// TypeScript only sees a module's types if something in the program imports it, so the
// matcher types are pulled in here as well as in the Jest setup file.
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { NotificationBell } from "./NotificationBell";
import { api } from "../lib/api";

/**
 * The bell is the one piece of the interface that has to behave correctly on its own:
 * a cashier may not notice it, but an owner watching the dashboard depends on seeing an
 * alert at the moment it happens rather than on refresh.
 *
 * The API is mocked because these tests are about what the bell does with an answer,
 * not about how the answer is produced.
 */
jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  apiHost: () => "",
  getApiError: (err: any) => err?.message || "error",
}));

const mockedApi = api as jest.Mocked<typeof api>;

/** Stands in for the browser's EventSource, which jsdom does not implement. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((e: any) => void)[]> = {};
  closed = false;
  url = "";

  constructor(path: string) {
    this.url = path;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: any) => void) {
    (this.listeners[type] ||= []).push(handler);
  }

  close() {
    this.closed = true;
  }

  /**
   * Pushes a frame the way the server would.
   */
  emit(type: string, data: unknown) {
    // Wrapped in act because the resulting state update belongs to React: without it
    // the assertion runs against a render that has not happened yet, and a genuinely
    // working alert looks like one that never arrived.
    act(() => {
      for (const handler of this.listeners[type] || []) {
        handler({ data: JSON.stringify(data) });
      }
    });
  }
}

const emptyList = { data: { data: [], meta: { unread: 0 } } } as never;

function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    channel: "in_app",
    type: "warning",
    title: "Low stock",
    body: "Milk 1L is down to 3 in Mombasa Road Store.",
    status: "SENT",
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("NotificationBell", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    localStorage.clear();
    localStorage.setItem("kazios_token", "test-token");
    mockedApi.get.mockResolvedValue(emptyList);
    mockedApi.post.mockResolvedValue({ data: {} } as never);
    (global as any).EventSource = FakeEventSource;
  });

  afterEach(() => {
    delete (global as any).EventSource;
  });

  const renderBell = async () => {
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    const button = await screen.findByRole("button", { name: /notifications/i });
    return button;
  };

  const open = async () => {
    const button = await screen.findByRole("button", { name: /notifications/i });
    fireEvent.click(button);
  };

  it("opens a live stream rather than polling", async () => {
    await renderBell();
    // The stream is what makes an alert arrive without a refresh; without it the bell
    // is only as current as the last time the page loaded.
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    expect(FakeEventSource.instances[0].url).toContain("/api/v1/notifications/stream");
  });

  it("carries the token, because EventSource cannot send an Authorization header", async () => {
    await renderBell();
    expect(FakeEventSource.instances[0].url).toContain("access_token=test-token");
  });

  it("does not open a stream when nobody is signed in", async () => {
    localStorage.clear();
    await renderBell();
    // Opening one would only produce a 401 in a loop.
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("shows an alert pushed over the stream without a reload", async () => {
    await renderBell();
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].emit("notification", alert());

    await open();
    expect(await screen.findByText("Low stock")).toBeInTheDocument();
    expect(await screen.findByText(/Milk 1L is down to 3/)).toBeInTheDocument();
  });

  it("counts a pushed alert as unread", async () => {
    await renderBell();
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].emit("notification", alert());

    // The badge count is the whole point of the bell: an unread alert nobody can count
    // is an alert nobody acts on.
    expect(await screen.findByRole("button", { name: /1 unread/i })).toBeInTheDocument();
  });

  it("does not double count an alert redelivered after a reconnect", async () => {
    await renderBell();
    const source = FakeEventSource.instances[0];
    source.onopen?.();
    source.emit("notification", alert());
    source.emit("notification", alert());

    // A stream can redeliver what it already sent. Counting it twice would show a
    // badge claiming two alerts where there is one.
    await screen.findByRole("button", { name: /1 unread/i });
    expect(screen.queryByRole("button", { name: /2 unread/i })).not.toBeInTheDocument();
  });

  it("trusts the server's unread count on reconnect", async () => {
    mockedApi.get.mockResolvedValue({ data: { data: [], meta: { unread: 7 } } } as never);
    await renderBell();
    await screen.findByRole("button", { name: /7 unread/i });

    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].emit("sync", { unread: 4 });

    // A reconnecting tab would otherwise keep a stale badge from before it dropped.
    expect(await screen.findByRole("button", { name: /4 unread/i })).toBeInTheDocument();
  });

  it("shows the empty state when nothing has happened", async () => {
    await renderBell();
    await open();
    expect(await screen.findByText(/you're all caught up/i)).toBeInTheDocument();
  });
});
