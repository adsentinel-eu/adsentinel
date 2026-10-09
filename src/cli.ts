/** `adsentinel <command>`: the CLI (surface v1 § Verbs, § CLI output). stdout is the same compact text an agent
 *  receives; `--json` prints the raw HTTP envelope; `--out <file>` saves the whole result and prints only the
 *  roll-up header. Progress and questions go to stderr. Exit codes: 0 done, 1 the API said no, 2 usage,
 *  3 a name needs a human to pick the page (non-interactive). */
import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ApiError, createApi, type Api, type ApiResponse, type Fetch } from "./api.ts";
import { callTool, failedJobOf, handleOf, type Args } from "./calls.ts";
import {
  baseUrlOf, clearPendingLogin, credentialsPath, forgetKey, readPendingLogin, resolveKey, savePendingLogin, siteUrlOf, storeKey, type Env,
} from "./config.ts";
import { pollDevice, startDevice } from "./device.ts";
import { candidatesText, pickPages, type Lookup } from "./pick.ts";
import { waitForResult } from "./wait.ts";

export interface CliIo {
  env: Env;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** True when a human can answer questions (stdin and stdout are terminals). */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  fetch?: Fetch;
  version: string;
  /** Starts the MCP server on stdio (bin.ts); the CLI never runs it itself. */
  runMcp?: () => Promise<void>;
  /** Opens a URL in the browser (bin.ts); false when it could not. Only called when `interactive`. */
  open?: (url: string) => Promise<boolean>;
  /** This machine's name, for the key `adsentinel login` asks for. */
  hostname?: string;
  /** Waits between login polls; tests pass one that advances `now`. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Whether a human can answer questions: both ends are terminals, and no agent shell or `--no-input` says otherwise.
 *  An agent's shell (Claude Code sets CLAUDECODE; CI sets CI) can have a terminal and still no one to ask. */
export function isInteractive(env: Env, stdinTTY: boolean, stdoutTTY: boolean, noInput = false): boolean {
  return stdinTTY && stdoutTTY && !noInput && !env.CI && !env.CLAUDECODE && env.TERM !== "dumb";
}

export const EXIT = { ok: 0, api: 1, usage: 2, pick: 3 } as const;

class Usage extends Error {}

const HELP = `adsentinel: Meta Ad Library ads for you and your agents. https://adsentinel.eu/docs/quickstart

  adsentinel advertiser <pageId[,pageId...]|name>   ads one or more pages run (a name: pick the page first)
  adsentinel advertiser <name> --candidates          list the pages a name could mean; never crawls (free)
  adsentinel keyword <keyword>                       ads matching a keyword, every advertiser listed
  adsentinel job <jobId>                             wait for a job and read its result (free, 90 days)
  adsentinel cancel <jobId>                          stop a job; it keeps what it fetched
  adsentinel refresh <adId...> | --from-job <jobId>  current state of ads you have (monthly plan)
  adsentinel account                                 credit, plan, spend guards, recent jobs
  adsentinel login                                   sign in through your browser; stores a new key (~/.config/adsentinel, mode 600)
  adsentinel login --key <key>                       store a key you already have
  adsentinel logout | whoami
  adsentinel topup [eur]                             open the dashboard's top-up (whole euros, 10 to 1000)
  adsentinel mcp                                     the MCP server, on stdio

Common: --country XX  --max N|all  --mode compact|extra-compact|full  --projection volatile|default|full
        --approve  --out <file.jsonl|file.csv>  --json  --no-wait  --inline-tokens N  --idempotency-key K
        --no-input (never ask a question: a name that needs a pick exits 3)
Advertiser: --active active|inactive|all  --no-eu  --variants  --new-only  --resume <jobId>
Keyword: --match phrase|all_words  --sort impressions|recent  --active  --new-only  --resume <jobId>
Job: --cursor C
Key: ADSENTINEL_API_KEY overrides the stored key. API: ADSENTINEL_API_URL (default https://api.adsentinel.eu).
Dashboard: ADSENTINEL_SITE_URL (default https://adsentinel.eu, or the API's own URL when ADSENTINEL_API_URL is set).`;

const OPTIONS = {
  country: { type: "string" }, max: { type: "string" }, mode: { type: "string" }, projection: { type: "string" },
  approve: { type: "boolean" }, out: { type: "string" }, json: { type: "boolean" }, "no-wait": { type: "boolean" }, "no-input": { type: "boolean" },
  "inline-tokens": { type: "string" }, "idempotency-key": { type: "string" }, "schema-version": { type: "string" },
  active: { type: "string" }, "no-eu": { type: "boolean" }, variants: { type: "boolean" }, "new-only": { type: "boolean" },
  resume: { type: "string" }, match: { type: "string" }, sort: { type: "string" }, candidates: { type: "boolean" }, cursor: { type: "string" },
  "from-job": { type: "string" }, key: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
} as const satisfies ParseArgsConfig["options"];

type Flags = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

const PAGE_IDS = /^\d+(,\d+)*$/;
const whole = (v: string, name: string) => {
  if (!/^\d+$/.test(v)) throw new Usage(`${name} must be a whole number`);
  return Number(v);
};

/** Reading and spend parameters every ad call shares, as the API names them. */
function common(f: Flags): Args {
  const a: Args = {};
  if (f.country !== undefined) a.country = f.country;
  if (f.max !== undefined) a.maxAds = f.max === "all" ? "all" : whole(f.max, "--max");
  if (f.mode !== undefined) a.mode = f.mode;
  if (f.projection !== undefined) a.projection = f.projection;
  if (f["inline-tokens"] !== undefined) a.inlineTokens = whole(f["inline-tokens"], "--inline-tokens");
  if (f["idempotency-key"] !== undefined) a.idempotencyKey = f["idempotency-key"];
  if (f.approve) a.approved = true;
  return a;
}

function discovery(f: Flags): Args {
  const a = common(f);
  if (f.active !== undefined) a.activeStatus = f.active;
  if (f["new-only"]) a.newOnly = true;
  if (f.resume !== undefined) a.resumeFrom = f.resume;
  return a;
}

const reading = (a: Args): Args => ({ mode: a.mode, projection: a.projection, inlineTokens: a.inlineTokens });

export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }) as { values: Flags; positionals: string[] };
  } catch (err) {
    io.stderr(`${(err as Error).message}\nRun \`adsentinel --help\`.`);
    return EXIT.usage;
  }
  const { values: f, positionals } = parsed;
  const [command, ...rest] = positionals;
  io = { ...io, interactive: io.interactive && !f["no-input"] };
  if (f.version) { io.stdout(io.version); return EXIT.ok; }
  if (f.help || !command || command === "help") { io.stdout(HELP); return command || f.help ? EXIT.ok : EXIT.usage; }

  const keySource = resolveKey(io.env);
  const api = createApi({
    baseUrl: baseUrlOf(io.env), key: keySource.key, userAgent: `adsentinel-cli/${io.version}`,
    ...(f["schema-version"] ? { schemaVersion: f["schema-version"] } : {}), ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  try {
    switch (command) {
      case "advertiser": return await advertiser(api, io, f, rest);
      case "keyword": {
        if (!rest.length) throw new Usage("adsentinel keyword <keyword>");
        const a: Args = { ...discovery(f), keyword: rest.join(" ") };
        if (f.match !== undefined) a.match = f.match;
        if (f.sort !== undefined) a.sort = f.sort;
        return await adJob(api, io, f, "get_keyword_ads", a);
      }
      case "job": {
        if (rest.length !== 1) throw new Usage("adsentinel job <jobId>");
        const a: Args = { ...reading(common(f)), jobId: rest[0] };
        if (f.cursor !== undefined) a.cursor = f.cursor;
        return await adJob(api, io, f, "get_job", a);
      }
      case "cancel":
        if (rest.length !== 1) throw new Usage("adsentinel cancel <jobId>");
        return print(io, f, await callTool(api, "cancel_job", { jobId: rest[0] }, { accept: "json" }));
      case "refresh": {
        if (!rest.length === !f["from-job"]) throw new Usage("adsentinel refresh <adId...> | --from-job <jobId>");
        const a: Args = common(f);
        if (f["from-job"]) a.fromJobId = f["from-job"];
        else a.adIds = rest.flatMap((s) => s.split(",")).filter(Boolean);
        return await adJob(api, io, f, "refresh_ads", a);
      }
      case "account":
        return print(io, f, await callTool(api, "get_account", {}, { accept: "json" }));
      case "login": return await login(io, f);
      case "topup": return await topup(io, rest);
      case "logout":
        clearPendingLogin(io.env);
        io.stderr(forgetKey(io.env) ? `Removed the key stored in ${credentialsPath(io.env)}.` : "No key was stored.");
        if (keySource.from === "env") io.stderr("ADSENTINEL_API_KEY is still set in this shell.");
        return EXIT.ok;
      case "whoami": {
        const acct = JSON.parse((await callTool(api, "get_account", {}, { accept: "json" })).text) as { account: { id: string }; key: { name: string; prefix: string } };
        io.stdout(`key "${acct.key.name}" (${acct.key.prefix}…) on account ${acct.account.id}, from ${keySource.from === "env" ? "ADSENTINEL_API_KEY" : credentialsPath(io.env)}`);
        return EXIT.ok;
      }
      case "mcp":
        if (!io.runMcp) throw new Usage("the MCP server runs from the installed command: npx -y adsentinel mcp");
        await io.runMcp();
        return EXIT.ok;
      default:
        throw new Usage(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof Usage) { io.stderr(`${err.message}\nRun \`adsentinel --help\`.`); return EXIT.usage; }
    if (err instanceof ApiError) {
      if (f.json) io.stdout(JSON.stringify(err.body(), null, 2));
      else io.stderr(`${err.code}: ${err.message}\n${err.next}`);
      return EXIT.api;
    }
    throw err;
  }
}

function print(io: CliIo, f: Flags, res: ApiResponse): number {
  io.stdout(f.json ? res.text : prettyJson(res.text));
  return EXIT.ok;
}

const prettyJson = (t: string) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };

async function advertiser(api: Api, io: CliIo, f: Flags, rest: string[]): Promise<number> {
  if (!rest.length) throw new Usage("adsentinel advertiser <pageId[,pageId...]|name>");
  const target = rest.join(" ").trim();
  const a = discovery(f);
  if (f["no-eu"]) a.euInsights = false;
  if (f.variants) a.variants = true;
  if (PAGE_IDS.test(target) && !f.candidates) return adJob(api, io, f, "get_advertiser_ads", { ...a, advertiserIds: target.split(",") });
  if (f.resume !== undefined) return adJob(api, io, f, "get_advertiser_ads", a);

  const found = await callTool(api, "find_advertiser", { query: target, ...(f.country ? { country: f.country } : {}) }, { accept: "json" });
  const lookup = JSON.parse(found.text) as Lookup;
  const shown = () => io.stdout(f.json ? found.text : candidatesText(lookup));
  if (f.candidates) { shown(); return EXIT.ok; }
  if (lookup.candidates.length === 0) {
    shown();
    return io.interactive ? EXIT.ok : EXIT.pick; // nothing to crawl: in a script a human must look
  }
  if (!io.interactive) {
    io.stdout(f.json ? found.text : candidatesText(lookup));
    io.stderr("Pick the page, then run: adsentinel advertiser <pageId[,pageId...]>. A script never crawls a guess.");
    return EXIT.pick;
  }
  const ids = await pickPages(lookup, io.ask, io.stderr);
  if (!ids) return EXIT.ok;
  return adJob(api, io, f, "get_advertiser_ads", { ...a, advertiserIds: ids });
}

/** Submits (or reads) a job, waits until it ends unless --no-wait, then prints it or saves it with --out. */
async function adJob(api: Api, io: CliIo, f: Flags, tool: string, args: Args): Promise<number> {
  if (f.out !== undefined) return saveTo(api, io, f, tool, args, f.out);
  const accept = f.json ? "json" : "text";
  const noWait = f["no-wait"];
  const first = await callTool(api, tool, noWait ? { ...args, waitSeconds: 0 } : args, { accept });
  const res = noWait ? first : await waitWithProgress(api, io, first, accept, reading(args));
  io.stdout(res.text);
  return failedJobOf(res.text) ? EXIT.api : EXIT.ok;
}

function waitWithProgress(api: Api, io: CliIo, first: ApiResponse, accept: "text" | "json", r: Args): Promise<ApiResponse> {
  const h = handleOf(first.text);
  if (h) io.stderr(`job ${h.jobId}: waiting (Ctrl-C stops waiting, not the job; read it later with \`adsentinel job ${h.jobId}\`)`);
  return waitForResult(api, first, {
    accept, reading: r, budgetMs: Infinity,
    onProgress: (x) => io.stderr(`job ${x.jobId}: ${x.status}, ${x.progress?.adsFound ?? 0} ads found${x.etaSeconds ? `, about ${x.etaSeconds}s left` : ""}`),
  });
}

/** --out: wait for the job, fetch its download (JSONL or CSV by extension), print only the header. */
async function saveTo(api: Api, io: CliIo, f: Flags, tool: string, args: Args, file: string): Promise<number> {
  const format = file.endsWith(".csv") ? "csv" : file.endsWith(".jsonl") ? "jsonl" : null;
  if (!format) throw new Usage("--out needs a .jsonl or .csv file name");
  if (f["no-wait"]) throw new Usage("--out waits for the job: drop --no-wait");
  const first = await callTool(api, tool, { ...args, inlineTokens: 0 }, { accept: "json" });
  const res = await waitWithProgress(api, io, first, "json", { ...reading(args), inlineTokens: 0 });
  const h = handleOf(res.text);
  if (h) throw new ApiError("job_not_done", `job ${h.jobId} is ${h.status}`, h.next, 0);
  const failed = failedJobOf(res.text);
  if (failed) {
    io.stdout(res.text);
    io.stderr(failed.next);
    return EXIT.api;
  }
  const body = JSON.parse(res.text) as { header?: { download?: Record<string, string> | null } & Record<string, unknown> };
  const url = body.header?.download?.[format];
  if (!url) {
    io.stdout(JSON.stringify(body.header ?? body, null, 2));
    throw new ApiError("no_download", "this result has no download link", "Read it with `adsentinel job <jobId>` instead.", 0);
  }
  const again = "Run the same command again: the link is refreshed on every read.";
  const part = `${file}.part`; // a cut download never replaces the previous good file
  try {
    const dl = await (io.fetch ?? ((u, i) => fetch(u, i)))(url, { method: "GET", headers: { "user-agent": `adsentinel-cli/${io.version}` } });
    if (!dl.ok || !dl.body) throw new ApiError("download_failed", `download answered HTTP ${dl.status}`, again, dl.status);
    await pipeline(Readable.fromWeb(dl.body as import("node:stream/web").ReadableStream), createWriteStream(part));
    if (format === "jsonl") await checkJsonlEnd(part, file);
    await rename(part, file);
  } catch (err) {
    await rm(part, { force: true });
    if (err instanceof ApiError) throw err;
    throw new ApiError("download_failed", `the download stopped: ${(err as Error).message}`, again, 0);
  }
  io.stdout(JSON.stringify(body.header, null, 2));
  io.stderr(`saved ${file}`);
  return EXIT.ok;
}

/** A JSONL download ends with `{"type":"end"}`; without it the transfer was cut (response modes v1 § Downloads). */
async function checkJsonlEnd(path: string, file: string): Promise<void> {
  const last = (await readFile(path, "utf8")).trimEnd().split("\n").at(-1) ?? "";
  let end = false;
  try { end = (JSON.parse(last) as { type?: string }).type === "end"; } catch { /* not JSON */ }
  if (!end) throw new ApiError("download_truncated", `${file} is incomplete: the download stopped before its end line`, "Run the same command again.", 0);
}

async function login(io: CliIo, f: Flags): Promise<number> {
  if (f.key !== undefined) return loginWithKey(io, f.key.trim());
  return loginInBrowser(io);
}

async function loginWithKey(io: CliIo, key: string): Promise<number> {
  if (!key) throw new Usage("adsentinel login --key <key>");
  const api = createApi({ baseUrl: baseUrlOf(io.env), key, userAgent: `adsentinel-cli/${io.version}`, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const acct = JSON.parse((await callTool(api, "get_account", {}, { accept: "json" })).text) as { key: { name: string } };
  const path = storeKey(io.env, key);
  clearPendingLogin(io.env);
  io.stderr(`Key "${acct.key.name}" works. Stored in ${path} (only you can read it).`);
  return EXIT.ok;
}

/** How long a run without a human at the terminal waits for the approval before it hands back. */
export const AGENT_LOGIN_WAIT_MS = 60_000;

/**
 * The browser device flow. The first run prints the link and the code. In a terminal it opens the browser and
 * waits for the approval. In an agent's shell (no terminal) it returns at once, so the agent can show the link,
 * and the next `adsentinel login` waits up to a minute for the approval and stores the key.
 */
async function loginInBrowser(io: CliIo): Promise<number> {
  const baseUrl = baseUrlOf(io.env);
  const api = createApi({ baseUrl, key: null, userAgent: `adsentinel-cli/${io.version}`, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const now = () => io.now?.() ?? new Date();
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pending = readPendingLogin(io.env, baseUrl, now());
  if (!pending) {
    const name = `adsentinel CLI on ${io.hostname?.trim() || "this computer"}`.slice(0, 100);
    const d = await startDevice(api, name);
    pending = { deviceCode: d.deviceCode, userCode: d.userCode, url: d.verificationUriComplete, expiresAt: new Date(now().getTime() + d.expiresIn * 1000).toISOString(), baseUrl };
    savePendingLogin(io.env, pending);
    io.stdout(`Open this link and approve the code ${pending.userCode}:\n${pending.url}`);
    if (!io.interactive) {
      io.stdout("Once it is approved, run `adsentinel login` again to store the key. The link works for 15 minutes.");
      return EXIT.ok;
    }
    if (io.open && (await io.open(pending.url))) io.stderr("Opened it in your browser.");
    io.stderr("Waiting for the approval (Ctrl-C stops waiting; run `adsentinel login` again to resume).");
  } else {
    io.stderr(`Waiting for the approval of ${pending.userCode} at ${pending.url}`);
  }
  const deadline = io.interactive ? Date.parse(pending.expiresAt) : Math.min(Date.parse(pending.expiresAt), now().getTime() + AGENT_LOGIN_WAIT_MS);
  for (;;) {
    const r = await pollDevice(api, pending.deviceCode);
    if (r.status === "approved") {
      const path = storeKey(io.env, r.apiKey);
      clearPendingLogin(io.env);
      io.stderr(`Approved. Key "${r.key.name}" (${r.key.prefix}…) stored in ${path} (only you can read it).`);
      return EXIT.ok;
    }
    if (r.status === "denied" || r.status === "expired") {
      clearPendingLogin(io.env);
      io.stderr(r.status === "denied" ? "The sign-in was denied in the browser. No key was stored." : "The link expired before the key was collected. Run `adsentinel login` for a new one.");
      return EXIT.api;
    }
    if (r.status !== "pending") {
      // an answer this client doesn't know (a proxy's page, a newer API): never poll on blindly
      throw new ApiError("internal", `unexpected answer from ${baseUrl}/v1/device/token`, "Run `adsentinel login` again; if it persists, update the CLI.", 0);
    }
    const interval = Number.isFinite(r.interval) && r.interval > 0 ? r.interval : 5;
    if (now().getTime() + interval * 1000 > deadline) {
      io.stdout(`Not approved yet. Open ${pending.url} and approve the code ${pending.userCode}, then run \`adsentinel login\` again.`);
      return EXIT.api;
    }
    await sleep(interval * 1000);
  }
}

/** `adsentinel topup [eur]`: the dashboard's top-up form (Checkout needs the signed-in browser). */
async function topup(io: CliIo, rest: string[]): Promise<number> {
  const usage = "adsentinel topup [eur]: whole euros from 10 to 1000";
  if (rest.length > 1) throw new Usage(usage);
  let url = `${siteUrlOf(io.env)}/dashboard/credit`;
  if (rest[0] !== undefined) {
    const eur = /^€?\d{1,4}$/.test(rest[0]) ? Number(rest[0].replace("€", "")) : NaN;
    if (!(eur >= 10 && eur <= 1000)) throw new Usage(usage);
    url += `?eur=${eur}`;
  }
  url += "#topup";
  io.stdout(url);
  if (io.interactive && io.open && (await io.open(url))) io.stderr("Opened it in your browser. Pay there; the credit shows in `adsentinel account` once Stripe confirms.");
  else io.stderr("Open it in a browser signed in to your AdSentinel account to pay.");
  return EXIT.ok;
}
