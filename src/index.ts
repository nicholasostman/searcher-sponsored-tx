import * as dotenv from "dotenv";
dotenv.config();

import {
  FlashbotsBundleProvider, FlashbotsBundleRawTransaction,
  FlashbotsBundleResolution,
  FlashbotsBundleTransaction
} from "@flashbots/ethers-provider-bundle";
import { BigNumber, providers, Wallet, utils } from "ethers";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import * as readline from "readline";
import { Base } from "./engine/Base";
import { checkSimulation, gasPriceToGwei } from "./utils";
import { Transfer721 } from "./engine/Transfer721";
import { TransferERC20 } from "./engine/TransferERC20";
import { Transfer1155 } from "./engine/Transfer1155";

require('log-timestamp');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

const BLOCKS_IN_FUTURE = 2;

const GWEI = BigNumber.from(10).pow(9);
const PRIORITY_FEE_GWEI = parseInt(process.env.PRIORITY_FEE_GWEI || "5", 10);
const PRIORITY_GAS_PRICE = GWEI.mul(PRIORITY_FEE_GWEI)

const PRIVATE_KEY_EXECUTOR = process.env.PRIVATE_KEY_EXECUTOR || ""
const PRIVATE_KEY_SPONSOR = process.env.PRIVATE_KEY_SPONSOR || ""
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || "";
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || ""
const FLASHBOTS_RELAY_URL = process.env.FLASHBOTS_RELAY_URL || "https://relay.flashbots.net"
const RECIPIENT = process.env.RECIPIENT || ""
const TRANSFER_MODE = (process.env.TRANSFER_MODE || "").toUpperCase()
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || ""

function parseTransferList(envVar: string, label: string) {
  return (envVar || "")
    .split(",")
    .filter(Boolean)
    .map(entry => {
      const [contractAddress, tokenId] = entry.trim().split(":")
      if (!contractAddress || !tokenId) throw new Error(`Invalid ${label} entry: "${entry}" — expected contractAddress:tokenId`)
      return { contractAddress, tokenId: Number(tokenId) }
    })
}

const NFT_TRANSFERS = parseTransferList(process.env.NFT_TRANSFERS || "", "NFT_TRANSFERS")
const ERC1155_TRANSFERS = parseTransferList(process.env.ERC1155_TRANSFERS || "", "ERC1155_TRANSFERS")

if (PRIVATE_KEY_EXECUTOR === "") {
  console.error("Must provide PRIVATE_KEY_EXECUTOR: private key of the wallet holding the assets")
  process.exit(1)
}
if (PRIVATE_KEY_SPONSOR === "") {
  console.error("Must provide PRIVATE_KEY_SPONSOR: private key of the wallet funding gas")
  process.exit(1)
}
if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.error("Must provide FLASHBOTS_RELAY_SIGNING_KEY: see https://github.com/flashbots/pm/blob/main/guides/flashbots-alpha.md")
  process.exit(1)
}
if (ETHEREUM_RPC_URL === "") {
  console.error("Must provide ETHEREUM_RPC_URL: e.g. https://mainnet.infura.io/v3/YOUR_KEY or https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY")
  process.exit(1)
}
if (RECIPIENT === "") {
  console.error("Must provide RECIPIENT: destination address for transferred assets")
  process.exit(1)
}
if (!["ERC20", "ERC721", "ERC1155", "ERC721+ERC1155"].includes(TRANSFER_MODE)) {
  console.error("Must provide TRANSFER_MODE: ERC20, ERC721, ERC1155, or ERC721+ERC1155")
  process.exit(1)
}
if (TRANSFER_MODE === "ERC20" && TOKEN_ADDRESS === "") {
  console.error("TRANSFER_MODE=ERC20 requires TOKEN_ADDRESS: the ERC20 contract address")
  process.exit(1)
}
if ((TRANSFER_MODE === "ERC721" || TRANSFER_MODE === "ERC721+ERC1155") && NFT_TRANSFERS.length === 0) {
  console.error("TRANSFER_MODE=ERC721 or ERC721+ERC1155 requires NFT_TRANSFERS: comma-separated contractAddress:tokenId pairs")
  process.exit(1)
}
if ((TRANSFER_MODE === "ERC1155" || TRANSFER_MODE === "ERC721+ERC1155") && ERC1155_TRANSFERS.length === 0) {
  console.error("TRANSFER_MODE=ERC1155 or ERC721+ERC1155 requires ERC1155_TRANSFERS: comma-separated contractAddress:tokenId pairs")
  process.exit(1)
}

