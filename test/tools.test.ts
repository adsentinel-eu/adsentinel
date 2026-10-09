import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApi } from "../src/api.ts";
import { bundledTools, loadTools, MAX_RESULT_CHARS } from "../src/tools.ts";
import { fakeFetch, json } from "./fake-fetch.ts";

const api = (fetch: Parameters<typeof createApi>[0]["fetch"]) => createApi({ baseUrl: "http://api.test", key: null, userAgent: "t", ...(fetch ? { fetch } : {}) });

test("the tools that return ads declare a result size above inlineTokens' 100k maximum; the others don't", () => {
  const byName = Object.fromEntries(bundledTools().map((t) => [t.name, t]));
  for (const n of ["get_advertiser_ads", "get_keyword_ads", "get_job", "refresh_ads"]) assert.equal(byName[n]!._meta?.["anthropic/maxResultSizeChars"], MAX_RESULT_CHARS, n);
  for (const n of ["find_advertiser", "cancel_job", "get_account"]) assert.equal(byName[n]!._meta, undefined, n);
  assert.equal(Object.keys(byName).length, 7);
});

test("definitions come from GET /v1/mcp/tools when it answers a tool list", async () => {
  const served = [{ name: "get_job", description: "new wording", inputSchema: { type: "object" } }];
  const { fetch, seen } = fakeFetch([() => json(200, served)]);
  const r = await loadTools(api(fetch));
  assert.equal(r.source, "api");
  assert.equal(r.tools[0]!.description, "new wording");
  assert.equal(r.tools[0]!._meta?.["anthropic/maxResultSizeChars"], MAX_RESULT_CHARS);
  assert.equal(seen[0]!.url.pathname, "/v1/mcp/tools");
});

test("the bundled copy answers when the API is down, slow, failing or serves something that isn't a tool list", async () => {
  const cases = [
    async () => { throw new TypeError("fetch failed"); },
    (_: string, init: RequestInit) => new Promise<Response>((_ok, fail) => init.signal?.addEventListener("abort", () => fail(init.signal!.reason))), // slow: honours the timeout's abort, as fetch does
    async () => json(500, { error: { code: "internal", message: "x", next: "y" } }),
    async () => json(200, { tools: [] }),
    async () => json(200, []),
  ];
  for (const f of cases) {
    const r = await loadTools(api(f), 50);
    assert.equal(r.source, "bundled");
    assert.equal(r.tools.length, 7);
  }
});
