/** The tool definitions: the API serves them (`GET /v1/mcp/tools`, surface v1 § Layers), so a price or wording
 *  change reaches every installed client without a release. The bundled copy is the offline fallback. */
import BUNDLED from "./mcp-tools-v1.json" with { type: "json" };
import type { Api } from "./api.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  _meta?: Record<string, unknown>;
}

/** Tools whose results can be large. Claude Code caps tool output at 25k tokens unless the tool declares more
 *  (surface v1 § Output limits); 400k characters covers `inlineTokens`' 100k maximum. */
const LARGE = new Set(["get_advertiser_ads", "get_keyword_ads", "get_job", "refresh_ads"]);
export const MAX_RESULT_CHARS = 400_000;

function isToolList(v: unknown): v is ToolDef[] {
  return Array.isArray(v) && v.length > 0 && v.every((t) => typeof t?.name === "string" && typeof t?.description === "string" && t?.inputSchema?.type === "object");
}

const withMeta = (tools: ToolDef[]): ToolDef[] =>
  tools.map((t) => (LARGE.has(t.name) ? { ...t, _meta: { ...t._meta, "anthropic/maxResultSizeChars": MAX_RESULT_CHARS } } : t));

export const bundledTools = (): ToolDef[] => withMeta(BUNDLED as ToolDef[]);

/** The API's definitions, or the bundled copy when the API is slow, down or answers something else. */
export async function loadTools(api: Api, timeoutMs = 3000): Promise<{ tools: ToolDef[]; source: "api" | "bundled" }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("timed out")), timeoutMs);
  try {
    const res = await api.call("GET", "/v1/mcp/tools", { accept: "json", signal: abort.signal });
    const parsed: unknown = JSON.parse(res.text);
    if (isToolList(parsed)) return { tools: withMeta(parsed), source: "api" };
  } catch {
    /* fall back */
  } finally {
    clearTimeout(timer);
  }
  return { tools: bundledTools(), source: "bundled" };
}
