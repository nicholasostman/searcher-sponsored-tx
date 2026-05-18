import { Contract, providers, BigNumber } from "ethers";
import { isAddress } from "ethers/lib/utils";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import { Base } from "./Base";

const ERC1155_ABI = [
  {
    "inputs": [
      {"internalType": "address", "name": "account", "type": "address"},
      {"internalType": "uint256", "name": "id", "type": "uint256"}
    ],
    "name": "balanceOf",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {"internalType": "address", "name": "from", "type": "address"},
      {"internalType": "address", "name": "to", "type": "address"},
      {"internalType": "uint256[]", "name": "ids", "type": "uint256[]"},
      {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"},
      {"internalType": "bytes", "name": "data", "type": "bytes"}
    ],
    "name": "safeBatchTransferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
]

export interface Erc1155Transfer {
  contractAddress: string;
  tokenId: number;
}

export class Transfer1155 extends Base {
  private _provider: providers.JsonRpcProvider;
  private _sender: string;
  private _recipient: string;
  private _transfers: Erc1155Transfer[];

  constructor(provider: providers.JsonRpcProvider, sender: string, recipient: string, transfers: Erc1155Transfer[]) {
    super()
    if (!isAddress(sender)) throw new Error("Bad Address")
    if (!isAddress(recipient)) throw new Error("Bad Address")
    transfers.forEach(({ contractAddress }) => {
      if (!isAddress(contractAddress)) throw new Error(`Bad contract address: ${contractAddress}`)
    })
    this._provider = provider;
    this._sender = sender;
    this._recipient = recipient;
    this._transfers = transfers;
  }

  async description(): Promise<string> {
    const byContract = this._groupByContract();
    const lines = Object.entries(byContract).map(([addr, ids]) =>
      `  ${addr} tokenIds: [${ids.join(", ")}]`
    )
    return `Transfer ERC1155 tokens to ${this._recipient}:\n${lines.join("\n")}`
  }

  async getSponsoredTransactions(): Promise<Array<TransactionRequest>> {
    const byContract = this._groupByContract();
    const txs: TransactionRequest[] = [];

    for (const [contractAddress, tokenIds] of Object.entries(byContract)) {
      const contract = new Contract(contractAddress, ERC1155_ABI, this._provider);

      const balances: BigNumber[] = await Promise.all(
        tokenIds.map(id => contract.balanceOf(this._sender, id))
      )

      const idsWithBalance = tokenIds.filter((_, i) => balances[i].gt(0));
      const missingIds = tokenIds.filter((_, i) => balances[i].eq(0));
      if (missingIds.length > 0) {
        throw new Error(
          `ERC1155 ${contractAddress}: sender ${this._sender} has zero balance for tokenIds: [${missingIds.join(", ")}]`
        )
      }

      txs.push({
        ...(await contract.populateTransaction.safeBatchTransferFrom(
          this._sender,
          this._recipient,
          idsWithBalance,
          balances.filter(b => b.gt(0)),
          "0x"
        ))
      })
    }

    return txs;
  }

  private _groupByContract(): Record<string, number[]> {
    const grouped: Record<string, number[]> = {};
    for (const { contractAddress, tokenId } of this._transfers) {
      const key = contractAddress.toLowerCase();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(tokenId);
    }
    return grouped;
  }
}
