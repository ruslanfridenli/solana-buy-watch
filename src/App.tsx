import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellRing, Check, Copy, ExternalLink, Eye, EyeOff, FileUp, Plus, Radio, Trash2, Wallet, X } from "lucide-react";
import type { BuyNotification, ServerMessage, TrackedWallet } from "./types";

const STORAGE_KEY = "solana-buy-watch";
const MAX_BUYS = 100;

interface SavedSettings {
  wallets: TrackedWallet[];
  rpcUrl: string;
}

const defaultSettings: SavedSettings = { wallets: [], rpcUrl: "" };

function readSettings(): SavedSettings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return defaultSettings;
    const value = parsed as Partial<SavedSettings>;
    return {
      wallets: Array.isArray(value.wallets) ? value.wallets : [],
      rpcUrl: typeof value.rpcUrl === "string" ? value.rpcUrl : "",
    };
  } catch {
    return defaultSettings;
  }
}

function short(address: string, start = 6, end = 5): string {
  return address.length > start + end ? `${address.slice(0, start)}…${address.slice(-end)}` : address;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(timestamp);
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("The CSV must include a header row and at least one profile.");
  const aliases: Record<string, string> = {
    walletaddress: "walletAddress",
    solanaaddress: "solanaAddress",
    publickey: "publicKey",
    screenname: "screenName",
  };
  const headers = rows[0].map((header) => {
    const normalized = header.trim().toLowerCase().replace(/[\s_-]/g, "");
    return aliases[normalized] ?? normalized;
  });
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function parseImportFile(text: string, fileName: string): unknown[] {
  if (fileName.toLowerCase().endsWith(".csv")) return parseCsv(text);
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>;
    for (const key of ["wallets", "accounts", "following"]) {
      if (Array.isArray(value[key])) return value[key] as unknown[];
    }
  }
  throw new Error("The JSON file must contain an array of profiles or a wallets/accounts/following array.");
}

