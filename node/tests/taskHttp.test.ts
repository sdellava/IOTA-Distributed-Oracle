import assert from "node:assert/strict";
import test from "node:test";
import { createTaskHttpClient, isPublicAddress, parseTaskUrl, pinnedLookup, fetchTaskBytes } from "../src/taskHttp";
import { handleGetJsonCanonical } from "../src/tasks/handlers/get_json_canonical";
import { handleStorage } from "../src/tasks/handlers/storage";
import { callLlmJsonWithPdfUrl } from "../src/tasks/utils/llm";
import { handleGetTextStrip } from "../src/tasks/handlers/get_text_strip";
import { handleGetHtmlStripDynamic } from "../src/tasks/handlers/get_html_strip_dynamic";
import { resolvePdfSource } from "../src/tasks/utils/pdf";
import { validateDlvcAndExtractDomain } from "../src/tasks/handlers/dlvc_helpers";
import { fetchUrl } from "../src/fetch";

const publicAddress = { address: "93.184.215.14", family: 4 };
function client(responses: Response[], answers = [publicAddress]) {
  const calls: Array<{ url: URL; options: any }> = [];
  let lookups = 0;
  const run = createTaskHttpClient({
    lookup: (async () => { lookups++; return answers; }) as any,
    fetch: (async (url: URL, options: any) => {
      calls.push({ url, options });
      assert.equal(options.redirect, "manual");
      assert.ok(options.dispatcher);
      assert.ok(responses.length, "unexpected outbound request");
      return responses.shift();
    }) as any,
  });
  return { run, calls, lookups: () => lookups };
}

test("special IPv4/IPv6 ranges and alternative URL encodings are blocked", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "168.63.129.16",
    "172.17.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::7f00:1",
    "2001:db8::1", "2002:7f00:1::", "3fff::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://2130706433", "http://0x7f000001", "http://0177.0.0.1", "http://127.1",
    "http://[::ffff:127.0.0.1]", "http://oracle-node-1:9080/status", "http://localhost.",
    "http://service.internal", "file:///etc/passwd", "gopher://example.com", "https://user:secret@example.com"]) {
    assert.throws(() => parseTaskUrl(url), /TASK_/, url);
  }
});

test("rejects every unsafe DNS answer before dispatch, including mixed answers", async () => {
  for (const answers of [[], [{ address: "172.17.0.2", family: 4 }], [publicAddress, { address: "::1", family: 6 }]]) {
    const c = client([], answers);
    await assert.rejects(c.run({ url: "http://service.example.com/status" }), /TASK_DESTINATION_FORBIDDEN/);
    assert.equal(c.calls.length, 0);
  }
});

test("connector lookup only returns the validated snapshot", () => {
  const resolve = pinnedLookup([publicAddress]);
  resolve("service.example.com", { all: true }, (err: any, records: any) => {
    assert.equal(err, null); assert.deepEqual(records, [publicAddress]);
  });
  resolve("service.example.com", { family: 4 }, (err: any, address: string, family: number) => {
    assert.equal(err, null); assert.equal(address, publicAddress.address); assert.equal(family, 4);
  });
  resolve("service.example.com", { family: 6 }, (err: any) => assert.match(err.message, /TASK_DNS_FAILED/));
});

test("public downloads work and relative redirects retain same-origin headers", async () => {
  const c = client([new Response(null, { status: 302, headers: { location: "/next" } }), new Response("ok")]);
  const result = await c.run({ url: "https://example.com/start", headers: { Authorization: "Bearer test" } });
  assert.equal(result.bytes.toString(), "ok");
  assert.equal(c.calls[1].url.pathname, "/next");
  assert.equal(c.calls[1].options.headers.authorization, "Bearer test");
  assert.equal(c.lookups(), 2);
});

test("cross-origin redirects strip all task-supplied headers", async () => {
  const c = client([new Response(null, { status: 302, headers: { location: "https://other.example.com/" } }), new Response("ok")]);
  await c.run({ url: "https://example.com", headers: { Authorization: "secret", Cookie: "secret", "X-API-Key": "secret" } });
  assert.deepEqual(c.calls[1].options.headers, {});
});

test("internal redirects, protocol switches and downgrade are rejected before next request", async () => {
  for (const location of ["http://127.0.0.1:9080/status", "http://[::1]/", "http://oracle-node-1:9080/health",
    "file:///etc/passwd", "gopher://example.com", "http://example.com/"]) {
    const c = client([new Response(null, { status: 302, headers: { location } })]);
    await assert.rejects(c.run({ url: "https://example.com" }), /TASK_/);
    assert.equal(c.calls.length, 1);
  }
});

test("DNS rebinding at a redirect is rejected", async () => {
  let queries = 0, requests = 0;
  const run = createTaskHttpClient({
    lookup: (async () => ++queries === 1 ? [publicAddress] : [{ address: "10.0.0.1", family: 4 }]) as any,
    fetch: (async () => { requests++; return new Response(null, { status: 302, headers: { location: "/again" } }); }) as any,
  });
  await assert.rejects(run({ url: "https://example.com" }), /TASK_DESTINATION_FORBIDDEN/);
  assert.equal(requests, 1);
});

test("redirect loops are bounded", async () => {
  const c = client(Array.from({ length: 6 }, () => new Response(null, { status: 302, headers: { location: "/again" } })));
  await assert.rejects(c.run({ url: "https://example.com" }), /TASK_REDIRECT_LIMIT/);
  assert.equal(c.calls.length, 6);
});

