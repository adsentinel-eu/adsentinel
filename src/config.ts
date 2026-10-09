/** Where the key comes from (surface v1 § Keys): `ADSENTINEL_API_KEY` first, then the stored credentials
 *  (`~/.config/adsentinel/credentials.json`, mode 600). A blank variable counts as unset: the Claude Code plugin
 *  injects an empty string when its key field is left blank. */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_SITE_URL } from "./api.ts";

export type Env = Record<string, string | undefined>;

export function credentialsPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "adsentinel", "credentials.json");
}

export function readStoredKey(env: Env): string | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(env), "utf8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null;
  } catch {
    return null;
  }
}

export interface KeySource {
  key: string | null;
  from: "env" | "file" | null;
}

export function resolveKey(env: Env): KeySource {
  const fromEnv = env.ADSENTINEL_API_KEY?.trim();
  // `${user_config.api_key}` unexpanded (a host that did not substitute it) is not a key
  if (fromEnv && !fromEnv.startsWith("${")) return { key: fromEnv, from: "env" };
  const stored = readStoredKey(env);
  return stored ? { key: stored, from: "file" } : { key: null, from: null };
}

/** Writes the key with mode 600 (the directory 700); an existing file is replaced. */
export function storeKey(env: Env, key: string): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** True when a stored key was removed. */
export function forgetKey(env: Env): boolean {
  const path = credentialsPath(env);
  const had = readStoredKey(env) !== null;
  rmSync(path, { force: true });
  return had;
}

export const baseUrlOf = (env: Env): string => env.ADSENTINEL_API_URL?.trim() || DEFAULT_BASE_URL;

/** Where the dashboard is: `ADSENTINEL_SITE_URL`, else adsentinel.eu for the production API, else the API itself
 *  (a local or staging API serves its own dashboard). */
export function siteUrlOf(env: Env): string {
  const set = env.ADSENTINEL_SITE_URL?.trim();
  if (set) return set.replace(/\/+$/, "");
  const api = baseUrlOf(env).replace(/\/+$/, "");
  return api === DEFAULT_BASE_URL ? DEFAULT_SITE_URL : api;
}

/** A browser login started and not finished yet (plan 6c): `adsentinel login` run again picks it up. */
export interface PendingLogin {
  deviceCode: string;
  userCode: string;
  url: string;
  /** ISO time. */
  expiresAt: string;
  /** The API it was started against: a login for another API is not resumed. */
  baseUrl: string;
}

export const pendingLoginPath = (env: Env): string => join(dirname(credentialsPath(env)), "login.json");

/** A pending login stays readable this long past its `expiresAt`: the server collects an approval for 15 minutes
 *  after it was given, so a late run asks once instead of starting over. */
export const PENDING_LOGIN_GRACE_MS = 15 * 60_000;

/** The pending login for `baseUrl`, unless missing, unreadable, for another API or expired beyond the grace. */
export function readPendingLogin(env: Env, baseUrl: string, now: Date): PendingLogin | null {
  try {
    const p = JSON.parse(readFileSync(pendingLoginPath(env), "utf8")) as Partial<PendingLogin>;
    if (typeof p.deviceCode !== "string" || typeof p.userCode !== "string" || typeof p.url !== "string" || typeof p.expiresAt !== "string") return null;
    if (p.baseUrl !== baseUrl || !(Date.parse(p.expiresAt) + PENDING_LOGIN_GRACE_MS > now.getTime())) return null;
    return p as PendingLogin;
  } catch {
    return null;
  }
}

/** Mode 600 like the key: the device code is worth a key until it expires. */
export function savePendingLogin(env: Env, p: PendingLogin): void {
  const path = pendingLoginPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearPendingLogin(env: Env): void {
  rmSync(pendingLoginPath(env), { force: true });
}
