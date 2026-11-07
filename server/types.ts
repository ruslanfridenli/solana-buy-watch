export interface TrackedWallet {
  address: string;
  name: string;
}

export interface BuyNotification {
  id: string;
  signature: string;
  walletAddress: string;
  walletName: string;
  mint: string;
  symbol: string;
  tokenName: string;
  tokenAmount: number;
  solAmount: number;
  timestamp: number;
  slot: number;
}

export type ServerMessage =
  | { type: "status"; connected: boolean; walletCount: number; pingMs: number | null }
  | { type: "wallets"; wallets: TrackedWallet[] }
  | { type: "buy"; purchase: BuyNotification }
  | { type: "token-metadata"; mint: string; symbol: string; name: string }
  | { type: "error"; message: string };
