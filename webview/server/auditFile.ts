import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

type AuditOptions = {
  enabled: boolean; file: string; maxBytes: number; maxFiles: number; stdout?: boolean;
  output?: (line: string) => void; warning?: (message: string) => void; now?: () => number;
  write?: (fd: number, data: Buffer, offset: number, length: number, position: number) => number;
};

// One writer process per file. Synchronous, bounded records avoid an unbounded
// in-memory queue and serialize rotation with appends in the Node event loop.
export function createAuditFile(options: AuditOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 ||
      !Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 100) throw new Error("Invalid audit file limits");
  const file = path.resolve(options.file);
  const directory = path.dirname(file); const basename = path.basename(file);
  const output = options.output ?? (line => console.log(line));
  const warning = options.warning ?? (message => console.error(message));
  const now = options.now ?? Date.now;
  let initialized = false; let retryAt = 0; let lastWarning = -Infinity;
  function regular(target: string): number | undefined {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe audit file");
      return stat.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  function remove(target: string) { if (regular(target) !== undefined) fs.unlinkSync(target); }
  function initialize() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Only this logger's exact numeric archive names are eligible for removal.
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(basename + ".")) continue;
      const suffix = name.slice(basename.length + 1);
      if (!/^[1-9]\d*$/.test(suffix)) continue;
      const target = path.join(directory, name); const size = regular(target)!;
      if (Number(suffix) >= options.maxFiles || size > options.maxBytes) remove(target);
    }
    // A lowered size budget must also apply to an existing oversized current file.
    if ((regular(file) ?? 0) > options.maxBytes) remove(file);
    initialized = true;
  }
  function rotate() {
    if (options.maxFiles === 1) { remove(file); return; }
    remove(`${file}.${options.maxFiles - 1}`);
    for (let index = options.maxFiles - 2; index >= 1; index--) {
      const source = `${file}.${index}`; const destination = `${file}.${index + 1}`;
      regular(destination);
      if (regular(source) !== undefined) fs.renameSync(source, destination);
    }
    regular(`${file}.1`);
    if (regular(file) !== undefined) fs.renameSync(file, `${file}.1`);
  }
  function report(message: string) {
    if (now() - lastWarning >= 60000) { lastWarning = now(); warning(message); }
  }
  function emit(entry: object): boolean {
    if (!options.enabled) return true;
    const line = JSON.stringify(entry); const record = Buffer.from(line + "\n", "utf8");
    if (record.length > options.maxBytes) {
      report("[audit] AUDIT_RECORD_TOO_LARGE; record forwarded to stdout only."); output(line); return false;
    }
    if (options.stdout !== false) output(line);
    try {
      if (now() < retryAt) throw new Error("Audit file retry pending");
      if (!initialized) initialize();
      if ((regular(file) ?? 0) + record.length > options.maxBytes) rotate();
      // Read/write access also permits rolling back a failed partial write on Windows.
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
      let size: number | undefined;
      try {
        size = fs.fstatSync(fd).size;
        let written = 0;
        while (written < record.length) {
          const count = (options.write ?? fs.writeSync)(fd, record, written, record.length - written, size + written);
          if (!count) throw new Error("Incomplete audit write");
          written += count;
        }
      } catch (error) { if (size !== undefined) try { fs.ftruncateSync(fd, size); } catch {} throw error; }
      finally { fs.closeSync(fd); }
      retryAt = 0;
      return true;
    } catch {
      // Preserve API availability and the event on stdout if disk/permissions fail.
      if (options.stdout === false) output(line);
      report("[audit] AUDIT_FILE_UNAVAILABLE; events forwarded to stdout; retrying file output.");
      if (now() >= retryAt) retryAt = now() + 1000;
      initialized = false;
      return false;
    }
  }
  return { emit, file, maxBytes: options.maxBytes, maxFiles: options.maxFiles };
}

export function auditFileFromEnv(env: NodeJS.ProcessEnv = process.env) {
  function flag(name: string, fallback: boolean) {
    const text = env[name]?.trim(); if (!text) return fallback;
    if (text !== "true" && text !== "false") throw new Error(`Invalid ${name}`);
    return text === "true";
  }
  const enabled = flag("WEBVIEW_AUDIT_ENABLED", true);
  function integer(name: string, fallback: number, max: number) {
    const text = env[name]?.trim(); const value = text ? Number(text) : fallback;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  return createAuditFile({ enabled, file: env.WEBVIEW_AUDIT_FILE?.trim() || "./logs/audit.log",
    maxBytes: integer("WEBVIEW_AUDIT_MAX_FILE_MB", 10, 1024) * 1000000,
    maxFiles: integer("WEBVIEW_AUDIT_MAX_FILES", 5, 100), stdout: flag("WEBVIEW_AUDIT_STDOUT", true) });
}
