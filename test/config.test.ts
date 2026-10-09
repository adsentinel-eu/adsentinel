import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseUrlOf, credentialsPath, forgetKey, readStoredKey, resolveKey, storeKey } from "../src/config.ts";

const home = () => ({ HOME: mkdtempSync(join(tmpdir(), "adsentinel-cfg-")) });

test("the key comes from ADSENTINEL_API_KEY first, then the stored file; a blank variable counts as unset", () => {
  const env = home();
  assert.deepEqual(resolveKey(env), { key: null, from: null });
  storeKey(env, "ak_file");
  assert.deepEqual(resolveKey(env), { key: "ak_file", from: "file" });
  assert.deepEqual(resolveKey({ ...env, ADSENTINEL_API_KEY: "  " }), { key: "ak_file", from: "file" }); // the plugin's blank field
  assert.deepEqual(resolveKey({ ...env, ADSENTINEL_API_KEY: "${user_config.api_key}" }), { key: "ak_file", from: "file" }); // unexpanded placeholder
  assert.deepEqual(resolveKey({ ...env, ADSENTINEL_API_KEY: "ak_env" }), { key: "ak_env", from: "env" });
});

test("the credentials file is ~/.config/adsentinel/credentials.json, mode 600, or under XDG_CONFIG_HOME", () => {
  const env = home();
  const path = storeKey(env, "ak_1");
  assert.equal(path, join(env.HOME, ".config", "adsentinel", "credentials.json"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(credentialsPath({ ...env, XDG_CONFIG_HOME: "/x" }), "/x/adsentinel/credentials.json");
  storeKey(env, "ak_2");
  assert.equal(readStoredKey(env), "ak_2");
});

test("forgetting removes the stored key and says whether there was one", () => {
  const env = home();
  assert.equal(forgetKey(env), false);
  storeKey(env, "ak_1");
  assert.equal(forgetKey(env), true);
  assert.equal(readStoredKey(env), null);
});

test("the API URL defaults to api.adsentinel.eu and ADSENTINEL_API_URL overrides it", () => {
  assert.equal(baseUrlOf({}), "https://api.adsentinel.eu");
  assert.equal(baseUrlOf({ ADSENTINEL_API_URL: "http://localhost:8787" }), "http://localhost:8787");
});
