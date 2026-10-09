import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../src/api.ts";
import { EXIT, isInteractive, main } from "../src/cli.ts";
import { readStoredKey } from "../src/config.ts";
import { fakeFetch, json, JOB, RESULT_TEXT, running, text } from "./fake-fetch.ts";

function io(fetch: Fetch, o: { interactive?: boolean; answers?: string[]; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(o.answers ?? [])];
  const dir = mkdtempSync(join(tmpdir(), "adsentinel-cli-"));
  return {
    out, err, dir,
    io: {
      env: { HOME: dir, ADSENTINEL_API_URL: "http://api.test", ADSENTINEL_API_KEY: "ak_test", ...o.env },
      stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
      interactive: o.interactive ?? false,
      ask: async () => { const a = answers.shift(); if (a === undefined) throw new Error("no answer left"); return a; },
      fetch, version: "0.1.0",
    },
  };
}

const IKEA = {
  next: "IKEA has regional pages. Confirm the proposed page(s) with your user.", status: "ambiguous", query: "IKEA", country: "BE", lookup: "name",
  candidates: [
    { kind: "family", name: "IKEA", likes: 1000, verification: "BLUE_VERIFIED", category: null, proposed: ["112"], marketMember: "found",
      members: [{ pageId: "112", alias: "IKEAbelgium", market: "BE", marketLabel: "Belgium", proposed: true }, { pageId: "200", alias: "IKEAUSA", market: "US", marketLabel: "United States", proposed: false }] },
    { kind: "page", pageId: "300", name: "IKEA Food", alias: null, verification: "NOT_VERIFIED", likes: 12, category: null, igUsername: null, market: null, marketLabel: null },
  ],
};

test("advertiser with page ids submits one job and prints the agent text the API answers", async () => {
  const { fetch, seen } = fakeFetch([() => text(200, RESULT_TEXT)]);
  const t = io(fetch);
  assert.equal(await main(["advertiser", "112,200", "--country", "BE", "--max", "all", "--no-eu", "--mode", "extra-compact", "--approve"], t.io), EXIT.ok);
  assert.deepEqual(seen[0]!.body, { kind: "advertiser", country: "BE", maxAds: "all", mode: "extra-compact", approved: true, euInsights: false, advertiserIds: ["112", "200"] });
  assert.equal(seen[0]!.headers.accept, "text/plain");
  assert.deepEqual(t.out, [RESULT_TEXT]);
});

test("a name in a script prints the candidates and exits 3: a script never crawls a guess", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, IKEA)]);
  const t = io(fetch);
  assert.equal(await main(["advertiser", "IKEA", "--country", "BE"], t.io), EXIT.pick);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url.search, "?q=IKEA&country=BE");
  assert.match(t.out[0]!, /^IKEA has regional pages[\s\S]*\n 1  IKEA · family of 2 pages · verified · 1k likes · proposed: 112\n 2  IKEA Food · 12 likes · page 300$/);
  assert.match(t.err[0]!, /never crawls a guess/);
});

test("--candidates lists and never crawls, in a terminal too", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, IKEA)]);
  const t = io(fetch, { interactive: true });
  assert.equal(await main(["advertiser", "IKEA", "--candidates"], t.io), EXIT.ok);
  assert.equal(seen.length, 1);
});

test("in a terminal the human picks the family; its proposed member is preselected and toggles", async () => {
  const { fetch, seen } = fakeFetch([(r) => (r.url.pathname === "/v1/advertisers" ? json(200, IKEA) : text(200, RESULT_TEXT))]);
  const t = io(fetch, { interactive: true, answers: ["9", "1", "2", ""] }); // 9 is not shown; pick the family, add IKEAUSA, go
  assert.equal(await main(["advertiser", "IKEA", "--country", "BE"], t.io), EXIT.ok);
  assert.deepEqual((seen[1]!.body as { advertiserIds: string[] }).advertiserIds, ["112", "200"]);
  assert.ok(t.err.some((l) => l.includes("[x] Belgium · IKEAbelgium · page 112") && l.includes("[ ] United States")));
  assert.ok(t.err.includes("Type a number from 1 to 2."));
});

test("an empty first answer stops without crawling", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, IKEA)]);
  const t = io(fetch, { interactive: true, answers: [""] });
  assert.equal(await main(["advertiser", "IKEA"], t.io), EXIT.ok);
  assert.equal(seen.length, 1);
});