test("size limits apply with and without Content-Length and cancel the stream", async () => {
  const c = client([new Response("small", { headers: { "content-length": "100" } })]);
  await assert.rejects(c.run({ url: "https://example.com", maxBytes: 10 }), /TASK_DOWNLOAD_TOO_LARGE/);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  const streamed = client([new Response(stream)]);
  await assert.rejects(streamed.run({ url: "https://example.com", maxBytes: 10 }), /TASK_DOWNLOAD_TOO_LARGE/);
  assert.equal(cancelled, true);
});

test("deadline covers DNS and response body stalls", async () => {
  const dnsStall = createTaskHttpClient({ lookup: (() => new Promise(() => {})) as any, fetch: (() => assert.fail("fetch called")) as any });
  await assert.rejects(dnsStall({ url: "https://example.com", timeoutMs: 20 }), /TASK_FETCH_TIMEOUT/);
  const c = client([new Response(new ReadableStream({ start() {} }))]);
  await assert.rejects(c.run({ url: "https://example.com", timeoutMs: 20 }), /TASK_FETCH_TIMEOUT/);
});

test("task input cannot increase the hard body-size ceiling", async () => {
  const c = client([new Response("small", { headers: { "content-length": "25000001" } })]);
  await assert.rejects(c.run({ url: "https://example.com", maxBytes: 1_000_000_000 }), /TASK_DOWNLOAD_TOO_LARGE/);
});

test("text, HTML, PDF, legacy fetch and DID paths enforce the same destination policy", async () => {
  const url = "http://127.0.0.1:9080/status";
  for (const handler of [handleGetTextStrip, handleGetHtmlStripDynamic]) {
    await assert.rejects(handler({ payload: { request: { url } } } as any), /TASK_DESTINATION_FORBIDDEN/);
  }
  await assert.rejects(resolvePdfSource({ source: { url } }), /TASK_DESTINATION_FORBIDDEN/);
  await assert.rejects(fetchUrl(url), /TASK_DESTINATION_FORBIDDEN/);
  const document = { service: () => [{ type: () => ["LinkedDomains"], serviceEndpoint: () => url }] };
  await assert.rejects(validateDlvcAndExtractDomain({ didString: "did:iota:test", network: "testnet" } as any, document), /TASK_DESTINATION_FORBIDDEN/);
});

test("request methods and routing headers cannot be controlled by tasks", async () => {
  const c = client([]);
  await assert.rejects(c.run({ url: "https://example.com", method: "POST" }), /TASK_METHOD_FORBIDDEN/);
  for (const key of ["Host", "Connection", "Proxy-Authorization", "Content-Length", "Transfer-Encoding"]) {
    await assert.rejects(c.run({ url: "https://example.com", headers: { [key]: "value" } }), /TASK_HEADER_FORBIDDEN/);
  }
  assert.equal(c.calls.length, 0);
});

test("errors do not return HTTP bodies or resolver diagnostics", async () => {
  const c = client([new Response("secret backend credentials", { status: 403 })]);
  await assert.rejects(c.run({ url: "https://example.com" }), { message: "TASK_HTTP_403" });
  const broken = createTaskHttpClient({ lookup: (async () => { throw Error("private DNS topology"); }) as any, fetch: (() => assert.fail()) as any });
  await assert.rejects(broken({ url: "https://example.com" }), { message: "TASK_FETCH_FAILED" });
});

test("operator domain denials also block subdomains and trailing dots", async () => {
  const before = process.env.TASK_HTTP_DENIED_HOSTS;
  process.env.TASK_HTTP_DENIED_HOSTS = "business.example.com";
  try {
    for (const host of ["business.example.com", "api.business.example.com."]) {
      await assert.rejects(fetchTaskBytes({ url: `https://${host}/` }), /TASK_DESTINATION_FORBIDDEN/);
    }
    assert.doesNotThrow(() => parseTaskUrl("https://notbusiness.example.com"));
  } finally {
    if (before == null) delete process.env.TASK_HTTP_DENIED_HOSTS; else process.env.TASK_HTTP_DENIED_HOSTS = before;
  }
});

test("JSON, STORAGE and LLM PDF entry points cannot bypass destination policy", async () => {
  const savedFetch = globalThis.fetch;
  const savedModel = process.env.LLM_MODEL;
  const savedApi = process.env.LLM_API_URL;
  globalThis.fetch = async () => assert.fail("provider/IPFS call must not run");
  process.env.LLM_MODEL = "test-model";
  process.env.LLM_API_URL = "http://operator-private-llm:8080/v1/chat/completions";
  try {
    await assert.rejects(handleGetJsonCanonical({ payload: { request: { url: "http://127.0.0.1:9080/status" } } } as any), /TASK_DESTINATION_FORBIDDEN/);
    await assert.rejects(handleStorage({ payload: { source: { url: "http://169.254.169.254/" } } } as any), /TASK_DESTINATION_FORBIDDEN/);
    await assert.rejects(callLlmJsonWithPdfUrl({ taskName: "test", prompt: "test", schema: {}, pdfUrl: "http://127.0.0.1/a.pdf" }), /TASK_DESTINATION_FORBIDDEN/);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedModel == null) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedModel;
    if (savedApi == null) delete process.env.LLM_API_URL; else process.env.LLM_API_URL = savedApi;
  }
});
