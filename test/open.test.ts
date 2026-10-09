import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "../src/open.ts";

test("http and https URLs get the platform's command, the URL as its own last argument", () => {
  for (const url of ["https://adsentinel.eu/dashboard/credit?eur=20#topup", "http://localhost:8080/dashboard/device?code=BCDF-GHJK"]) {
    assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
    assert.deepEqual(browserCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
    assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
  }
});

test("anything but an absolute http(s) URL is not opened", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "-x", "not a url", "", "//a.test/x"]) {
    for (const platform of ["darwin", "win32", "linux"] as const) assert.equal(browserCommand(url, platform), null, `${url} on ${platform}`);
  }
});

test("a URL with shell metacharacters never goes through cmd on Windows", () => {
  const [cmd, args] = browserCommand("https://a.test/x&calc", "win32")!;
  assert.equal(cmd, "rundll32");
  assert.equal(args.at(-1), "https://a.test/x&calc");
});
