import "dotenv/config";
import { loadOrCreateClientIdentity } from "./keys.js";
import { authenticateWebview } from "./webviewAuth.js";

const baseUrl = process.argv[2];
const network = process.argv[3] ?? process.env.IOTA_NETWORK ?? "mainnet";
if (!baseUrl) throw new Error("Usage: npm run auth:webview -- <https://webview-host> [mainnet|testnet|devnet]");
authenticateWebview(baseUrl, network, loadOrCreateClientIdentity().keypair)
  .then(session => process.stdout.write(`${JSON.stringify(session)}\n`))
  .catch(() => { console.error("Webview authentication failed. Check endpoint, network, credentials and server availability."); process.exitCode = 1; });
