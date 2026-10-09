/** The HTTP API v1, the one thing this package talks to (surface v1 § Layers). No logic the API lacks: a call is a
 *  request and its answer; errors keep the API's one shape `{ error: { code, message, next } }`. */

export const DEFAULT_BASE_URL = "https://api.adsentinel.eu";
export const DEFAULT_SITE_URL = "https://adsentinel.eu";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  baseUrl: string;
  /** null sends no Authorization header: the API answers `no_api_key` with its own `next`. A function is asked on every
   *  call, so a long-lived process (the MCP server) uses a key stored after it started. */
  key: string | null | (() => string | null);
  userAgent: string;
  /** Sent as `AdSentinel-Schema-Version` when set ("latest" for the MCP server, surface v1 § Schema versioning). */
  schemaVersion?: string;
  fetch?: Fetch;
}

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** "text" asks for the agent text (`Accept: text/plain`); "json" for the JSON envelope. */
  accept: "text" | "json";
  signal?: AbortSignal;
}

export interface ApiResponse {
  status: number;
  /** The body as sent. */
  text: string;
  headers: Headers;
}

/** An error answer from the API, or `unreachable` when no answer came. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The API's own error shape, for printing or for an MCP error result. */
  body(): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, next: this.next, ...this.extra } };
  }
}

export interface Api {
  readonly baseUrl: string;
  call(method: "GET" | "POST", path: string, o: CallOptions): Promise<ApiResponse>;
}

function errorFrom(status: number, text: string): ApiError {
  try {
    const parsed = JSON.parse(text) as { error?: Record<string, unknown> };
    const e = parsed.error;
    if (e && typeof e.code === "string") {
      const { code, message, next, ...extra } = e;
      return new ApiError(code, String(message ?? code), String(next ?? ""), status, extra);
    }
  } catch {
    /* not the API's shape: fall through */
  }
  return new ApiError("internal", `HTTP ${status}: ${text.slice(0, 200)}`, "Try again in a minute; if it persists, check https://adsentinel.eu/status.", status);
}

export function createApi(o: ApiOptions): Api {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const doFetch: Fetch = o.fetch ?? ((input, init) => fetch(input, init));
  return {
    baseUrl,
    async call(method, path, c) {
      const key = typeof o.key === "function" ? o.key() : o.key;
      if (key && /[\s\x00-\x1f]/.test(key)) {
        throw new ApiError("invalid_api_key", "the API key has spaces or line breaks inside it", "Copy the key again as one word, then set ADSENTINEL_API_KEY or run `adsentinel login --key <key>`.", 401);
      }
      const url = new URL(baseUrl + path);
      for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = {
        accept: c.accept === "text" ? "text/plain" : "application/json",
        "user-agent": o.userAgent,
      };
      if (key) headers.authorization = `Bearer ${key}`;
      if (o.schemaVersion) headers["adsentinel-schema-version"] = o.schemaVersion;
      const init: RequestInit = { method, headers };
      if (c.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(c.body);
      }
      if (c.signal) init.signal = c.signal;
      let res: Response;
      let text: string;
      try {
        res = await doFetch(url.toString(), init);
        text = await res.text(); // a connection that dies mid-body is as unreachable as one that never answered
      } catch (err) {
        if (c.signal?.aborted) throw err;
        throw new ApiError("unreachable", `no answer from ${baseUrl}: ${(err as Error).message}`, `Check the connection, then try again. The API's state is at ${baseUrl}/status.`, 0);
      }
      if (!res.ok) throw errorFrom(res.status, text);
      return { status: res.status, text, headers: res.headers };
    },
  };
}
