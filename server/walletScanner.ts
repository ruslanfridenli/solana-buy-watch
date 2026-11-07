import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { Context, Logs } from "@solana/web3.js";
import type { BuyNotification, TrackedWallet } from "./types.js";

type WalletUpdate = (wallets: TrackedWallet[]) => void;
type BuyHandler = (purchase: BuyNotification) => void;
type TokenMetadataHandler = (mint: string, token: TokenName) => void;
type TokenName = { symbol: string; name: string };
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(/https?:\/\/\S+/gi, "[RPC endpoint]");
}

export class WalletScanner {
  private connection: Connection | null = null;
  private readonly subscriptions = new Map<string, number>();
  private readonly tracked = new Map<string, TrackedWallet>();
  private readonly metadataCache = new Map<string, { value: TokenName; expiresAt: number }>();
  private readonly pendingMetadata = new Set<string>();

  constructor(
    private readonly onWalletsChanged: WalletUpdate,
    private readonly onBuy: BuyHandler,
    private readonly onTokenMetadata: TokenMetadataHandler,
    private readonly onError: (message: string) => void,
  ) {}

  get wallets(): TrackedWallet[] {
    return [...this.tracked.values()];
  }

  get connected(): boolean {
    return this.connection !== null;
  }

  async setRpcUrl(rpcUrl: string): Promise<void> {
    const nextConnection = new Connection(rpcUrl, { commitment: "confirmed" });
    await nextConnection.getVersion();

    const nextSubscriptions = new Map<string, number>();
    try {
      for (const address of this.tracked.keys()) {
        nextSubscriptions.set(address, await this.subscribe(nextConnection, address));
      }
    } catch (error) {
      await Promise.allSettled(
        [...nextSubscriptions.values()].map((id) => nextConnection.removeOnLogsListener(id)),
      );
      throw error;
    }

    const oldConnection = this.connection;
    const oldSubscriptions = [...this.subscriptions.values()];
    this.connection = nextConnection;
    this.subscriptions.clear();
    for (const [address, id] of nextSubscriptions) this.subscriptions.set(address, id);
    if (oldConnection) {
      await Promise.allSettled(oldSubscriptions.map((id) => oldConnection.removeOnLogsListener(id)));
    }
  }

  async addWallet(wallet: TrackedWallet): Promise<void> {
    const address = new PublicKey(wallet.address).toBase58();
    const normalized = { ...wallet, address };
    if (this.tracked.has(address)) {
      this.tracked.set(address, normalized);
      this.onWalletsChanged(this.wallets);
      return;
    }
    this.tracked.set(address, normalized);
    try {
      if (this.connection) {
        const subscriptionId = await this.subscribe(this.connection, address);
        this.subscriptions.set(address, subscriptionId);
      }
      this.onWalletsChanged(this.wallets);
    } catch (error) {
      this.tracked.delete(address);
      throw error;
    }
  }

  async removeWallet(address: string): Promise<boolean> {
    const normalizedAddress = new PublicKey(address).toBase58();
    if (!this.tracked.has(normalizedAddress)) return false;
    const subscriptionId = this.subscriptions.get(normalizedAddress);
    if (subscriptionId !== undefined && this.connection) {
      await this.connection.removeOnLogsListener(subscriptionId);
    }
    this.tracked.delete(normalizedAddress);
    this.subscriptions.delete(normalizedAddress);
    this.onWalletsChanged(this.wallets);
    return true;
  }

