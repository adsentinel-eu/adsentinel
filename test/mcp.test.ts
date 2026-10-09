import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApi, type Fetch } from "../src/api.ts";
import { runMcp, waitBudgetMs } from "../src/mcp.ts";
import { bundledTools } from "../src/tools.ts";
import { fakeFetch, json, JOB, RESULT_TEXT, running, text } from "./fake-fetch.ts";

async function connect(fetch: Fetch, clientName: string, env: Record<string, string> = {}) {
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "adsentinel-mcp/0.1.0", schemaVersion: "latest", fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await runMcp({ api, version: "0.1.0", env, tools: bundledTools(), tickMs: 20 }, a);
  const client = new Client({ name: clientName, version: "1" });
  await client.connect(b);
  return client;
}

test("the server's instructions guide agents on next lines and French ad gender", async () => {
  const client = await connect(fakeFetch([]).fetch, "cursor");
  const instructions = client.getInstructions();
  assert.equal(instructions, `Follow the \`next\` line each response starts with: it says what to call or tell your user. When you write in French, "ad" is feminine: une ad, les ads, cette ad. When you show ads to your user, link each ad id to its Ad Library page: the header's \`permalink\` with \`<id>\` replaced by the ad's id (\`permalinkExample\` shows one).`);
  await client.close();
});

test("tools/list returns the definitions with the large-result declaration", async () => {
  const client = await connect(fakeFetch([]).fetch, "cursor");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), bundledTools().map((t) => t.name));
  assert.equal(tools.find((t) => t.name === "get_job")!._meta?.["anthropic/maxResultSizeChars"], 400_000);
  await client.close();
});

test("a call answers the API's agent text untouched, asked for with Accept: text/plain and the latest schema", async () => {
  const { fetch, seen } = fakeFetch([() => text(200, RESULT_TEXT)]);
  const client = await connect(fetch, "cursor");
  const r = await client.callTool({ name: "get_job", arguments: { jobId: JOB } });
  assert.deepEqual(r.content, [{ type: "text", text: RESULT_TEXT }]);
  assert.equal(r.isError, undefined);
  assert.equal(seen[0]!.headers.accept, "text/plain");
  assert.equal(seen[0]!.headers["adsentinel-schema-version"], "latest");
  await client.close();
});

test("an API error is a tool error carrying the API's own body, next included", async () => {
  const err = { error: { code: "approval_required", message: "costs up to €32.00", next: "Nothing was crawled or charged. Ask your user whether to spend up to €32.00.", costEur: 32 } };
  const client = await connect(fakeFetch([() => json(402, err)]).fetch, "cursor");
  const r = await client.callTool({ name: "get_advertiser_ads", arguments: { advertiserIds: ["1"], maxAds: "all" } });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse((r.content as Array<{ text: string }>)[0]!.text), err);
  await client.close();
});

test("outside Claude Code a running job comes back as its handle at once: the agent calls get_job", async () => {
  const { fetch, seen } = fakeFetch([() => text(202, JSON.stringify(running()))]);
  const client = await connect(fetch, "cursor");
  const r = await client.callTool({ name: "get_keyword_ads", arguments: { keyword: "sneakers" } });
  assert.match((r.content as Array<{ text: string }>)[0]!.text, /"status":"running"/);
  assert.equal(seen.length, 1);
  await client.close();
});

test("under Claude Code the job is waited out in the one call, with progress", async () => {
  let n = 0;
  const { fetch, seen } = fakeFetch([
    (r) => (r.method === "POST" ? text(202, JSON.stringify(running())) : undefined),
    () => new Promise((ok) => setTimeout(() => ok(++n < 2 ? text(200, JSON.stringify(running(40))) : text(200, RESULT_TEXT)), 50)),
  ]);
  const client = await connect(fetch, "claude-code");
  const progress: string[] = [];
  const r = await client.callTool({ name: "get_keyword_ads", arguments: { keyword: "sneakers", mode: "extra-compact" } }, undefined, { onprogress: (p) => progress.push(p.message ?? "") });
  assert.equal((r.content as Array<{ text: string }>)[0]!.text, RESULT_TEXT);
  assert.deepEqual(seen.map((s) => s.method), ["POST", "GET", "GET"]);
  assert.equal(seen[1]!.url.searchParams.get("mode"), "extra-compact");
  assert.ok(progress.length >= 2 && progress.every((m) => m.startsWith("Still running")), JSON.stringify(progress));
  await client.close();
});

test("the wait budget is 25 minutes by default; ADSENTINEL_MCP_WAIT_MINUTES can lower it, and 25 is the cap", () => {
  assert.equal(waitBudgetMs({}), 25 * 60_000);
  assert.equal(waitBudgetMs({ ADSENTINEL_MCP_WAIT_MINUTES: "25" }), 25 * 60_000);
  assert.equal(waitBudgetMs({ ADSENTINEL_MCP_WAIT_MINUTES: "90" }), 25 * 60_000);
  assert.equal(waitBudgetMs({ ADSENTINEL_MCP_WAIT_MINUTES: "soon" }), 25 * 60_000);
});

test("under Claude Code an explicit waitSeconds is honoured: the handle comes back after one request", async () => {
  const { fetch, seen } = fakeFetch([() => text(202, JSON.stringify(running()))]);
  const client = await connect(fetch, "claude-code");
  const r = await client.callTool({ name: "get_keyword_ads", arguments: { keyword: "sneakers", waitSeconds: 0 } });
  assert.match((r.content as Array<{ text: string }>)[0]!.text, /"status":"running"/);
  assert.equal(seen.length, 1);
  await client.close();
});

test("progress values strictly increase, even when ticks come faster than a second", async () => {
  let n = 0;
  const { fetch } = fakeFetch([
    (r) => (r.method === "POST" ? text(202, JSON.stringify(running())) : undefined),
    () => new Promise((ok) => setTimeout(() => ok(++n < 2 ? text(200, JSON.stringify(running(1))) : text(200, RESULT_TEXT)), 150)),
  ]);
  const client = await connect(fetch, "claude-code");
  const values: number[] = [];
  await client.callTool({ name: "get_keyword_ads", arguments: { keyword: "x" } }, undefined, { onprogress: (p) => values.push(p.progress) });
  assert.ok(values.length >= 4, JSON.stringify(values));
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]!), JSON.stringify(values));
  await client.close();
});
