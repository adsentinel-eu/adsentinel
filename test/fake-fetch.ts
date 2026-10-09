/** A fetch that answers from a list of handlers and records every request. */
import type { Fetch } from "../src/api.ts";

export interface Seen { method: string; url: URL; headers: Record<string, string>; body: unknown }
export type Handler = (req: Seen) => Response | Promise<Response> | undefined;

export function fakeFetch(handlers: Handler[]): { fetch: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f: Fetch = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const req: Seen = { method: init.method ?? "GET", url: new URL(input), headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    seen.push(req);
    for (const h of handlers) {
      const r = await h(req);
      if (r) return r;
    }
    throw new Error(`fake fetch: nothing answers ${req.method} ${req.url}`);
  };
  return { fetch: f, seen };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

export const JOB = "6f1c1b0a-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
export const running = (adsFound = 0) => ({ next: `Still running, about 30s left. Call get_job with jobId "${JOB}".`, jobId: JOB, kind: "discover", status: "running", etaSeconds: 30, progress: { pagesCrawled: 1, adsFound, enrichmentDone: 0, enrichmentOf: 0 } });
export const RESULT_TEXT = `{"next":"Done: the 2 newest ads.","schemaVersion":"1","jobId":"${JOB}","status":"completed"}\n\n\`\`\`csv ads\nid,startedAt\n1,2026-09-01\n2,2026-09-02\n\`\`\``;