test("a running job is waited out with get_job, progress on stderr; --no-wait prints the handle", async () => {
  let n = 0;
  const { fetch, seen } = fakeFetch([(r) => (r.method === "POST" ? text(202, JSON.stringify(running())) : text(200, ++n < 2 ? JSON.stringify(running(30)) : RESULT_TEXT))]);
  const t = io(fetch);
  assert.equal(await main(["keyword", "running", "shoes", "--country", "FR"], t.io), EXIT.ok);
  assert.deepEqual(seen[0]!.body, { kind: "keyword", country: "FR", keyword: "running shoes" });
  assert.deepEqual(t.out, [RESULT_TEXT]);
  assert.match(t.err.join("\n"), new RegExp(`job ${JOB}: waiting[\\s\\S]*30 ads found`));

  const { fetch: f2, seen: s2 } = fakeFetch([() => text(202, JSON.stringify(running()))]);
  const t2 = io(f2);
  assert.equal(await main(["keyword", "x", "--no-wait"], t2.io), EXIT.ok);
  assert.equal((s2[0]!.body as { waitSeconds: number }).waitSeconds, 0);
  assert.equal(s2.length, 1);

  const { fetch: f3, seen: s3 } = fakeFetch([() => text(202, JSON.stringify(running()))]);
  assert.equal(await main(["keyword", "x", "--no-wait", "--sort", "recent"], io(f3).io), EXIT.ok);
  assert.equal((s3[0]!.body as { sort: string }).sort, "recent");
});

test("an API refusal goes to stderr with its next and exits 1; --json prints the API's error body", async () => {
  const err = { error: { code: "plan_required", message: "refresh needs the monthly plan", next: "Nothing was billed. Tell your user refresh needs the monthly plan." } };
  const { fetch } = fakeFetch([() => json(403, err)]);
  const t = io(fetch);
  assert.equal(await main(["refresh", "1,2", "3"], t.io), EXIT.api);
  assert.deepEqual(t.err, [`plan_required: refresh needs the monthly plan\n${err.error.next}`]);
  const t2 = io(fetch);
  assert.equal(await main(["refresh", "--from-job", JOB, "--json"], t2.io), EXIT.api);
  assert.deepEqual(JSON.parse(t2.out[0]!), err);
});

test("--out waits, saves the JSONL download and prints only the header", async () => {
  const header = { next: "Done: the 2 newest ads.", jobId: JOB, status: "completed", download: { jsonl: `http://api.test/v1/jobs/${JOB}/download?format=jsonl&sig=s`, csv: "http://api.test/x.csv" } };
  const body = `{"next":"Done","type":"header"}\n{"type":"ad","id":"1"}\n{"type":"end","items":1}\n`;
  const { fetch, seen } = fakeFetch([(r) => (r.url.pathname.endsWith("/download") ? text(200, body) : json(200, { header, tables: {} }))]);
  const t = io(fetch);
  const file = join(t.dir, "ads.jsonl");
  assert.equal(await main(["advertiser", "112", "--out", file], t.io), EXIT.ok);
  assert.equal((seen[0]!.body as { inlineTokens: number }).inlineTokens, 0);
  assert.equal(seen[0]!.headers.accept, "application/json");
  assert.equal(readFileSync(file, "utf8"), body);
  assert.deepEqual(JSON.parse(t.out[0]!), header);
});

test("--out refuses a download cut before its end line", async () => {
  const header = { next: "Done", jobId: JOB, status: "completed", download: { jsonl: "http://api.test/d", csv: "http://api.test/c" } };
  const { fetch } = fakeFetch([(r) => (r.url.pathname === "/d" ? text(200, `{"type":"header"}\n{"type":"ad"}\n`) : json(200, { header, tables: {} }))]);
  const t = io(fetch);
  assert.equal(await main(["advertiser", "112", "--out", join(t.dir, "a.jsonl")], t.io), EXIT.api);
  assert.match(t.err[0]!, /^download_truncated/);
});

test("usage errors exit 2: unknown command, unknown flag, --out without .jsonl/.csv, refresh with both forms", async () => {
  const { fetch } = fakeFetch([]);
  for (const argv of [["fly"], ["account", "--colour"], ["advertiser", "1", "--out", "a.txt"], ["refresh", "1", "--from-job", JOB], ["keyword"], ["advertiser", "1", "--max", "lots"]]) {
    assert.equal(await main(argv, io(fetch).io), EXIT.usage, argv.join(" "));
  }
});

test("login checks the key with the API, then stores it; logout removes it", async () => {
  const { fetch, seen } = fakeFetch([() => json(200, { account: { id: "a" }, key: { name: "laptop", prefix: "ak_live_ab" } })]);
  const t = io(fetch, { env: { ADSENTINEL_API_KEY: "" } });
  assert.equal(await main(["login", "--key", "ak_new"], t.io), EXIT.ok);
  assert.equal(seen[0]!.headers.authorization, "Bearer ak_new");
  assert.equal(readStoredKey(t.io.env), "ak_new");
  assert.equal(await main(["whoami"], t.io), EXIT.ok);
  assert.match(t.out.at(-1)!, /key "laptop" \(ak_live_ab…\) on account a, from .*credentials\.json/);
  assert.equal(await main(["logout"], t.io), EXIT.ok);
  assert.equal(readStoredKey(t.io.env), null);
});

test("login with a key the API refuses stores nothing", async () => {
  const { fetch } = fakeFetch([() => json(401, { error: { code: "invalid_api_key", message: "unknown key", next: "Check the key." } })]);
  const t = io(fetch, { env: { ADSENTINEL_API_KEY: "" } });
  assert.equal(await main(["login", "--key", "ak_bad"], t.io), EXIT.api);
  assert.equal(readStoredKey(t.io.env), null);
});

