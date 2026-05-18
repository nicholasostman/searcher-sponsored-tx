searcher-sponsored-tx
=====================
Rescue ERC20 tokens or ERC721 NFTs from a compromised wallet using Flashbots sponsored transaction bundles.

The bundle atomically sends ETH from a clean **sponsor** wallet to cover gas, then uses that ETH to transfer assets from the **executor** (compromised) wallet to a **recipient** you control — all in the same block. Because the funding and the transfers are bundled together and submitted privately to Flashbots, sweeper bots monitoring the compromised wallet never get a chance to front-run.

How it works
============
1. Sponsor sends ETH to executor (tx 0 in bundle)
2. Executor calls `safeTransferFrom` / `transfer` for each asset (txs 1–N)
3. The bundle is submitted to the Flashbots relay and retried each block until included

No ETH needs to be on the compromised wallet beforehand. The sponsor's funding arrives and is spent within the same block.

With EIP-1559 active, all transactions pay `baseFee + priorityFee`. The sponsor funds the executor for exactly this amount (with a buffer) before the executor transactions execute.

Setup
=====

### 1. Install dependencies
```
npm install
```

### 2. Get an Ethereum RPC URL

Your script needs an HTTP connection to an Ethereum node to read chain state, estimate gas, and watch for new blocks. You cannot connect to mainnet without one — there is no built-in default.

**Alchemy** (recommended)
1. Sign up at https://alchemy.com
2. Create an app → Ethereum → Mainnet
3. Copy the HTTPS URL: `https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY`

**Infura**
1. Sign up at https://infura.io
2. Create a project → Ethereum Mainnet
3. Copy the endpoint: `https://mainnet.infura.io/v3/YOUR_KEY`

Both are free for the request volumes this script generates.

### 3. Configure environment

Copy `.env.schema` to `.env` and fill in your values:
```
cp .env.schema .env
```

Required variables:

| Variable | Description |
|---|---|
| `PRIVATE_KEY_EXECUTOR` | Private key of the compromised wallet holding the assets |
| `PRIVATE_KEY_SPONSOR` | Private key of a clean wallet with ETH to fund gas |
| `FLASHBOTS_RELAY_SIGNING_KEY` | A separate key for signing Flashbots bundle submissions (see below) |
| `ETHEREUM_RPC_URL` | Your Alchemy or Infura mainnet endpoint |
| `RECIPIENT` | Address that will receive the transferred assets |
| `TRANSFER_MODE` | `ERC20`, `ERC721`, `ERC1155`, or `ERC721+ERC1155` |

For `TRANSFER_MODE=ERC20`, also set:

| Variable | Description |
|---|---|
| `TOKEN_ADDRESS` | Contract address of the ERC20 token to transfer (full balance is moved) |

For `TRANSFER_MODE=ERC721` or `ERC721+ERC1155`, also set:

| Variable | Description |
|---|---|
| `NFT_TRANSFERS` | Comma-separated `contractAddress:tokenId` pairs (see format below) |

For `TRANSFER_MODE=ERC1155` or `ERC721+ERC1155`, also set:

| Variable | Description |
|---|---|
| `ERC1155_TRANSFERS` | Comma-separated `contractAddress:tokenId` pairs (see format below) |

Optional:

| Variable | Default | Description |
|---|---|---|
| `FLASHBOTS_RELAY_URL` | `https://relay.flashbots.net` | Flashbots relay endpoint. Override for Sepolia: `https://relay-sepolia.flashbots.net` |

#### NFT_TRANSFERS format (ERC721)
Tokens from different contracts can be bundled together:
```
NFT_TRANSFERS=0x889E9d7D8A1F00D787AD67B89A386DEA4d5a0bCf:2097,0x11F8a67716f2BEc393763d1e2a1cC6Cc01164D24:510
```

#### ERC1155_TRANSFERS format
Tokens from the same contract are automatically batched into a single `safeBatchTransferFrom` call. The full held balance of each tokenId is transferred:
```
ERC1155_TRANSFERS=0x926c544Fe18865fA3b31CD4B7c3543405aD2e963:1,0x926c544Fe18865fA3b31CD4B7c3543405aD2e963:10,0x926c544Fe18865fA3b31CD4B7c3543405aD2e963:21
```

#### Rescuing both ERC721 and ERC1155 in one bundle
Set `TRANSFER_MODE=ERC721+ERC1155` and populate both `NFT_TRANSFERS` and `ERC1155_TRANSFERS`. All transfers execute atomically in a single Flashbots bundle — one run, one block.

#### Generating a FLASHBOTS_RELAY_SIGNING_KEY
This key is not a wallet holding funds — it is used only to sign bundle submissions and build a reputation score with the Flashbots relay. Generate a fresh one:
```
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
```
See https://docs.flashbots.net/flashbots-auction/searchers/quick-start for more detail.

### 4. Run
```
npm start
```

The script will print a preflight summary — the assets being transferred, both wallet addresses, estimated gas cost in ETH — and ask for confirmation before submitting any bundles.

Setting miner reward
====================
In `src/index.ts`:
```ts
const PRIORITY_GAS_PRICE = GWEI.mul(31)
```

This is the priority fee (on top of `baseFee`) paid to the miner for all transactions in the bundle. All transactions use the same `gasPrice`. In the event of a block reorganisation, the entire bundle re-appears in the next block together, preventing sweeper bots from accessing incoming ETH before it is spent on gas.

Engines
=======
The transfer logic is separated into engine classes under `src/engine/`:

| Engine | Description |
|---|---|
| `TransferERC20` | Transfers the full balance of an ERC20 token |
| `Transfer721` | Transfers specific ERC721 tokens by ID, across multiple contracts |
| `Transfer1155` | Transfers specific ERC1155 tokens by ID; batches tokens per contract into `safeBatchTransferFrom` |
| `CryptoKitties` | Transfers specific CryptoKitties by ID (legacy, pre-ERC721 standard) |

The active engine(s) are selected via `TRANSFER_MODE` in your `.env`. Each engine verifies ownership of the relevant assets before building transactions, aborting cleanly if any asset is not owned by the executor. With `ERC721+ERC1155`, both engines run and their transactions are combined into one bundle.
