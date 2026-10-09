import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../src/api.ts";
import { waitForResult } from "../src/wait.ts";
import { fakeFetch, json, JOB, RESULT_TEXT, running, text } from "./fake-fetch.ts";

const first = { status: 202, text: JSON.stringify(running()), headers: new Headers() };

test("a running job is read with get_job and wait=50 until it ends, with the caller's reading parameters", async () => {
  let calls = 0;
  const { fetch, seen } = fakeFetch([() => (++calls < 3 ? text(200, JSON.stringify(running(calls * 10))) : text(200, RESULT_TEXT))]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const progress: number[] = [];
  const res = await waitForResult(api, first, { accept: "text", reading: { mode: "extra-compact" }, budgetMs: Infinity, onProgress: (h) => progress.push(h.progress?.adsFound ?? -1) });
  assert.equal(res.text, RESULT_TEXT);
  assert.equal(seen.length, 3);
  for (const r of seen) {
    assert.equal(r.url.pathname, `/v1/jobs/${JOB}`);
    assert.equal(r.url.searchParams.get("wait"), "50");
    assert.equal(r.url.searchParams.get("mode"), "extra-compact");
  }
  assert.deepEqual(progress, [0, 10, 20]); // once per call, before it
});

test("an answer that is not a handle is returned as it is, with no call", async () => {
  const { fetch, seen } = fakeFetch([]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const done = { status: 200, text: RESULT_TEXT, headers: new Headers() };
  assert.equal(await waitForResult(api, done, { accept: "text", reading: {}, budgetMs: 1000 }), done);
  assert.equal(seen.length, 0);
});

test("the budget ends the waiting: the last handle comes back (its next names get_job), the last wait is cut to what is left", { timeout: 5000 }, async () => {
  let t = 0;
  const { fetch, seen } = fakeFetch([() => { t += 50_000; return text(200, JSON.stringify(running(5))); }]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const res = await waitForResult(api, first, { accept: "text", reading: {}, budgetMs: 70_000, now: () => t });
  assert.match(res.text, /Call get_job with jobId/);
  assert.deepEqual(seen.map((r) => r.url.searchParams.get("wait")), ["50", "20"]);
});

test("while a call is held, progress repeats every tick", async () => {
  const { fetch } = fakeFetch([() => new Promise((ok) => setTimeout(() => ok(text(200, RESULT_TEXT)), 120))]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  let ticks = 0;
  await waitForResult(api, first, { accept: "text", reading: {}, budgetMs: Infinity, tickMs: 25, onProgress: () => ticks++ });
  assert.ok(ticks >= 3, `${ticks} ticks`);
});

const noSleep = async () => undefined;
const api500 = () => json(500, { error: { code: "internal", message: "boom", next: "Try again." } });

test("a transient error mid-wait is retried after a pause and the wait goes on", async () => {
  let n = 0;
  const { fetch, seen } = fakeFetch([() => (++n === 1 ? Promise.reject(new TypeError("fetch failed")) : text(200, RESULT_TEXT))]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const pauses: number[] = [];
  const res = await waitForResult(api, first, { accept: "text", reading: {}, budgetMs: Infinity, sleep: async (ms) => { pauses.push(ms); } });
  assert.equal(res.text, RESULT_TEXT);
  assert.equal(seen.length, 2);
  assert.deepEqual(pauses, [2000]);
});

test("a rate_limited pause is the API's retryAfter; a success resets the failure count", async () => {
  const limited = () => json(429, { error: { code: "rate_limited", message: "slow", next: "Wait.", retryAfter: 7 } });
  let n = 0;
  const { fetch } = fakeFetch([() => { n++; return n === 1 || n === 3 || n === 5 || n === 7 ? limited() : n === 8 ? text(200, RESULT_TEXT) : text(200, JSON.stringify(running())); }]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const pauses: number[] = [];
  const res = await waitForResult(api, first, { accept: "text", reading: {}, budgetMs: Infinity, sleep: async (ms) => { pauses.push(ms); } });
  assert.equal(res.text, RESULT_TEXT); // four failures in all, never more than one in a row
  assert.deepEqual(pauses, [7000, 7000, 7000, 7000]);
});

test("four failures in a row end the wait with the same error, carrying the jobId and a next that says nothing is lost", async () => {
  const { fetch, seen } = fakeFetch([api500]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  const pauses: number[] = [];
  await assert.rejects(waitForResult(api, first, { accept: "text", reading: {}, budgetMs: Infinity, sleep: async (ms) => { pauses.push(ms); } }), (e: ApiError) => {
    assert.equal(e.code, "internal");
    assert.equal(e.status, 500);
    assert.match(e.next, /^Try again\. The job .* is still running and nothing is lost: read it with get_job \(jobId "6f1c1b0a[^"]*"\); do not submit it again\.$/);
    assert.equal((e.body().error as { jobId: string }).jobId, JOB);
    return true;
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(pauses, [2000, 5000, 10000]);
});

test("any other error mid-wait is not retried and carries the jobId hint too", async () => {
  const { fetch, seen } = fakeFetch([() => json(404, { error: { code: "job_not_found", message: "no such job", next: "Check the id." } })]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  await assert.rejects(waitForResult(api, first, { accept: "text", reading: {}, budgetMs: Infinity, sleep: noSleep }), (e: ApiError) => e.code === "job_not_found" && /do not submit it again/.test(e.next) && e.extra.jobId === JOB);
  assert.equal(seen.length, 1);
});

test("the budget counts from startedAt: time already spent shortens the wait", async () => {
  let t = 60_000; // 60 s of the 70 s budget went before the wait began
  const { fetch, seen } = fakeFetch([() => { t += 10_000; return text(200, JSON.stringify(running())); }]);
  const api = createApi({ baseUrl: "http://api.test", key: "k", userAgent: "t", fetch });
  await waitForResult(api, first, { accept: "text", reading: {}, budgetMs: 70_000, startedAt: 0, now: () => t, sleep: noSleep });
  assert.deepEqual(seen.map((r) => r.url.searchParams.get("wait")), ["10"]); // 70 s budget, 60 s spent: 10 s left, the call uses them, the budget is spent
});
