import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAuditFile, auditFileFromEnv } from "../server/auditFile.js";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), "audit-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "audit.log"); const output: string[] = []; const warnings: string[] = [];
  const create = (extra = {}) => createAuditFile({ enabled: true, file, maxBytes: 100, maxFiles: 3, stdout: false,
    output: line => output.push(line), warning: line => warnings.push(line), ...extra });
  const read = (name: string) => fs.readFileSync(name, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { directory, file, create, output, warnings, read };
}
test("audit creates directories and writes complete UTF-8 JSON records", t => {
  const f = fixture(t); const file = path.join(f.directory, "nested", "audit.log");
  const writer = f.create({ file, maxBytes: 200 });
  assert.ok(writer.emit({ event: "richiesta", text: "città ☕" }));
  assert.deepEqual(f.read(file), [{ event: "richiesta", text: "città ☕" }]);
  assert.equal(f.output.length, 0);
});
test("rotation includes the current file in count and removes oldest complete records", t => {
  const f = fixture(t); const writer = f.create();
  for (let index = 0; index < 10; index++) assert.ok(writer.emit({ index, padding: "x".repeat(40) }));
  const files = fs.readdirSync(f.directory).sort(); assert.deepEqual(files, ["audit.log", "audit.log.1", "audit.log.2"]);
  for (const file of files) assert.ok(fs.statSync(path.join(f.directory, file)).size <= 100);
  assert.equal(f.read(f.file)[0].index, 9); assert.equal(f.read(f.file + ".1")[0].index, 8);
  assert.equal(f.read(f.file + ".2")[0].index, 7);
});
test("byte limit includes newline and UTF-8, with exact boundary allowed", t => {
  const f = fixture(t); const record = { value: "è" }; const bytes = Buffer.byteLength(JSON.stringify(record) + "\n");
  const writer = f.create({ maxBytes: bytes, maxFiles: 2 });
  writer.emit(record); assert.equal(fs.statSync(f.file).size, bytes);
  writer.emit(record); assert.equal(fs.statSync(f.file + ".1").size, bytes);
});
test("restart resumes rotation, lower retention removes only owned numeric archives", t => {
  const f = fixture(t); const first = f.create({ maxFiles: 5 });
  for (let index = 0; index < 5; index++) first.emit({ index, padding: "x".repeat(40) });
  fs.writeFileSync(f.file + ".backup", "preserve"); fs.writeFileSync(path.join(f.directory, "other.log"), "preserve");
  const restarted = f.create({ maxFiles: 2 }); restarted.emit({ index: 5, padding: "x".repeat(40) });
  assert.equal(f.read(f.file)[0].index, 5); assert.equal(f.read(f.file + ".1")[0].index, 4);
  assert.ok(!fs.existsSync(f.file + ".2")); assert.ok(!fs.existsSync(f.file + ".4"));
  assert.equal(fs.readFileSync(f.file + ".backup", "utf8"), "preserve");
});
test("one-file retention and disabled logging respect bounds without creating disabled file", t => {
  const f = fixture(t); const writer = f.create({ maxFiles: 1 });
  writer.emit({ index: 1, padding: "x".repeat(40) }); writer.emit({ index: 2, padding: "x".repeat(40) });
  assert.deepEqual(fs.readdirSync(f.directory), ["audit.log"]); assert.equal(f.read(f.file)[0].index, 2);
  const disabled = f.create({ enabled: false, file: path.join(f.directory, "disabled", "audit.log") });
  disabled.emit({ event: "ignored" }); assert.ok(!fs.existsSync(path.join(f.directory, "disabled")));
});
test("file failure falls back to stdout, throttles warnings and retries after recovery", t => {
  const f = fixture(t); let clock = 0;
  fs.mkdirSync(f.file); const writer = f.create({ now: () => clock });
  assert.equal(writer.emit({ index: 1 }), false); assert.equal(writer.emit({ index: 2 }), false);
  assert.equal(f.output.length, 2); assert.equal(f.warnings.length, 1);
  fs.rmdirSync(f.file); clock = 1001;
  assert.equal(writer.emit({ index: 3 }), true); assert.equal(f.read(f.file)[0].index, 3);
});
test("oversized records never exceed file cap and hard links are not overwritten", t => {
  const f = fixture(t); const writer = f.create();
  assert.equal(writer.emit({ message: "x".repeat(200) }), false); assert.ok(!fs.existsSync(f.file));
  const target = path.join(f.directory, "preserve.txt"); fs.writeFileSync(target, "preserve");
  fs.linkSync(target, f.file); assert.equal(writer.emit({ index: 1 }), false);
  assert.equal(fs.readFileSync(target, "utf8"), "preserve");
});
test("smaller configured size removes old oversized files and reestablishes cap", t => {
  const f = fixture(t); fs.writeFileSync(f.file, "x".repeat(101)); fs.writeFileSync(f.file + ".1", "x".repeat(101));
  assert.ok(f.create().emit({ index: 1 })); assert.ok(fs.statSync(f.file).size <= 100);
  assert.ok(!fs.existsSync(f.file + ".1"));
});
test("partial disk write is rolled back so subsequent JSON records remain readable", t => {
  const f = fixture(t); let clock = 0; let failing = false; let calls = 0;
  const writer = f.create({ maxBytes: 500, now: () => clock,
    write: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (!failing) return fs.writeSync(fd, buffer, offset, length, position);
      if (++calls === 1) return fs.writeSync(fd, buffer, offset, 3, position);
      throw new Error("simulated disk full");
    } });
  writer.emit({ index: 1 });
  failing = true;
  assert.equal(writer.emit({ index: 2 }), false);
  failing = false;
  clock = 1001; assert.ok(writer.emit({ index: 3 }));
  assert.deepEqual(f.read(f.file).map(e => e.index), [1, 3]);
  assert.equal(JSON.parse(f.output[0]).index, 2);
});
test("env config has bounded defaults and rejects malformed booleans and dimensions", () => {
  const defaults = auditFileFromEnv({}); assert.equal(defaults.maxBytes, 10000000); assert.equal(defaults.maxFiles, 5);
  const custom = auditFileFromEnv({ WEBVIEW_AUDIT_MAX_FILE_MB: "2", WEBVIEW_AUDIT_MAX_FILES: "1", WEBVIEW_AUDIT_ENABLED: "false" });
  assert.equal(custom.maxBytes, 2000000); assert.equal(custom.maxFiles, 1);
  for (const env of [{ WEBVIEW_AUDIT_MAX_FILE_MB: "0" }, { WEBVIEW_AUDIT_MAX_FILES: "2.5" }, { WEBVIEW_AUDIT_ENABLED: "yes" }]) {
    assert.throws(() => auditFileFromEnv(env), /Invalid WEBVIEW_AUDIT/);
  }
});
