# solana buy watch

a small local app that watches solana wallets and alerts you when they buy tokens.

## run locally

requires node.js 20 or newer.

```bash
npm install
npm run dev
```

open `http://127.0.0.1:5173`, enter an https rpc url from helius, quicknode, or another solana provider, and add wallet addresses. select **enable notifications** to receive browser notifications while the tab is in the background. audio alerts start after you interact with the page.

wallets and the rpc url are saved in this browser's local storage. the backend watches wallet logs with `@solana/web3.js` and reports a buy when an spl token balance increases while sol or wrapped sol is spent. sells, heatmaps, demo transactions, and simulated agents are not included.

use **import csv / json** to import a prepared profile list. each profile needs a solana address (`address`, `walletAddress`, `solanaAddress`, `wallet`, or `publicKey`); `name`/`username`/`handle` and `bio`/`description` are optional. profiles whose bio contains "do not copy trade me" are skipped. the app does not fetch social followers or guess wallet ownership from a profile name.

## project files

```text
server/
  server.ts          # local api and websocket notifications
  walletScanner.ts   # typed solana onLogs transaction scanner
  types.ts           # wallet and buy-event types
src/
  App.tsx            # app interface and purchase notifications
  main.tsx
  styles.css
  types.ts
```

## api

- `put /api/config/rpc` — connect an rpc url.
- `post /api/wallets` — add `{ "address": "...", "name": "insider 1" }`.
- `post /api/wallets/import` — import `{ "profiles": [...] }`; excluded bios and invalid addresses are skipped.
- `delete /api/wallets/:address` — remove a tracked wallet.
- `get /api/wallets`, `get /api/status` — read local server state.
- `ws /live` — connection status, wallet list, and `buy` events.

the scanner uses `connection`, `publickey`, `logs`, and `context` from `@solana/web3.js`. sol spend is estimated from the wallet balance change, excluding the transaction fee; complex swaps may not match the exact quote. the app never asks for a seed phrase or private key and never submits transactions.

## checks and production build

```bash
npm run typecheck
npm run build
npm start
```

`npm start` runs the compiled backend after `npm run build`. vite binds to `127.0.0.1:5173`; the local backend binds to `127.0.0.1:3001`.
