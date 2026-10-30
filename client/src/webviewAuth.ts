import type { Signer } from "@iota/iota-sdk/cryptography";

// No server-side key is involved: the caller supplies its own local signer.
export async function authenticateWebview(baseUrl: string, network: string, signer: Signer) {
  const base = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.username || base.password || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) {
    throw new Error("Webview authentication requires HTTPS (HTTP is allowed only on loopback).");
  }
  const address = signer.getPublicKey().toIotaAddress();
  async function post(path: string, payload: unknown) {
    const response = await fetch(new URL(path, base), { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  const challenge = await post("/api/auth/challenge", { address, network });
  if (challenge.audience !== base.origin || challenge.address !== address || challenge.network !== network ||
      typeof challenge.message !== "string" || challenge.message.length > 4096 ||
      !challenge.message.startsWith(`IOTA Oracle Webview authentication\nService: ${base.origin}\n`) ||
      challenge.expiresAt <= Date.now()) throw new Error("Invalid Webview authentication challenge.");
  const signed = await signer.signPersonalMessage(new TextEncoder().encode(challenge.message));
  return post("/api/auth/verify", { challengeId: challenge.challengeId, signature: signed.signature }) as Promise<{
    token: string; tokenType: "Bearer"; address: string; network: string; expiresAt: number;
  }>;
}
