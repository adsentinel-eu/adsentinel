import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../src/api.ts";
import { EXIT, main } from "../src/cli.ts";
import { pendingLoginPath, readStoredKey, siteUrlOf } from "../src/config.ts";
import { fakeFetch, json } from "./fake-fetch.ts";

const T = new Date("2026-10-06T10:00:00.000Z");
const CODE = { next: "Show your user…", deviceCode: "dev-secret", userCode: "BCDF-GHJK", verificationUri: "http://site.test/dashboard/device", verificationUriComplete: "http://site.test/dashboard/device?code=BCDF-GHJK", expiresIn: 900, interval: 5 };
const APPROVED = { next: "Approved…", status: "approved", apiKey: "adsk_new", key: { name: "adsentinel CLI on laptop", prefix: "adsk_newpref" } };
const PENDING = { next: "Not yet", status: "pending", interval: 5 };

/** A CLI run on a fake clock: `sleep` moves it forward, so a wait of minutes takes no time. */
function io(fetch: Fetch, o: { interactive?: boolean; env?: Record<string, string>; dir?: string; opened?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "adsentinel-login-"));
  let now = T.getTime();
  const slept: number[] = [];
  return {
    out, err, dir, slept,
    io: {
      env: { HOME: dir, ADSENTINEL_API_URL: "http://api.test", ...o.env },
      stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
      interactive: o.interactive ?? false,
      ask: async () => { throw new Error("login never asks"); },
      fetch, version: "0.1.0", hostname: "laptop",
      open: async (url: string) => { o.opened?.push(url); return true; },
      sleep: async (ms: number) => { slept.push(ms); now += ms; },
      now: () => new Date(now),
    },
  };
}

test("in an agent's shell: the first run prints the link and returns; the next run collects the key", async () => {
  let approved = false;
  const { fetch, seen } = fakeFetch([
    (r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : undefined),
    (r) => (r.url.pathname === "/v1/device/token" ? json(200, approved ? APPROVED : PENDING) : undefined),
  ]);
  const first = io(fetch);
  assert.equal(await main(["login"], first.io), EXIT.ok);
  assert.equal(seen.length, 1, "no poll on the first run");
  assert.deepEqual(seen[0]!.body, { name: "adsentinel CLI on laptop" });
  assert.equal(seen[0]!.headers.authorization, undefined, "no key is sent: there is none yet");
  assert.deepEqual(first.out, [
    "Open this link and approve the code BCDF-GHJK:\nhttp://site.test/dashboard/device?code=BCDF-GHJK",
    "Once it is approved, run `adsentinel login` again to store the key. The link works for 15 minutes.",
  ]);
  assert.equal(statSync(pendingLoginPath(first.io.env)).mode & 0o777, 0o600);

  approved = true;
  const second = io(fetch, { dir: first.dir });
  assert.equal(await main(["login"], second.io), EXIT.ok);
  assert.deepEqual(seen.slice(1).map((r) => [r.url.pathname, r.body]), [["/v1/device/token", { deviceCode: "dev-secret" }]], "the same login is resumed, not a new one");
  assert.equal(readStoredKey(second.io.env), "adsk_new");
  assert.match(second.err.at(-2)!, /^Approved\. Key "adsentinel CLI on laptop" \(adsk_newpref…\) stored in .*credentials\.json/);
  assert.match(second.err.at(-1)!, /^Your account \(credit, keys, jobs\): http:\/\/api\.test\/dashboard, or `adsentinel account`\.$/);
  assert.equal(existsSync(pendingLoginPath(second.io.env)), false);
});

test("in an agent's shell the second run waits a minute at most, then says how to finish", async () => {
  const { fetch, seen } = fakeFetch([
    (r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, PENDING)),
  ]);
  const t = io(fetch);
  await main(["login"], t.io);
  const again = io(fetch, { dir: t.dir });
  assert.equal(await main(["login"], again.io), EXIT.api);
  assert.equal(again.slept.reduce((a, b) => a + b, 0) <= 60_000, true);
  assert.ok(seen.length >= 12, `polled every 5 s for a minute (${seen.length - 1} polls)`);
  assert.equal(again.out.at(-1), "Not approved yet. Open http://site.test/dashboard/device?code=BCDF-GHJK and approve the code BCDF-GHJK, then run `adsentinel login` again.");
  assert.equal(existsSync(pendingLoginPath(again.io.env)), true, "still resumable");
});

test("in a terminal: opens the browser, waits for the approval, stores the key", async () => {
  let polls = 0;
  const { fetch } = fakeFetch([
    (r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, ++polls < 4 ? PENDING : APPROVED)),
  ]);
  const opened: string[] = [];
  const t = io(fetch, { interactive: true, opened });
  assert.equal(await main(["login"], t.io), EXIT.ok);
  assert.deepEqual(opened, [CODE.verificationUriComplete]);
  assert.deepEqual(t.slept, [5000, 5000, 5000]);
  assert.equal(readStoredKey(t.io.env), "adsk_new");
});

test("denied or expired: nothing stored, the pending login dropped, exit 1", async () => {
  for (const status of ["denied", "expired"]) {
    const { fetch } = fakeFetch([(r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, { next: "x", status }))]);
    const t = io(fetch, { interactive: true });
    assert.equal(await main(["login"], t.io), EXIT.api, status);
    assert.equal(readStoredKey(t.io.env), null);
    assert.equal(existsSync(pendingLoginPath(t.io.env)), false);
    assert.match(t.err.at(-1)!, status === "denied" ? /denied in the browser/ : /expired before the key was collected/);
  }
});