function formatNumber(value: number, digits = 3): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export default function App() {
  const [settings, setSettings] = useState<SavedSettings>(readSettings);
  const [wallets, setWallets] = useState<TrackedWallet[]>(settings.wallets);
  const [purchases, setPurchases] = useState<BuyNotification[]>([]);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [importing, setImporting] = useState(false);
  const [rpcUrl, setRpcUrl] = useState(settings.rpcUrl);
  const [showRpc, setShowRpc] = useState(false);
  const [connected, setConnected] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [browserNotifications, setBrowserNotifications] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const [notice, setNotice] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const settingsRef = useRef(settings);
  const restoreRef = useRef<() => Promise<void>>(async () => undefined);
  settingsRef.current = settings;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const playSound = useCallback(() => {
    try {
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      if (context.state === "suspended") void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(980, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1420, context.currentTime + 0.1);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.23);
    } catch (error) {
      console.warn("Audio notification unavailable:", error);
    }
  }, []);

  const handlePurchase = useCallback((purchase: BuyNotification) => {
    setPurchases((current) => [purchase, ...current].slice(0, MAX_BUYS));
    setNotice(`${purchase.walletName} bought ${purchase.symbol}`);
    playSound();
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notification = new Notification(`${purchase.symbol} purchase`, {
        body: `${purchase.walletName} · ${formatNumber(purchase.solAmount, 4)} SOL`,
        tag: purchase.id,
      });
      notification.onclick = () => window.open(`https://solscan.io/tx/${purchase.signature}`, "_blank", "noopener,noreferrer");
    }
  }, [playSound]);

  const connectSocket = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}/live`);
    socketRef.current = socket;
    socket.onopen = () => {
      setSocketConnected(true);
      void restoreRef.current();
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        switch (message.type) {
          case "status":
            setConnected(message.connected);
            setPingMs(message.pingMs);
            break;
          case "wallets":
            setWallets(message.wallets);
            break;
          case "buy":
            handlePurchase(message.purchase);
            break;
          case "token-metadata":
            setPurchases((current) => current.map((purchase) => purchase.mint === message.mint
              ? { ...purchase, symbol: message.symbol, tokenName: message.name }
              : purchase));
            break;
          case "error":
            setNotice(message.message);
            break;
        }
      } catch (error) {
        console.warn("Invalid live message:", error);
      }
    };
    socket.onclose = () => {
      setSocketConnected(false);
      setConnected(false);
      reconnectRef.current = window.setTimeout(connectSocket, 1800);
    };
    socket.onerror = () => socket.close();
  }, [handlePurchase]);

  restoreRef.current = async () => {
    const current = settingsRef.current;
    try {
      if (current.rpcUrl.trim()) {
        await requestJson("/api/config/rpc", {
          method: "PUT",
          body: JSON.stringify({ rpcUrl: current.rpcUrl }),
        });
      }
      for (const wallet of current.wallets) {
        await requestJson("/api/wallets", { method: "POST", body: JSON.stringify(wallet) });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not restore settings.");
    }
  };

  useEffect(() => {
    connectSocket();
    return () => {
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
      const socket = socketRef.current;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      void audioContextRef.current?.close();
    };
  }, [connectSocket]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const addWallet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const wallet = { address: address.trim(), name: name.trim() || `Wallet ${wallets.length + 1}` };
      const result = await requestJson<{ wallets: TrackedWallet[] }>("/api/wallets", {
        method: "POST",
        body: JSON.stringify(wallet),
      });
      setWallets(result.wallets);
      setSettings((current) => ({ ...current, wallets: result.wallets }));
      setAddress("");
      setName("");
      setNotice(`Wallet ${short(wallet.address)} added`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add wallet.");
    }
  };

  const importWallets = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const profiles = parseImportFile(await file.text(), file.name);
      const result = await requestJson<{
        added: number;
        excluded: number;
        invalid: number;
        duplicates: number;
        wallets: TrackedWallet[];
      }>("/api/wallets/import", {
        method: "POST",
        body: JSON.stringify({ profiles }),
      });
      setWallets(result.wallets);
      setSettings((current) => ({ ...current, wallets: result.wallets }));
      setNotice(`Imported ${result.added} wallet${result.added === 1 ? "" : "s"} · ${result.excluded} excluded · ${result.invalid} invalid · ${result.duplicates} duplicate`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not import profiles.");
    } finally {
      setImporting(false);
    }
  };

  const removeWallet = async (wallet: TrackedWallet) => {
    try {
      const result = await requestJson<{ wallets: TrackedWallet[] }>(`/api/wallets/${encodeURIComponent(wallet.address)}`, { method: "DELETE" });
      setWallets(result.wallets);
      setSettings((current) => ({ ...current, wallets: result.wallets }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove wallet.");
    }
  };

  const connectRpc = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await requestJson("/api/config/rpc", {
        method: "PUT",
        body: JSON.stringify({ rpcUrl: rpcUrl.trim() }),
      });
      setSettings((current) => ({ ...current, rpcUrl: rpcUrl.trim() }));
      setConnected(true);
      setNotice("Connected to Solana RPC");
    } catch (error) {
      setConnected(false);
      setNotice(error instanceof Error ? error.message : "Could not connect to RPC.");
    }
  };

  const enableBrowserNotifications = async () => {
    if (typeof Notification === "undefined") {
      setNotice("This browser does not support notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    setBrowserNotifications(permission === "granted");
    setNotice(permission === "granted" ? "Purchase notifications enabled" : "Allow notifications in your browser");
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied`);
    } catch {
      setNotice("Clipboard access was denied by the browser.");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Solana Buy Watch home">
          <span className="brand-mark"><Radio size={18} /></span>
          <span><b>Solana Buy Watch</b><small>Wallet purchase alerts</small></span>
        </a>
        <div className="topbar-status">
          <span className={`status-dot ${connected ? "online" : ""}`} />
          <span>{connected ? "Connected to Solana" : "Not connected"}</span>
          <i />
          <span className="ping">{pingMs === null ? "— ms" : `${pingMs} ms`}</span>
        </div>
        <button className={`notification-setting ${browserNotifications ? "active" : ""}`} onClick={() => void enableBrowserNotifications()}>
          {browserNotifications ? <BellRing size={15} /> : <Bell size={15} />}
          <span>{browserNotifications ? "Notifications enabled" : "Enable notifications"}</span>
        </button>
      </header>

      <div className="page">
        <section className="page-heading">
          <div>
            <p className="eyebrow">SOLANA · WALLET MONITOR</p>
            <h1>Tracked wallet purchases</h1>
            <p className="intro">Add a wallet address and get notified when it buys a token.</p>
          </div>
          <div className="connection-indicator"><span className={`status-dot ${socketConnected ? "online" : ""}`} /> LIVE</div>
        </section>

        <div className="content-grid">
          <aside className="sidebar">
            <section className="card">
              <div className="card-heading"><div><h2>Connection</h2><p>Solana RPC provider</p></div><span className="card-icon"><Radio size={16} /></span></div>
              <form onSubmit={(event) => void connectRpc(event)}>
                <label className="label" htmlFor="rpc-url">RPC URL</label>
                <div className="input-with-action"><input id="rpc-url" type={showRpc ? "text" : "password"} value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} placeholder="https://mainnet.helius-rpc.com/…" autoComplete="off" /><button type="button" onClick={() => setShowRpc((current) => !current)} aria-label={showRpc ? "Hide RPC URL" : "Show RPC URL"}>{showRpc ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>
                <button className="primary-button connect-button" type="submit">{connected ? <Check size={15} /> : <Radio size={15} />}{connected ? "Connected" : "Connect RPC"}</button>
              </form>
              <p className="private-note">Your URL is stored locally on this device.</p>
            </section>

            <section className="card wallet-card">
              <div className="card-heading"><div><h2>Wallets</h2><p>Watching for purchases</p></div><span className="wallet-count">{wallets.length}/100</span></div>
              <form className="wallet-form" onSubmit={(event) => void addWallet(event)}>
                <label className="label" htmlFor="wallet-address">Solana address</label>
                <input id="wallet-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Paste a wallet address" spellCheck={false} required />
                <label className="label" htmlFor="wallet-name">Name <span>optional</span></label>
                <input id="wallet-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="For example, Insider 1" maxLength={40} />
                <button className="primary-button" type="submit"><Plus size={16} /> Add wallet</button>
              </form>
              <input ref={importFileRef} className="file-input-hidden" type="file" accept=".csv,.json,application/json,text/csv" onChange={(event) => void importWallets(event)} />
              <button className="import-button" type="button" onClick={() => importFileRef.current?.click()} disabled={importing}>
                <FileUp size={14} /> {importing ? "Importing…" : "Import CSV / JSON"}
              </button>
              <p className="import-note">Requires a Solana address per profile. “Do not copy trade me” profiles are skipped.</p>
              <div className="wallet-list">
                {wallets.length === 0 ? <div className="empty-wallets"><Wallet size={19} /><span>No wallets yet</span><small>Add an address to start tracking.</small></div> : wallets.map((wallet) => <div className="wallet-row" key={wallet.address}>
                  <div className="wallet-avatar">{wallet.name.slice(0, 1).toUpperCase()}</div>
                  <div className="wallet-info"><b>{wallet.name}</b><span>{short(wallet.address)}</span></div>
                  <button className="remove-button" onClick={() => void removeWallet(wallet)} aria-label={`Remove ${wallet.name}`} title="Remove"><Trash2 size={15} /></button>
                </div>)}
              </div>
            </section>
          </aside>

          <section className="card purchases-card">
            <div className="purchases-heading">
              <div><h2>Purchases</h2><p>New buys will appear here automatically</p></div>
              <span className="purchase-count">{purchases.length} {purchases.length === 1 ? "purchase" : "purchases"}</span>
            </div>
            <div className="purchase-list">
              {purchases.length === 0 ? <div className="empty-purchases">
                <div className="empty-icon"><Bell size={20} /></div>
                <h3>Waiting for the first purchase</h3>
                <p>When a tracked wallet buys a token, it will appear here and you will get a notification.</p>
                {!connected && <span className="setup-hint">Connect your RPC and add a wallet to get started.</span>}
              </div> : purchases.map((purchase) => <PurchaseCard key={purchase.id} purchase={purchase} onCopy={copy} />)}
            </div>
          </section>
        </div>
        <footer className="footer"><span>Solana Buy Watch</span><span>Purchase tracking · stored locally</span></footer>
      </div>
      {notice && <div className="toast"><Check size={15} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Close"><X size={14} /></button></div>}
    </main>
  );
}

