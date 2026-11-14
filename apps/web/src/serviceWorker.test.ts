import fs from "fs";
import path from "path";
import vm from "vm";

/**
 * The service worker is plain script, not a module, so it is loaded into a sandbox
 * rather than imported. These tests cover the one failure that matters: a fetch handler
 * must always resolve to a Response. Resolving to `undefined` makes the browser throw
 * "Failed to convert value to 'Response'" and every request on the page fails, which is
 * how a worker takes a whole site offline.
 */

class FakeResponse {
  static error() {
    return new FakeResponse("", { status: 0, type: "error" });
  }

  readonly status: number;
  readonly type: string;
  readonly body: string;

  constructor(body = "", init: { status?: number; type?: string } = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? "default";
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  clone() {
    return new FakeResponse(this.body, { status: this.status, type: this.type });
  }
}

type Listener = (event: { request: unknown; respondWith: (p: unknown) => void }) => void;

interface Sandbox {
  listeners: Record<string, Listener>;
  cache: Map<string, unknown>;
  respondsWith: (request: unknown) => Promise<unknown>;
}

function loadWorker(options: { cached?: string[]; networkFails?: boolean } = {}): Sandbox {
  const listeners: Record<string, Listener> = {};
  const cache = new Map<string, unknown>();
  for (const url of options.cached ?? []) cache.set(url, new FakeResponse());

  const store = {
    add: async (url: string) => {
      cache.set(url, new FakeResponse());
    },
    put: async (request: unknown, response: unknown) => {
      cache.set(typeof request === "string" ? request : (request as { url: string }).url, response);
    },
  };

  const caches = {
    open: async () => store,
    match: async (request: unknown) => {
      const key = typeof request === "string" ? request : (request as { url: string }).url;
      const hit = cache.get(key);
      return hit ? (hit as FakeResponse).clone() : undefined;
    },
    keys: async () => [...cache.keys()],
    delete: async (key: string) => cache.delete(key),
  };

  const fetch = async () => {
    if (options.networkFails !== false) throw new TypeError("Failed to fetch");
    return new FakeResponse("ok", { status: 200, type: "basic" });
  };

  const self = {
    location: { origin: "https://kazios.pages.dev" },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
  };

  const source = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
  // The worker is a classic script that reads these as globals. runInNewContext gives it a
  // real global object, which is what a classic script expects; `new Function` would only
  // see the names passed as parameters and no global scope at all.
  vm.runInNewContext(source, {
    self,
    caches,
    fetch,
    Response: FakeResponse,
    URL,
    Promise,
    JSON,
  });

  return {
    listeners,
    cache,
    respondsWith: request =>
      new Promise(resolve => {
        listeners.fetch({ request, respondWith: resolve });
      }),
  };
}

function request(
  url: string,
  { method = "GET", mode = "no-cors" }: { method?: string; mode?: string } = {}
) {
  return { url, method, mode, destination: "" };
}

describe("service worker fetch handler", () => {
  it("answers a navigation when nothing is cached and the network is down", async () => {
    const worker = loadWorker();
    const response = await worker.respondsWith(
      request("https://kazios.pages.dev/login", { mode: "navigate" })
    );

    expect(response).toBeInstanceOf(FakeResponse);
    expect((response as FakeResponse).status).toBe(503);
  });

  it("falls back to the cached shell for a navigation that is not cached", async () => {
    const worker = loadWorker({ cached: ["/"] });
    const response = await worker.respondsWith(
      request("https://kazios.pages.dev/pos", { mode: "navigate" })
    );

    expect(response).toBeInstanceOf(FakeResponse);
    expect((response as FakeResponse).status).toBe(200);
  });

  it("answers an uncached asset instead of resolving to undefined", async () => {
    const worker = loadWorker();
    const response = await worker.respondsWith(request("https://kazios.pages.dev/assets/index.js"));

    expect(response).toBeInstanceOf(FakeResponse);
  });

  it("answers an uncached image instead of resolving to undefined", async () => {
    const worker = loadWorker();
    const response = await worker.respondsWith(request("https://kazios.pages.dev/logo.png"));

    expect(response).toBeInstanceOf(FakeResponse);
  });

  it("answers an API request with a 503 the caller can handle", async () => {
    const worker = loadWorker();
    const response = await worker.respondsWith(
      request("https://kazios.onrender.com/api/v1/auth/me")
    );

    expect(response).toBeInstanceOf(FakeResponse);
    expect((response as FakeResponse).status).toBe(503);
  });

  it("leaves a POST to the browser rather than intercepting it", async () => {
    const worker = loadWorker();
    let intercepted = false;
    worker.listeners.fetch({
      request: request("https://kazios.onrender.com/api/v1/auth/login", { method: "POST" }),
      respondWith: () => {
        intercepted = true;
      },
    });

    expect(intercepted).toBe(false);
  });
});