async function main() {
  const walletRelay = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY)
  const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
  const { chainId } = await provider.getNetwork();
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, walletRelay, FLASHBOTS_RELAY_URL);

  const walletExecutor = new Wallet(PRIVATE_KEY_EXECUTOR, provider);
  const walletSponsor = new Wallet(PRIVATE_KEY_SPONSOR, provider);

  let engines: Base[];
  if (TRANSFER_MODE === "ERC20") {
    engines = [new TransferERC20(provider, walletExecutor.address, RECIPIENT, TOKEN_ADDRESS)];
  } else if (TRANSFER_MODE === "ERC721") {
    engines = [new Transfer721(provider, walletExecutor.address, RECIPIENT, NFT_TRANSFERS)];
  } else if (TRANSFER_MODE === "ERC1155") {
    engines = [new Transfer1155(provider, walletExecutor.address, RECIPIENT, ERC1155_TRANSFERS)];
  } else {
    // ERC721+ERC1155
    engines = [
      new Transfer721(provider, walletExecutor.address, RECIPIENT, NFT_TRANSFERS),
      new Transfer1155(provider, walletExecutor.address, RECIPIENT, ERC1155_TRANSFERS),
    ];
  }

  const sponsoredTransactions: TransactionRequest[] = ([] as TransactionRequest[]).concat(
    ...(await Promise.all(engines.map(e => e.getSponsoredTransactions())))
  );

  const gasEstimates = await Promise.all(sponsoredTransactions.map(tx =>
    provider.estimateGas({
      ...tx,
      from: tx.from === undefined ? walletExecutor.address : tx.from
    }))
  )
  const gasEstimateTotal = gasEstimates.reduce((acc, cur) => acc.add(cur), BigNumber.from(0))

  const currentBlock = await provider.getBlock("latest");
  const estimatedGasPrice = PRIORITY_GAS_PRICE.add(currentBlock.baseFeePerGas || 0);
  // Sponsor pays: value sent to executor + gas for the sponsor's own ETH transfer tx
  const estimatedSponsorCost = gasEstimateTotal.add(21000).mul(estimatedGasPrice);

  console.log(`\n${"=".repeat(60)}`)
  for (const engine of engines) {
    console.log(await engine.description())
  }
  console.log(`${"=".repeat(60)}`)
  console.log(`Executor Account : ${walletExecutor.address}`)
  console.log(`Sponsor Account  : ${walletSponsor.address}`)
  console.log(`Recipient        : ${RECIPIENT}`)
  console.log(`Current base fee : ${gasPriceToGwei(currentBlock.baseFeePerGas || BigNumber.from(0))} gwei`)
  console.log(`Gas price (est)  : ${gasPriceToGwei(estimatedGasPrice)} gwei`)
  console.log(`Gas units (est)  : ${gasEstimateTotal.toString()}`)
  console.log(`Sponsor cost (est): ${utils.formatEther(estimatedSponsorCost)} ETH`)
  console.log(`${"=".repeat(60)}\n`)

  const AUTO_CONFIRM_BELOW = utils.parseEther("0.005")
  if (estimatedSponsorCost.gt(AUTO_CONFIRM_BELOW)) {
    const answer = await prompt("Proceed? [y/N] ")
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.")
      process.exit(0)
    }
  }

  const blockListener = async (blockNumber: number) => {
    const block = await provider.getBlock(blockNumber);
    const baseFee = block.baseFeePerGas || BigNumber.from(0);
    const maxFeePerGas = baseFee.mul(2).add(PRIORITY_GAS_PRICE);

    const bundleTransactions: Array<FlashbotsBundleTransaction | FlashbotsBundleRawTransaction> = [
      {
        transaction: {
          to: walletExecutor.address,
          type: 2,
          chainId,
          maxFeePerGas,
          maxPriorityFeePerGas: PRIORITY_GAS_PRICE,
          value: gasEstimateTotal.mul(baseFee.add(PRIORITY_GAS_PRICE)),
          gasLimit: 21000,
        },
        signer: walletSponsor
      },
      ...sponsoredTransactions.map((transaction, txNumber) => {
        const { gasPrice: _, type: __, ...txData } = transaction as any;
        return {
          transaction: {
            ...txData,
            type: 2,
            chainId,
            maxFeePerGas,
            maxPriorityFeePerGas: PRIORITY_GAS_PRICE,
            gasLimit: gasEstimates[txNumber],
          },
          signer: walletExecutor,
        }
      })
    ]
    const signedBundle = await flashbotsProvider.signBundle(bundleTransactions)
    const simulation = await checkSimulation(flashbotsProvider, signedBundle, blockNumber);
    const targetBlockNumber = blockNumber + BLOCKS_IN_FUTURE;

    if (!simulation.ok) {
      if (simulation.fatal) {
        provider.off('block', blockListener)
        console.error(`Simulation failed (fatal): ${simulation.reason}`)
        process.exit(1)
      }
      console.warn(`Simulation warning (proceeding): ${simulation.reason}`)
    } else {
      console.log(`Current Block Number: ${blockNumber},   Target Block Number:${targetBlockNumber},   gasPrice: ${gasPriceToGwei(simulation.gasPrice)} gwei`)
    }

    const bundleResponse = await flashbotsProvider.sendBundle(bundleTransactions, targetBlockNumber);
    if ('error' in bundleResponse) {
      provider.off('block', blockListener)
      console.error(`Bundle error: ${bundleResponse.error.message}`)
      process.exit(1)
    }
    const bundleResolution = await bundleResponse.wait()
    if (bundleResolution === FlashbotsBundleResolution.BundleIncluded) {
      provider.off('block', blockListener)
      console.log(`Congrats, included in ${targetBlockNumber}`)
      process.exit(0)
    } else if (bundleResolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
      console.log(`Not included in ${targetBlockNumber}`)
    } else if (bundleResolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
      provider.off('block', blockListener)
      console.log("Nonce too high, bailing")
      process.exit(1)
    }
  }

  provider.on('block', blockListener)
}

main()