  async ping(): Promise<number | null> {
    if (!this.connection) return null;
    const started = performance.now();
    await this.connection.getSlot("processed");
    return Math.round(performance.now() - started);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      await Promise.allSettled(
        [...this.subscriptions.values()].map((id) => connection.removeOnLogsListener(id)),
      );
    }
    this.subscriptions.clear();
  }

  private async subscribe(connection: Connection, address: string): Promise<number> {
    return connection.onLogs(
      new PublicKey(address),
      (logs: Logs, context: Context) => {
        if (logs.err) {
          return;
        }
        void this.processTransaction(connection, address, logs, context);
      },
      "confirmed",
    );
  }

  private async processTransaction(
    source: Connection,
    address: string,
    logs: Logs,
    context: Context,
  ): Promise<void> {
    try {
      let parsed: ParsedTransactionWithMeta | null = null;
      for (let attempt = 0; attempt < 3 && !parsed; attempt += 1) {
        parsed = await source.getParsedTransaction(logs.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!parsed && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (source !== this.connection || !parsed?.meta || parsed.meta.err) return;

      const { accountKeys } = parsed.transaction.message;
      const accountIndex = accountKeys.findIndex((key) => key.pubkey.toBase58() === address);
      if (accountIndex < 0) return;
      const preLamports = parsed.meta.preBalances[accountIndex];
      const postLamports = parsed.meta.postBalances[accountIndex];
      if (preLamports === undefined || postLamports === undefined) return;
      const solDelta = (postLamports - preLamports) / LAMPORTS_PER_SOL;
      const feeSol = parsed.meta.fee / LAMPORTS_PER_SOL;
      const preTokens = parsed.meta.preTokenBalances ?? [];
      const postTokens = parsed.meta.postTokenBalances ?? [];
      const before = new Map(
        preTokens.filter((balance) => balance.owner === address).map((balance) => [balance.mint, Number(balance.uiTokenAmount.uiAmountString ?? 0)]),
      );
      const after = new Map(
        postTokens.filter((balance) => balance.owner === address).map((balance) => [balance.mint, Number(balance.uiTokenAmount.uiAmountString ?? 0)]),
      );
      const mints = new Set([...before.keys(), ...after.keys()]);
      const wrappedSolSpent = Math.max(0, (before.get(WRAPPED_SOL_MINT) ?? 0) - (after.get(WRAPPED_SOL_MINT) ?? 0));
      const nativeSolSpent = Math.max(0, -solDelta - feeSol);
      const solAmount = Math.max(nativeSolSpent, wrappedSolSpent);
      if (solAmount < 0.0001) return;

      for (const mint of mints) {
        const tokenDelta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0);
        if (mint === WRAPPED_SOL_MINT || !Number.isFinite(tokenDelta) || tokenDelta <= 0) continue;
        const wallet = this.tracked.get(address);
        if (!wallet) return;
        const token = this.metadataCache.get(mint)?.value ?? { symbol: `${mint.slice(0, 4)}…`, name: "Unknown token" };
        const purchase: BuyNotification = {
          id: `${logs.signature}-${mint}`,
          signature: logs.signature,
          walletAddress: address,
          walletName: wallet.name,
          mint,
          symbol: token.symbol,
          tokenName: token.name,
          tokenAmount: tokenDelta,
          solAmount,
          timestamp: (parsed.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
          slot: context.slot,
        };
        this.onBuy(purchase);
        if (!this.pendingMetadata.has(mint)) {
          this.pendingMetadata.add(mint);
          void this.resolveToken(mint)
            .then((metadata) => {
              if (metadata.name !== "Unknown token") this.onTokenMetadata(mint, metadata);
            })
            .finally(() => this.pendingMetadata.delete(mint));
        }
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      this.onError(`Could not parse transaction ${logs.signature.slice(0, 10)}…: ${message}`);
    }
  }

  private async resolveToken(mint: string): Promise<TokenName> {
    const cached = this.metadataCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(3500),
      });
      if (response.ok) {
        const result = await response.json() as {
          pairs?: Array<{
            chainId?: string;
            liquidity?: { usd?: number };
            baseToken?: { address: string; name: string; symbol: string };
            quoteToken?: { address: string; name: string; symbol: string };
          }>;
        };
        const pair = (result.pairs ?? [])
          .filter((entry) => entry.chainId === "solana")
          .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))
          .find((entry) => entry.baseToken?.address === mint || entry.quoteToken?.address === mint);
        const token = pair?.baseToken?.address === mint ? pair.baseToken : pair?.quoteToken;
        if (token) {
          const value = { symbol: token.symbol, name: token.name };
          this.metadataCache.set(mint, { value, expiresAt: Date.now() + 30 * 60_000 });
          return value;
        }
      }
    } catch {
      // Metadata is optional; the mint-derived fallback remains usable.
    }
    const fallback = { symbol: `${mint.slice(0, 4)}…`, name: "Unknown token" };
    this.metadataCache.set(mint, { value: fallback, expiresAt: Date.now() + 60_000 });
    return fallback;
  }
}