function PurchaseCard({ purchase, onCopy }: { purchase: BuyNotification; onCopy: (value: string, label: string) => void }) {
  return <article className="purchase-item">
    <div className="purchase-indicator"><Check size={17} /></div>
    <div className="purchase-content">
      <div className="purchase-top"><span className="buy-label">BUY</span><time>{formatTime(purchase.timestamp)}</time></div>
      <h3>{purchase.walletName} bought {purchase.tokenName}</h3>
      <div className="purchase-meta"><span className="token-symbol">${purchase.symbol}</span><span className="meta-separator">·</span><span>{formatNumber(purchase.solAmount, 4)} SOL</span><span className="meta-separator">·</span><span>{formatNumber(purchase.tokenAmount, 2)} tokens</span></div>
      <div className="purchase-address"><span>CA</span><code>{short(purchase.mint, 9, 8)}</code><button onClick={() => void onCopy(purchase.mint, "Contract address")} aria-label="Copy contract address"><Copy size={13} /></button></div>
      <div className="purchase-bottom"><button className="wallet-address" onClick={() => void onCopy(purchase.walletAddress, "Wallet address")}><Wallet size={13} />{short(purchase.walletAddress)}<Copy size={11} /></button><a href={`https://solscan.io/tx/${purchase.signature}`} target="_blank" rel="noreferrer">Transaction <ExternalLink size={12} /></a></div>
    </div>
  </article>;
}
