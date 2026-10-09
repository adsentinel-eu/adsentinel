/** One tool call, one HTTP request (surface v1 § Verbs). The CLI and the MCP server both go through here, so the
 *  two never drift. Arguments pass through as the API names them: the API validates them and says what is wrong. */
import { ApiError, type Api, type ApiResponse } from "./api.ts";

export const TOOL_NAMES = ["find_advertiser", "get_advertiser_ads", "get_keyword_ads", "get_job", "cancel_job", "refresh_ads", "get_account"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type Args = Record<string, unknown>;

export interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Args;
}

const invalid = (message: string) =>
  new ApiError("invalid_argument", message, "Fix the arguments and call again.", 400);

function jobId(args: Args): string {
  const id = args.jobId;
  if (typeof id !== "string" || !id) throw invalid("jobId is required");
  return encodeURIComponent(id);
}

/** Reading parameters as `GET /v1/jobs/{id}` takes them: `waitSeconds` is spelled `wait` in a query. */
export function readingQuery(args: Args): Record<string, string | number | boolean | undefined> {
  const pick = (k: string) => (args[k] === undefined || args[k] === null ? undefined : (args[k] as string | number | boolean));
  return { cursor: pick("cursor"), mode: pick("mode"), projection: pick("projection"), inlineTokens: pick("inlineTokens"), wait: pick("waitSeconds") };
}

export function requestFor(tool: string, args: Args): HttpRequest {
  switch (tool) {
    case "find_advertiser":
      return { method: "GET", path: "/v1/advertisers", query: { q: args.query as string | undefined, country: args.country as string | undefined } };
    case "get_advertiser_ads":
      return { method: "POST", path: "/v1/jobs", body: { kind: "advertiser", ...args } };
    case "get_keyword_ads":
      return { method: "POST", path: "/v1/jobs", body: { kind: "keyword", ...args } };
    case "refresh_ads":
      return { method: "POST", path: "/v1/jobs", body: { kind: "refresh", ...args } };
    case "get_job":
      return { method: "GET", path: `/v1/jobs/${jobId(args)}`, query: readingQuery(args) };
    case "cancel_job":
      return { method: "POST", path: `/v1/jobs/${jobId(args)}/cancel` };
    case "get_account":
      return { method: "GET", path: "/v1/account" };
    default:
      throw invalid(`unknown tool ${tool}; the tools are ${TOOL_NAMES.join(", ")}`);
  }
}

export function callTool(api: Api, tool: string, args: Args, o: { accept: "text" | "json"; signal?: AbortSignal }): Promise<ApiResponse> {
  const r = requestFor(tool, args);
  return api.call(r.method, r.path, { accept: o.accept, ...(r.query ? { query: r.query } : {}), ...(r.body ? { body: r.body } : {}), ...(o.signal ? { signal: o.signal } : {}) });
}

/** A job that has not finished, as the API answers it (#10 § 2): counts only, never an ad. */
export interface Handle {
  next: string;
  jobId: string;
  status: "queued" | "running";
  etaSeconds?: number;
  progress?: { pagesCrawled?: number; adsFound?: number };
}

/** The handle in an answer, or null when the answer is a result, an error or anything else. */
export function handleOf(text: string): Handle | null {
  if (!text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text) as Partial<Handle>;
    return typeof v.jobId === "string" && (v.status === "queued" || v.status === "running") ? (v as Handle) : null;
  } catch {
    return null;
  }
}

/** The answer for a job that ended without a result: HTTP 200 and a handle-shaped body (`failed` or `cancelled`),
 *  or null for anything else. */
export interface FailedJob {
  next: string;
  jobId: string;
  status: "failed" | "cancelled";
  errorCode?: string;
  retryable?: boolean;
}

export function failedJobOf(text: string): FailedJob | null {
  if (!text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text) as Partial<FailedJob>;
    return typeof v.jobId === "string" && (v.status === "failed" || v.status === "cancelled") ? (v as FailedJob) : null;
  } catch {
    return null;
  }
}
