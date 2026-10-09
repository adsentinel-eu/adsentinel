import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import { failedJobOf, handleOf, requestFor } from "../src/calls.ts";
import { JOB, RESULT_TEXT, running } from "./fake-fetch.ts";

test("each tool is one request, arguments passed through as the API names them", () => {
  assert.deepEqual(requestFor("find_advertiser", { query: "IKEA", country: "BE" }), { method: "GET", path: "/v1/advertisers", query: { q: "IKEA", country: "BE" } });
  assert.deepEqual(requestFor("get_advertiser_ads", { advertiserIds: ["1"], maxAds: "all" }), { method: "POST", path: "/v1/jobs", body: { kind: "advertiser", advertiserIds: ["1"], maxAds: "all" } });
  assert.deepEqual(requestFor("get_keyword_ads", { keyword: "x" }).body, { kind: "keyword", keyword: "x" });
  assert.deepEqual(requestFor("refresh_ads", { fromJobId: JOB }).body, { kind: "refresh", fromJobId: JOB });
  assert.deepEqual(requestFor("get_job", { jobId: JOB, waitSeconds: 0, mode: "full", cursor: "c1" }), { method: "GET", path: `/v1/jobs/${JOB}`, query: { cursor: "c1", mode: "full", projection: undefined, inlineTokens: undefined, wait: 0 } });
  assert.deepEqual(requestFor("cancel_job", { jobId: JOB }), { method: "POST", path: `/v1/jobs/${JOB}/cancel` });
  assert.deepEqual(requestFor("get_account", {}), { method: "GET", path: "/v1/account" });
});

test("a job id is required and escaped into the path; an unknown tool is invalid_argument", () => {
  assert.throws(() => requestFor("get_job", {}), (e: ApiError) => e.code === "invalid_argument");
  assert.equal(requestFor("cancel_job", { jobId: "../account" }).path, "/v1/jobs/..%2Faccount/cancel");
  assert.throws(() => requestFor("get_ads", {}), (e: ApiError) => e.code === "invalid_argument" && /find_advertiser/.test(e.message));
});

test("a handle is a queued or running job; a result, a finished handle or text is not", () => {
  assert.equal(handleOf(JSON.stringify(running()))?.jobId, JOB);
  assert.equal(handleOf(JSON.stringify({ ...running(), status: "queued" }))?.status, "queued");
  assert.equal(handleOf(JSON.stringify({ ...running(), status: "failed" })), null);
  assert.equal(handleOf(RESULT_TEXT), null);
  assert.equal(handleOf("PARTIAL RESULT"), null);
});

test("a failed or cancelled job is a terminal answer without a result; anything else is not", () => {
  const ended = { next: "The job failed.", jobId: JOB, kind: "discover", status: "failed", errorCode: "meta_unavailable", retryable: true, chargedEur: 0 };
  assert.equal(failedJobOf(JSON.stringify(ended))?.status, "failed");
  assert.equal(failedJobOf(JSON.stringify({ ...ended, status: "cancelled" }))?.jobId, JOB);
  assert.equal(failedJobOf(JSON.stringify(running())), null);
  assert.equal(failedJobOf(RESULT_TEXT), null);
  assert.equal(failedJobOf("not json"), null);
});
