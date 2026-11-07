import { createServer } from "node:http";
import express, { type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import { WebSocket, WebSocketServer } from "ws";
import type { BuyNotification, ServerMessage, TrackedWallet } from "./types.js";
import { WalletScanner } from "./walletScanner.js";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_WALLETS = 100;
const app = express();
const httpServer = createServer(app);
const webSocketServer = new WebSocketServer({ server: httpServer, path: "/live" });

app.use(express.json({ limit: "16kb" }));

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/https?:\/\/\S+/gi, "[RPC URL]");
}

function broadcast(message: ServerMessage): void {
  const serialized = JSON.stringify(message);
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(serialized);
  }
}

const scanner = new WalletScanner(
  (wallets) => broadcast({ type: "wallets", wallets }),
  (purchase: BuyNotification) => broadcast({ type: "buy", purchase }),
  (mint, token) => broadcast({ type: "token-metadata", mint, ...token }),
  (message) => broadcast({ type: "error", message }),
);

function parseWallet(body: unknown): TrackedWallet {
  if (!body || typeof body !== "object") throw new Error("Wallet address is required.");
  const value = body as Record<string, unknown>;
  if (typeof value.address !== "string" || !value.address.trim()) {
    throw new Error("Wallet address is required.");
  }
  const address = new PublicKey(value.address.trim()).toBase58();
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 40) : "";
  return { address, name: name || `Wallet ${address.slice(0, 4)}` };
}

app.get("/api/status", (_request: Request, response: Response) => {
  response.json({ connected: scanner.connected, walletCount: scanner.wallets.length });
});

app.get("/api/wallets", (_request: Request, response: Response) => {
  response.json({ wallets: scanner.wallets });
});

app.post("/api/wallets", async (request: Request, response: Response) => {
  try {
    const wallet = parseWallet(request.body);
    const exists = scanner.wallets.some((entry) => entry.address === wallet.address);
    if (!exists && scanner.wallets.length >= MAX_WALLETS) {
      response.status(400).json({ error: `You can track up to ${MAX_WALLETS} wallets.` });
      return;
    }
    await scanner.addWallet(wallet);
    response.status(exists ? 200 : 201).json({ wallet, wallets: scanner.wallets });
  } catch (error) {
    response.status(400).json({ error: safeErrorMessage(error) });
  }
});

app.post("/api/wallets/import", async (request: Request, response: Response) => {
  const profiles: unknown = request.body?.profiles;
  if (!Array.isArray(profiles)) {
    response.status(400).json({ error: "Profiles must be provided as an array." });
    return;
  }
  if (profiles.length > 500) {
    response.status(400).json({ error: "An import can contain up to 500 profiles." });
    return;
  }

  const additions = new Map<string, TrackedWallet>();
  let excluded = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") {
      invalid += 1;
      continue;
    }
    const entry = profile as Record<string, unknown>;
    const bio = typeof entry.bio === "string" ? entry.bio : typeof entry.description === "string" ? entry.description : "";
    if (/do\s+not\s+copy\s+trade\s+me/i.test(bio)) {
      excluded += 1;
      continue;
    }

    const rawAddress = ["address", "walletAddress", "solanaAddress", "wallet", "publicKey"]
      .map((key) => entry[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!rawAddress) {
      invalid += 1;
      continue;
    }

    try {
      const address = new PublicKey(rawAddress.trim()).toBase58();
      if (scanner.wallets.some((wallet) => wallet.address === address) || additions.has(address)) {
        duplicates += 1;
        continue;
      }
      const profileName = ["name", "username", "handle", "screenName"]
        .map((key) => entry[key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      additions.set(address, { address, name: profileName?.trim().slice(0, 40) || `Wallet ${address.slice(0, 4)}` });
    } catch {
      invalid += 1;
    }
  }

  if (scanner.wallets.length + additions.size > MAX_WALLETS) {
    response.status(400).json({ error: `Import exceeds the ${MAX_WALLETS}-wallet limit. Remove wallets or reduce the import file.` });
    return;
  }

  let added = 0;
  try {
    for (const wallet of additions.values()) {
      await scanner.addWallet(wallet);
      added += 1;
    }
  } catch (error) {
    response.status(502).json({ error: `Import stopped after ${added} wallet${added === 1 ? "" : "s"}: ${safeErrorMessage(error)}`, wallets: scanner.wallets });
    return;
  }
  response.json({ added, excluded, invalid, duplicates, wallets: scanner.wallets });
});

app.delete("/api/wallets/:address", async (request: Request, response: Response) => {
  try {
    const address = request.params.address;
    if (typeof address !== "string") {
      response.status(400).json({ error: "Invalid wallet address." });
      return;
    }
    if (!(await scanner.removeWallet(address))) {
      response.status(404).json({ error: "Wallet not found." });
      return;
    }
    response.json({ wallets: scanner.wallets });
  } catch (error) {
    response.status(400).json({ error: safeErrorMessage(error) });
  }
});

app.put("/api/config/rpc", async (request: Request, response: Response) => {
  const rpcUrl = typeof request.body?.rpcUrl === "string" ? request.body.rpcUrl.trim() : "";
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    response.status(400).json({ error: "Enter a valid RPC URL." });
    return;
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    response.status(400).json({ error: "RPC URL must start with https:// or http://." });
    return;
  }

  try {
    await scanner.setRpcUrl(rpcUrl);
    broadcast({ type: "status", connected: true, walletCount: scanner.wallets.length, pingMs: null });
    response.json({ connected: true, walletCount: scanner.wallets.length });
  } catch (error) {
    const message = safeErrorMessage(error);
    broadcast({ type: "status", connected: false, walletCount: scanner.wallets.length, pingMs: null });
    response.status(502).json({ error: `Could not connect to RPC: ${message}` });
  }
});

webSocketServer.on("connection", (socket) => {
  socket.send(JSON.stringify({
    type: "status",
    connected: scanner.connected,
    walletCount: scanner.wallets.length,
    pingMs: null,
  } satisfies ServerMessage));
  socket.send(JSON.stringify({ type: "wallets", wallets: scanner.wallets } satisfies ServerMessage));
});

const pingTimer = setInterval(() => {
  void scanner.ping()
    .then((pingMs) => broadcast({
      type: "status",
      connected: scanner.connected,
      walletCount: scanner.wallets.length,
      pingMs,
    }))
    .catch(() => broadcast({
      type: "status",
      connected: false,
      walletCount: scanner.wallets.length,
      pingMs: null,
    }));
}, 7000);

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Solana Buy Watch listening on http://127.0.0.1:${PORT}`);
});

async function shutdown(): Promise<void> {
  clearInterval(pingTimer);
  await scanner.close();
  webSocketServer.close();
  httpServer.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
