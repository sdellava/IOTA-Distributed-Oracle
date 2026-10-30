import assert from "node:assert/strict";
import test from "node:test";
import { createTaskHttpClient, TaskHttpError, pinnedLookup } from "../src/taskHttp.js";
import { createStorageProbe } from "../src/storageProbe.js";
import { loadOrCreateClientIdentity } from "../src/keys.js";
import fs from "node:fs";
import path from "node:path";

const publicAnswer = { address: "93.184.215.14", family: 4 };
function fixture(responses: Response[], answers = [publicAnswer]) {
  const calls: any[] = [];
  const request = createTaskHttpClient({
    lookup: (async () => answers) as any,
    fetch: (async (url: URL, options: any) => {
      calls.push({ url, options });
      assert.equal(options.redirect, "manual");
      assert.ok(options.dispatcher);
      assert.ok(responses.length);
      return responses.shift();
    }) as any,
  });
  return { probe: createStorageProbe(request), calls };
}
const task = { source: { url: "https://storage.example.com/file" } };

test("public HEAD returns size without downloading even large objects", async () => {
  const f = fixture([new Response(null, { headers: { "content-length": "900000000" } })]);
  assert.equal(await f.probe(task), 900000000n);
  assert.equal(f.calls[0].options.method, "HEAD");
});
test("HEAD failure falls back to Range GET and cancels ignored Range body", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const f = fixture([new Response(null, { status: 405 }), new Response(body, { headers: { "content-range": "bytes 0-0/1234" } })]);
  assert.equal(await f.probe(task), 1234n);
  assert.equal(f.calls[1].options.headers.range, "bytes=0-0");
  assert.ok(cancelled);
});
test("missing HEAD length falls back; invalid lengths fail safely", async () => {
  const f = fixture([new Response(null), new Response(null, { headers: { "content-length": "54" } })]);
  assert.equal(await f.probe(task), 54n);
  const invalid = fixture([new Response(null, { headers: { "content-length": "oops" } }), new Response(null)]);
  await assert.rejects(invalid.probe(task), /TASK_STORAGE_LENGTH_UNAVAILABLE/);
});
test("encoded loopback, IPv6, metadata and private DNS never reach fetch", async () => {
  for (const url of ["http://2130706433", "http://127.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://169.254.169.254"]) {
    const f = fixture([]);
    await assert.rejects(f.probe({ source: { url } }), /TASK_DESTINATION_FORBIDDEN/);
    assert.equal(f.calls.length, 0);
  }
  for (const answers of [[{ address: "172.17.0.2", family: 4 }], [publicAnswer, { address: "::1", family: 6 }]]) {
    const f = fixture([], answers);
    await assert.rejects(f.probe(task), /TASK_DESTINATION_FORBIDDEN/);
    assert.equal(f.calls.length, 0);
  }
});
test("redirect to internal is denied without fallback; cross-origin credentials stripped", async () => {
  const internal = fixture([new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000" } })]);
  await assert.rejects(internal.probe(task), /TASK_DESTINATION_FORBIDDEN/);
  assert.equal(internal.calls.length, 1);
  const external = fixture([new Response(null, { status: 302, headers: { location: "https://other.example.com" } }), new Response(null, { headers: { "content-length": "12" } })]);
  assert.equal(await external.probe({ source: { ...task.source, headers: { Authorization: "secret" } } }), 12n);
  assert.deepEqual(external.calls[1].options.headers, {});
});
test("Host override is blocked before dispatch", async () => {
  const f = fixture([]);
  await assert.rejects(f.probe({ source: { ...task.source, headers: { Host: "localhost" } } }), /TASK_HEADER_FORBIDDEN/);
  assert.equal(f.calls.length, 0);
});
test("DNS pinning only returns checked addresses", () => {
  pinnedLookup([publicAnswer])("ignored.example.com", { all: true }, (error: any, answers: any) => {
    assert.equal(error, null); assert.deepEqual(answers, [publicAnswer]);
  });
});
test("timeout is enforced during DNS resolution", async () => {
  const request = createTaskHttpClient({ lookup: (() => new Promise(() => {})) as any, fetch: (() => assert.fail("fetch called")) as any });
  await assert.rejects(createStorageProbe(request)({ ...task, timeouts: { storageProbeMs: 5 } }), /TASK_FETCH_TIMEOUT/);
});
test("Webview preparation cannot read or generate any wallet key", () => {
  const old = process.env.ORACLE_PREPARE_ONLY;
  process.env.ORACLE_PREPARE_ONLY = "1";
  try { assert.throws(loadOrCreateClientIdentity, /Signing is disabled/); }
  finally { if (old === undefined) delete process.env.ORACLE_PREPARE_ONLY; else process.env.ORACLE_PREPARE_ONLY = old; }
});
test("standalone CLI retains local identity creation and reuse", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "wallet-fixture-"));
  const oldFile = process.env.CLIENT_KEY_FILE;
  const oldMode = process.env.ORACLE_PREPARE_ONLY;
  process.env.CLIENT_KEY_FILE = path.join(dir, "client.iotaprivkey");
  delete process.env.ORACLE_PREPARE_ONLY;
  try {
    const first = loadOrCreateClientIdentity();
    const second = loadOrCreateClientIdentity();
    assert.equal(first.address, second.address);
    assert.ok(fs.existsSync(process.env.CLIENT_KEY_FILE));
  } finally {
    if (oldFile === undefined) delete process.env.CLIENT_KEY_FILE; else process.env.CLIENT_KEY_FILE = oldFile;
    if (oldMode === undefined) delete process.env.ORACLE_PREPARE_ONLY; else process.env.ORACLE_PREPARE_ONLY = oldMode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("HEAD network failure still permits a validated GET fallback", async () => {
  let calls = 0;
  const probe = createStorageProbe((async () => {
    if (++calls === 1) throw new TaskHttpError("TASK_FETCH_FAILED");
    return { bytes: Buffer.alloc(0), contentType: null, contentLength: "10", contentRange: null };
  }) as any);
  assert.equal(await probe(task), 10n);
  assert.equal(calls, 2);
});


test("optional host and port allowlists keep mandatory IP restrictions", async () => {
  const oldHosts = process.env.TASK_HTTP_ALLOWED_HOSTS;
  const oldPorts = process.env.TASK_HTTP_ALLOWED_PORTS;
  process.env.TASK_HTTP_ALLOWED_HOSTS = "example.com,*.storage.example.com,127.0.0.1";
  process.env.TASK_HTTP_ALLOWED_PORTS = "443";
  try {
    const { parseTaskUrl } = await import("../src/taskHttp.js");
    assert.equal(parseTaskUrl("https://example.com/file").hostname, "example.com");
    assert.equal(parseTaskUrl("https://one.storage.example.com/file").hostname, "one.storage.example.com");
    for (const url of ["https://storage.example.com/", "https://evil-example.com/", "https://example.com.evil.com/", "https://elsewhere.com/"]) assert.throws(() => parseTaskUrl(url), /TASK_DESTINATION_FORBIDDEN/);
    assert.throws(() => parseTaskUrl("http://example.com/"), /TASK_PORT_FORBIDDEN/);
    assert.throws(() => parseTaskUrl("https://127.0.0.1/"), /TASK_DESTINATION_FORBIDDEN/);
  } finally {
    if (oldHosts === undefined) delete process.env.TASK_HTTP_ALLOWED_HOSTS; else process.env.TASK_HTTP_ALLOWED_HOSTS = oldHosts;
    if (oldPorts === undefined) delete process.env.TASK_HTTP_ALLOWED_PORTS; else process.env.TASK_HTTP_ALLOWED_PORTS = oldPorts;
  }
});
