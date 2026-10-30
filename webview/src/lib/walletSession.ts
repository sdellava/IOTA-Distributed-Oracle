type Signer = { address: string; sign: (message: Uint8Array) => Promise<{ signature: string }> };
let signer: Signer | undefined;
let generation = 0;
const sessions = new Map<string, { token: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();

export function registerWalletSigner(next?: Signer) {
  generation++;
  signer = next;
  sessions.clear();
  pending.clear();
}
async function checked(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function tokenFor(address: string, network: string) {
  const key = `${address.toLowerCase()}:${network}`;
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now() + 10000) return cached.token;
  if (pending.has(key)) return pending.get(key)!;
  const current = signer;
  const version = generation;
  if (!current || current.address.toLowerCase() !== address.toLowerCase()) throw new Error("Connect the wallet that will submit this task.");
  const promise = (async () => {
    const challenge = await checked(await fetch("/api/auth/challenge", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, network }) }));
    const signed = await current.sign(new TextEncoder().encode(challenge.message));
    if (version !== generation) throw new Error("Wallet or network changed. Retry the operation.");
    const session = await checked(await fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signature: signed.signature }) }));
    if (version !== generation) throw new Error("Wallet or network changed. Retry the operation.");
    sessions.set(key, { token: session.token, expiresAt: session.expiresAt });
    return session.token as string;
  })();
  pending.set(key, promise);
  try { return await promise; }
  finally { if (pending.get(key) === promise) pending.delete(key); }
}

export async function walletPost(url: string, body: { sender: string; network: string; [key: string]: unknown }) {
  const token = await tokenFor(body.sender, body.network);
  const version = generation;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body) });
  if (response.status !== 401) return response;
  sessions.delete(`${body.sender.toLowerCase()}:${body.network}`);
  if (version !== generation) throw new Error("Wallet or network changed. Retry the operation.");
  // A 401 is returned before any preparation side effect, so one retry is safe.
  const refreshed = await tokenFor(body.sender, body.network);
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${refreshed}` }, body: JSON.stringify(body) });
}
