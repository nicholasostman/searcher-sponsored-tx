import {
  FlashbotsBundleProvider, FlashbotsBundleRawTransaction,
  FlashbotsBundleTransaction,
} from "@flashbots/ethers-provider-bundle";
import { BigNumber } from "ethers";
import { parseTransaction } from "ethers/lib/utils";

export const ETHER = BigNumber.from(10).pow(18);
export const GWEI = BigNumber.from(10).pow(9);

export type SimulationResult =
  | { ok: true; gasPrice: BigNumber }
  | { ok: false; fatal: boolean; reason: string }

export async function checkSimulation(
  flashbotsProvider: FlashbotsBundleProvider,
  signedBundle: Array<string>,
  blockNumber: number
): Promise<SimulationResult> {
  let simulationResponse: any;
  try {
    simulationResponse = await flashbotsProvider.simulate(signedBundle, blockNumber);
  } catch (e: any) {
    return { ok: false, fatal: false, reason: `Relay unreachable: ${e.message}` }
  }

  if (!("results" in simulationResponse)) {
    return { ok: false, fatal: false, reason: `Relay error ${simulationResponse.error.code}: ${simulationResponse.error.message}` }
  }

  for (let i = 0; i < simulationResponse.results.length; i++) {
    const txSimulation = simulationResponse.results[i];
    if ("error" in txSimulation) {
      return { ok: false, fatal: true, reason: `TX #${i} reverted: ${txSimulation.error} — ${txSimulation.revert}` }
    }
  }

  if (simulationResponse.coinbaseDiff.eq(0)) {
    return { ok: false, fatal: true, reason: "Bundle does not pay coinbase" }
  }

  const gasUsed = simulationResponse.results.reduce(
    (acc: number, txSimulation: any) => acc + txSimulation.gasUsed,
    0
  );
  return { ok: true, gasPrice: simulationResponse.coinbaseDiff.div(gasUsed) }
}

export async function printTransactions(
  bundleTransactions: Array<FlashbotsBundleTransaction | FlashbotsBundleRawTransaction>,
  signedBundle: Array<string>
): Promise<void> {
  console.log("--------------------------------");
  console.log(
    (
      await Promise.all(
        bundleTransactions.map(
          async (bundleTx, index) => {
            const tx = 'signedTransaction' in bundleTx ? parseTransaction(bundleTx.signedTransaction) : bundleTx.transaction
            const from = 'signer' in bundleTx ? await bundleTx.signer.getAddress() : tx.from

            return `TX #${index}: ${from} => ${tx.to} : ${tx.data}`
          })
      )
    ).join("\n")
  );

  console.log("--------------------------------");
  console.log(
    (
      await Promise.all(
        signedBundle.map(async (signedTx, index) => `TX #${index}: ${signedTx}`)
      )
    ).join("\n")
  );

  console.log("--------------------------------");
}

export function gasPriceToGwei(gasPrice: BigNumber): number {
  return gasPrice.mul(100).div(GWEI).toNumber() / 100;
}
