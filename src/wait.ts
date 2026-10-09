/** Waiting out a job: call `get_job` with `wait=50` until the job ends or the budget runs out (surface v1 § Layers:
 *  the one transport exception, never a long HTTP hold). Progress is reported every `tickMs` while a call is in
 *  flight. A hang-up stops the waiting, never the job. */
import { ApiError, type Api, type ApiResponse } from "./api.ts";
import { callTool, handleOf, type Args, type Handle } from "./calls.ts";

export interface WaitOptions {
  accept: "text" | "json";
  /** The reading parameters to read the result with: `mode`, `projection`, `inlineTokens`. */
  reading: Args;
  /** Stop waiting after this long and return the latest handle (its `next` names `get_job`). Infinity: until done. */
  budgetMs: number;
  onProgress?: (h: Handle, elapsedMs: number) => void;
  tickMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** When the budget started (`now()` scale); default: when waiting starts. The MCP server passes the start of the
   *  tool call, so the first request's hold counts. */
  startedAt?: number;
  /** The pause before a retry (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** The API holds a call at most 50 s (`MAX_WAIT_SECONDS`). */
export const HOLD_SECONDS = 50;

/** Errors worth another try mid-wait; anything else (job_not_found, auth...) is final. */
const TRANSIENT = new Set(["unreachable", "internal", "rate_limited"]);
const MAX_FAILURES = 3;
const BACKOFF_SECONDS = [2, 5, 10];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to pause after the `n`th consecutive failure: the API's `retryAfter` when it gave one. */
function pauseMs(err: ApiError, n: number): number {
  const after = err.extra.retryAfter;
  return (err.code === "rate_limited" ? (typeof after === "number" && after >= 0 ? after : 2) : BACKOFF_SECONDS[n - 1] ?? 10) * 1000;
}

/** The same error, saying the job is safe: a failed read never means the job was lost. */
function withJobHint(err: ApiError, jobId: string): ApiError {
  return new ApiError(err.code, err.message,
    `${err.next} The job ${jobId} is still running and nothing is lost: read it with get_job (jobId "${jobId}"); do not submit it again.`,
    err.status, { ...err.extra, jobId });
}

export async function waitForResult(api: Api, first: ApiResponse, o: WaitOptions): Promise<ApiResponse> {
  const now = o.now ?? Date.now;
  const started = o.startedAt ?? now();
  const sleep = o.sleep ?? realSleep;
  let failures = 0; // consecutive transient failures; a success resets it
  let res = first;
  let handle = handleOf(res.text);
  const tickMs = o.tickMs ?? 20_000;
  while (handle) {
    const left = o.budgetMs - (now() - started);
    if (left < 1000 || o.signal?.aborted) break;
    const current: Handle = handle;
    o.onProgress?.(current, now() - started);
    const ticker = setInterval(() => o.onProgress?.(current, now() - started), tickMs);
    try {
      const wait = Math.max(1, Math.min(HOLD_SECONDS, Math.floor(left / 1000)));
      res = await callTool(api, "get_job", { ...o.reading, jobId: current.jobId, waitSeconds: wait }, { accept: o.accept, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      failures++;
      if (!TRANSIENT.has(err.code) || failures > MAX_FAILURES || o.signal?.aborted) throw withJobHint(err, current.jobId);
      await sleep(pauseMs(err, failures)); // then the loop re-checks the budget and reads again
      continue;
    } finally {
      clearInterval(ticker);
    }
    failures = 0;
    handle = handleOf(res.text);
  }
  return res;
}
