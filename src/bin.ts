#!/usr/bin/env node
/** The installed command: `adsentinel <command>` and `npx -y adsentinel mcp`. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApi } from "./api.ts";
import { isInteractive, main } from "./cli.ts";
import { baseUrlOf, resolveKey } from "./config.ts";
import { runMcp } from "./mcp.ts";
import { browserCommand } from "./open.ts";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const env = process.env;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** The platform's "open this URL" command; false when it is missing (a server without a desktop). */
function openInBrowser(url: string): Promise<boolean> {
  const command = browserCommand(url, process.platform);
  if (!command) return Promise.resolve(false);
  const [cmd, args] = command;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => { child.unref(); resolve(true); });
  });
}

try {
  process.exitCode = await main(process.argv.slice(2), {
    env, version, ask, open: openInBrowser, hostname: hostname(),
    interactive: isInteractive(env, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY)),
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    runMcp: async () => {
      const api = createApi({ baseUrl: baseUrlOf(env), key: () => resolveKey(env).key, userAgent: `adsentinel-mcp/${version}`, schemaVersion: "latest" });
      await runMcp({ api, version, env }, new StdioServerTransport());
      await new Promise<void>((resolve) => process.stdin.on("close", resolve));
    },
  });
} catch (err) {
  // last resort: a message, never a stack
  process.stderr.write(`internal: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
