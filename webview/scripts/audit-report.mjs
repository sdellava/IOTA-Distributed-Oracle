import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

export function summarizeAudit(lines) {
  const summary = { schema: "oracle.audit-report.v1", coverage: "Only events present in the supplied logs; absence is not evidence of absence of abuse.",
    events: 0, ignoredLines: 0, first: null, last: null, statuses: {}, routes: {}, codes: {}, authenticatedWallets: 0 };
  const wallets = new Set();
  for (const line of lines) {
    try {
      const start = line.indexOf("{"); if (line.length > 65536 || start < 0) throw new Error();
      let entry = JSON.parse(line.slice(start));
      if (typeof entry.log === "string") entry = JSON.parse(entry.log.trim());
      if (entry.schema !== "oracle.audit.v1" || entry.event !== "http_request" ||
          !Number.isFinite(Date.parse(entry.timestamp)) || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599 ||
          typeof entry.route !== "string" || !/^\/api\/[a-zA-Z0-9_:/-]{1,120}$/.test(entry.route)) throw new Error();
      summary.events++;
      if (!summary.first || entry.timestamp < summary.first) summary.first = entry.timestamp;
      if (!summary.last || entry.timestamp > summary.last) summary.last = entry.timestamp;
      summary.statuses[entry.status] = (summary.statuses[entry.status] ?? 0) + 1;
      summary.routes[entry.route] = (summary.routes[entry.route] ?? 0) + 1;
      if (typeof entry.code === "string" && /^[A-Z_0-9]{1,64}$/.test(entry.code)) summary.codes[entry.code] = (summary.codes[entry.code] ?? 0) + 1;
      if (typeof entry.wallet === "string" && /^0x[0-9a-f]{64}$/.test(entry.wallet)) wallets.add(entry.wallet);
    } catch { summary.ignoredLines++; }
  }
  summary.authenticatedWallets = wallets.size;
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2] ? fs.createReadStream(process.argv[2], { encoding: "utf8" }) : process.stdin;
  const lines = []; let bytes = 0;
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      bytes += Buffer.byteLength(line); if (bytes > 256000000) throw new Error("Input exceeds 256 MB; split the export by date.");
      lines.push(line);
    }
    console.log(JSON.stringify(summarizeAudit(lines), null, 2));
  } catch { console.error("Cannot analyze audit input (missing file or input over 256 MB). Split large exports by date."); process.exitCode = 1; }
}