const FAILED = { next: "The job failed before any ad was fetched. Nothing was billed. Try again.", jobId: JOB, kind: "discover", status: "failed", errorCode: "meta_unavailable", retryable: true, chargedEur: 0 };

test("a job that ended failed or cancelled exits 1 and prints the body; with --out nothing is saved and the API's next is on stderr", async () => {
  const { fetch } = fakeFetch([() => json(200, FAILED)]);
  const t = io(fetch);
  assert.equal(await main(["job", JOB], t.io), EXIT.api);
  assert.deepEqual(JSON.parse(t.out[0]!), FAILED);
  const t2 = io(fetch);
  const file = join(t2.dir, "ads.csv");
  assert.equal(await main(["job", JOB, "--out", file], t2.io), EXIT.api);
  assert.deepEqual(t2.err.filter((l) => l === FAILED.next), [FAILED.next]);
  assert.ok(!t2.err.some((l) => /no_download/.test(l)));
  assert.ok(!existsSync(file));
  const t3 = io(fakeFetch([() => json(200, { ...FAILED, status: "cancelled" })]).fetch);
  assert.equal(await main(["job", JOB, "--no-wait"], t3.io), EXIT.api);
});

const doneHeader = (u: string) => ({ header: { next: "Done", jobId: JOB, status: "completed", download: { jsonl: u, csv: u } }, tables: {} });

test("a cut download never replaces the previous good file, and leaves no .part", async () => {
  const { fetch } = fakeFetch([(r) => (r.url.pathname === "/d" ? text(200, `{"type":"header"}\n{"type":"ad"}\n`) : json(200, doneHeader("http://api.test/d")))]);
  const t = io(fetch);
  const file = join(t.dir, "a.jsonl");
  writeFileSync(file, "GOOD\n");
  assert.equal(await main(["advertiser", "112", "--out", file], t.io), EXIT.api);
  assert.match(t.err[0]!, /^download_truncated/);
  assert.equal(readFileSync(file, "utf8"), "GOOD\n");
  assert.ok(!existsSync(`${file}.part`));
});

test("a download that throws or dies mid-stream is download_failed with the refreshed-link hint, and leaves the old file", async () => {
  const dying = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new TypeError("terminated")); } });
  for (const download of [() => Promise.reject(new TypeError("fetch failed")), () => new Response(dying, { status: 200 })]) {
    const { fetch } = fakeFetch([(r) => (r.url.pathname === "/d" ? download() : json(200, doneHeader("http://api.test/d")))]);
    const t = io(fetch);
    const file = join(t.dir, "a.jsonl");
    writeFileSync(file, "GOOD\n");
    assert.equal(await main(["advertiser", "112", "--out", file], t.io), EXIT.api);
    assert.match(t.err[0]!, /^download_failed: [\s\S]*Run the same command again: the link is refreshed on every read\./);
    assert.equal(readFileSync(file, "utf8"), "GOOD\n");
    assert.ok(!existsSync(`${file}.part`));
  }
});

test("a name with no candidates exits 3 in a script (a human must look), 0 with --candidates or in a terminal", async () => {
  const none = { ...IKEA, status: "none", candidates: [] };
  const { fetch } = fakeFetch([() => json(200, none)]);
  assert.equal(await main(["advertiser", "Zzyzx"], io(fetch).io), EXIT.pick);
  assert.equal(await main(["advertiser", "Zzyzx", "--candidates"], io(fetch).io), EXIT.ok);
  assert.equal(await main(["advertiser", "Zzyzx"], io(fetch, { interactive: true }).io), EXIT.ok);
});

test("an agent shell is not a person: CI, CLAUDECODE or TERM=dumb, or --no-input, make a run non-interactive", async () => {
  assert.equal(isInteractive({}, true, true), true);
  assert.equal(isInteractive({ TERM: "xterm" }, true, true), true);
  assert.equal(isInteractive({}, false, true), false);
  assert.equal(isInteractive({}, true, false), false);
  assert.equal(isInteractive({ CI: "true" }, true, true), false);
  assert.equal(isInteractive({ CLAUDECODE: "1" }, true, true), false);
  assert.equal(isInteractive({ TERM: "dumb" }, true, true), false);
  assert.equal(isInteractive({ CI: "", CLAUDECODE: "" }, true, true), true);
  assert.equal(isInteractive({}, true, true, true), false);
  const { fetch } = fakeFetch([() => json(200, IKEA)]);
  const t = io(fetch, { interactive: true, answers: ["1"] });
  assert.equal(await main(["advertiser", "IKEA", "--no-input"], t.io), EXIT.pick); // never asks
});

test("whoami with no key lets the API answer no_api_key with its own next", async () => {
  const { fetch, seen } = fakeFetch([() => json(401, { error: { code: "no_api_key", message: "no key", next: "Tell your user: create a key at adsentinel.eu." } })]);
  const t = io(fetch, { env: { ADSENTINEL_API_KEY: "" } });
  assert.equal(await main(["whoami"], t.io), EXIT.api);
  assert.equal(seen.length, 1);
  assert.equal(t.err[0], "no_api_key: no key\nTell your user: create a key at adsentinel.eu.");
});
