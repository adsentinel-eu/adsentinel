import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../src/api.ts";
import { fakeFetch, json } from "./fake-fetch.ts";

test("a call sends the key, the Accept it asks for, the user agent and the schema version; undefined query values are left out", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, { ok: true })]);
  const api = createApi({ baseUrl: "http://api.test/", key: "ak_live_x", userAgent: "adsentinel-cli/0.1.0", schemaVersion: "latest", fetch });
  const res = await api.call("GET", "/v1/advertisers", { accept: "text", query: { q: "H&M", country: undefined } });
  assert.equal(res.status, 200);
  const r = seen[0]!;
  assert.equal(r.url.toString(), "http://api.test/v1/advertisers?q=H%26M");
  assert.deepEqual([r.headers.authorization, r.headers.accept, r.headers["user-agent"], r.headers["adsentinel-schema-version"]], ["Bearer ak_live_x", "text/plain", "adsentinel-cli/0.1.0", "latest"]);
});

test("no key: no Authorization header, so the API answers no_api_key with its own next", async () => {
  const { fetch, seen } = fakeFetch([() => json(401, { error: { code: "no_api_key", message: "no key", next: "Tell your user: create a key" } })]);
  const api = createApi({ baseUrl: "http://api.test", key: null, userAgent: "t", fetch });
  await assert.rejects(api.call("GET", "/v1/account", { accept: "json" }), (e: ApiError) => e.code === "no_api_key" && e.next.startsWith("Tell your user") && e.status === 401);
  assert.equal(seen[0]!.headers.authorization, undefined);
});

test("a key lookup is asked on every call: a key stored after start is used without a restart (the MCP server)", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, { ok: true }), () => json(200, { ok: true })]);
  let stored: string | null = null;
  const api = createApi({ baseUrl: "http://api.test", key: () => stored, userAgent: "t", fetch });
  await api.call("GET", "/v1/account", { accept: "json" });
  stored = "adsk_later";
  await api.call("GET", "/v1/account", { accept: "json" });
  assert.deepEqual(seen.map((r) => r.headers.authorization), [undefined, "Bearer adsk_later"]);
});

test("a POST sends JSON; an error keeps the API's extra fields; a non-API error body becomes internal", async () => {
  const { fetch, seen } = fakeFetch([
    (r) => (r.url.pathname === "/v1/jobs" ? json(402, { error: { code: "approval_required", message: "m", next: "Ask your user", costEur: 12.5 } }) : undefined),
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  ]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  await assert.rejects(api.call("POST", "/v1/jobs", { accept: "text", body: { kind: "keyword", keyword: "x" } }), (e: ApiError) => {
    assert.deepEqual(e.body(), { error: { code: "approval_required", message: "m", next: "Ask your user", costEur: 12.5 } });
    return true;
  });
  assert.equal(seen[0]!.headers["content-type"], "application/json");
  assert.deepEqual(seen[0]!.body, { kind: "keyword", keyword: "x" });
  await assert.rejects(api.call("GET", "/v1/account", { accept: "json" }), (e: ApiError) => e.code === "internal" && e.status === 502);
});

test("no answer at all is `unreachable`, naming the API and its status page", async () => {
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(api.call("GET", "/v1/account", { accept: "json" }), (e: ApiError) => e.code === "unreachable" && /api\.test\/status/.test(e.next));
});

test("a key with spaces or line breaks inside (a bad paste) is invalid_api_key, said plainly, with no request", async () => {
  const { fetch, seen } = fakeFetch([]);
  const api = createApi({ baseUrl: "http://api.test", key: "adsk_abc\nadsk_abc", userAgent: "t", fetch });
  await assert.rejects(api.call("GET", "/v1/account", { accept: "json" }), (e: ApiError) => e.code === "invalid_api_key" && /line break|space/.test(e.message));
  assert.equal(seen.length, 0);
});

test("a connection that dies while the body is being read is `unreachable` too", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new TypeError("terminated")); } });
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch: async () => new Response(body, { status: 200 }) });
  await assert.rejects(api.call("GET", "/v1/jobs/x", { accept: "json" }), (e: ApiError) => e.code === "unreachable" && /terminated/.test(e.message));
});