test("an answer with no known status ends the login with exit 1 instead of polling forever", async () => {
  const { fetch, seen } = fakeFetch([(r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, { hello: "proxy page" }))]);
  const t = io(fetch, { interactive: true });
  assert.equal(await main(["login"], t.io), EXIT.api);
  assert.equal(seen.length, 2, "one poll, then it stops");
  assert.match(t.err.at(-1)!, /^internal: unexpected answer from http:\/\/api\.test\/v1\/device\/token/);
});

test("a pending login for another API, or past its 15 minutes, is not resumed", async () => {
  const { fetch, seen } = fakeFetch([(r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, PENDING))]);
  const t = io(fetch);
  await main(["login"], t.io);
  const other = io(fetch, { dir: t.dir, env: { ADSENTINEL_API_URL: "http://staging.test" } });
  await main(["login"], other.io);
  assert.equal(seen.at(-1)!.url.toString(), "http://staging.test/v1/device/code");
});

test("logout also drops a pending login; login --key clears it too", async () => {
  const { fetch } = fakeFetch([
    (r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : undefined),
    () => json(200, { account: { id: "a" }, key: { name: "k", prefix: "p" } }),
  ]);
  const t = io(fetch);
  await main(["login"], t.io);
  await main(["logout"], t.io);
  assert.equal(existsSync(pendingLoginPath(t.io.env)), false);
  await main(["login"], t.io);
  assert.equal(await main(["login", "--key", "adsk_have"], t.io), EXIT.ok);
  assert.equal(existsSync(pendingLoginPath(t.io.env)), false);
  assert.equal(readStoredKey(t.io.env), "adsk_have");
});

test("topup prints the dashboard's top-up link, opens it in a terminal; amounts are whole euros 10 to 1000", async () => {
  const { fetch, seen } = fakeFetch([]);
  const opened: string[] = [];
  const t = io(fetch, { interactive: true, opened, env: { ADSENTINEL_API_URL: "" } });
  assert.equal(await main(["topup", "25"], t.io), EXIT.ok);
  assert.deepEqual(t.out, ["https://adsentinel.eu/dashboard/credit?eur=25#topup"]);
  assert.deepEqual(opened, ["https://adsentinel.eu/dashboard/credit?eur=25#topup"]);
  assert.equal(seen.length, 0, "no API call, no key needed");
  const sign = io(fetch, { interactive: true, opened: [], env: { ADSENTINEL_API_URL: "" } });
  assert.equal(await main(["topup", "€25"], sign.io), EXIT.ok);
  assert.deepEqual(sign.out, ["https://adsentinel.eu/dashboard/credit?eur=25#topup"]);

  const agent = io(fetch, { opened });
  assert.equal(await main(["topup"], agent.io), EXIT.ok);
  assert.deepEqual(agent.out, ["http://api.test/dashboard/credit#topup"], "a local API serves its own dashboard");
  assert.equal(opened.length, 1, "an agent's shell never opens a browser");
  for (const bad of ["5", "1001", "12.50", "ten", "$25"]) assert.equal(await main(["topup", bad], io(fetch).io), EXIT.usage, bad);
});

test("the dashboard URL: ADSENTINEL_SITE_URL, else adsentinel.eu for the production API, else the API's own", () => {
  assert.equal(siteUrlOf({}), "https://adsentinel.eu");
  assert.equal(siteUrlOf({ ADSENTINEL_API_URL: "https://api.adsentinel.eu/" }), "https://adsentinel.eu");
  assert.equal(siteUrlOf({ ADSENTINEL_API_URL: "http://localhost:8787" }), "http://localhost:8787");
  assert.equal(siteUrlOf({ ADSENTINEL_API_URL: "http://localhost:8787", ADSENTINEL_SITE_URL: "https://x.test/" }), "https://x.test");
});

test("a pending login that lapsed less than 15 minutes ago is still asked about; an older one starts over", async () => {
  const { fetch, seen } = fakeFetch([(r) => (r.url.pathname === "/v1/device/code" ? json(200, CODE) : json(200, APPROVED))]);
  const first = io(fetch);
  await main(["login"], first.io); // expires at T + 15 min
  seen.length = 0;

  const soon = io(fetch, { dir: first.dir });
  soon.io.now = () => new Date(T.getTime() + 29 * 60_000); // 14 min past expiry
  assert.equal(await main(["login"], soon.io), EXIT.ok);
  assert.deepEqual(seen.map((r) => r.url.pathname), ["/v1/device/token"], "one poll, no new login");
  assert.equal(readStoredKey(soon.io.env), "adsk_new");

  seen.length = 0;
  await main(["login"], first.io); // a fresh pending login again
  seen.length = 0;
  const old = io(fetch, { dir: first.dir });
  old.io.now = () => new Date(T.getTime() + 31 * 60_000); // 16 min past expiry
  await main(["login"], old.io);
  assert.equal(seen[0]!.url.pathname, "/v1/device/code", "a new login");
});

test("a start answer of the wrong shape is an error, nothing saved", async () => {
  const { fetch } = fakeFetch([(r) => (r.url.pathname === "/v1/device/code" ? json(200, { hello: "proxy" }) : undefined)]);
  const t = io(fetch);
  assert.equal(await main(["login"], t.io), EXIT.api);
  assert.equal(existsSync(pendingLoginPath(t.io.env)), false);
  assert.match(t.err.at(-1)!, /^internal: unexpected answer/);
});
