/** The stdio MCP server (`npx -y adsentinel mcp`). Tools come from the API with the bundled copy as the fallback;
 *  a call is one request through calls.ts and the answer is the API's agent text, untouched. Under Claude Code
 *  (`clientInfo.name`) a job is waited out in one tool call, with progress (surface v1 § Layers). */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type Api } from "./api.ts";
import { callTool, handleOf, type Args } from "./calls.ts";
import { loadTools, type ToolDef } from "./tools.ts";
import { waitForResult } from "./wait.ts";

/** Tools whose answer can be a running job. */
const JOB_TOOLS = new Set(["get_advertiser_ads", "get_keyword_ads", "refresh_ads", "get_job"]);
const CLAUDE_CODE = "claude-code";

export const INSTRUCTIONS = `Follow the \`next\` line each response starts with: it says what to call or tell your user. When you write in French, "ad" is feminine: une ad, les ads, cette ad. When you show ads to your user, link each ad id to its Ad Library page: the header's \`permalink\` with \`<id>\` replaced by the ad's id (\`permalinkExample\` shows one).`;

/** Claude Code keeps a call alive while progress flows (checked 2026-10-07: one call stayed open 14 min 38 s),
 *  so the wait defaults to the spec's cap of 25. ADSENTINEL_MCP_WAIT_MINUTES lowers it for a host with a shorter timeout. */
export const DEFAULT_WAIT_MINUTES = 25;
export const MAX_WAIT_MINUTES = 25;

export function waitBudgetMs(env: Record<string, string | undefined>): number {
  const asked = Number(env.ADSENTINEL_MCP_WAIT_MINUTES);
  const minutes = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_WAIT_MINUTES) : DEFAULT_WAIT_MINUTES;
  return minutes * 60_000;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export interface McpOptions {
  api: Api;
  version: string;
  env: Record<string, string | undefined>;
  /** Fixed definitions (tests); otherwise loaded from the API at start-up. */
  tools?: ToolDef[];
  tickMs?: number;
}

export async function createMcpServer(o: McpOptions): Promise<Server> {
  const tools = o.tools ?? (await loadTools(o.api)).tools;
  const names = new Set(tools.map((t) => t.name));
  const server = new Server({ name: "adsentinel", version: o.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Args;
    if (!names.has(name)) return text(JSON.stringify(new ApiError("invalid_argument", `unknown tool ${name}`, `Call one of: ${[...names].join(", ")}.`, 400).body()), true);
    const startedAt = Date.now(); // the budget counts the first request's hold too
    try {
      let res = await callTool(o.api, name, args, { accept: "text", signal: extra.signal });
      if (JOB_TOOLS.has(name) && handleOf(res.text) && args.waitSeconds === undefined && server.getClientVersion()?.name === CLAUDE_CODE) {
        const token = req.params._meta?.progressToken;
        let last = 0; // progress must increase with every notification
        res = await waitForResult(o.api, res, {
          accept: "text",
          reading: { mode: args.mode, projection: args.projection, inlineTokens: args.inlineTokens },
          budgetMs: waitBudgetMs(o.env),
          startedAt,
          signal: extra.signal,
          ...(o.tickMs ? { tickMs: o.tickMs } : {}),
          onProgress: (h, elapsed) => {
            if (token === undefined) return;
            last = Math.max(last + 1, Math.round(elapsed / 1000));
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: last, message: h.next },
            }).catch(() => undefined);
          },
        });
      }
      return text(res.text);
    } catch (err) {
      if (err instanceof ApiError) return text(JSON.stringify(err.body()), true);
      if (extra.signal.aborted) return text(JSON.stringify(new ApiError("cancelled", "the call was cancelled", "The job, if one started, keeps running: read it with get_job.", 0).body()), true);
      throw err;
    }
  });
  return server;
}

export async function runMcp(o: McpOptions, transport: Transport): Promise<Server> {
  const server = await createMcpServer(o);
  await server.connect(transport);
  return server;
}
