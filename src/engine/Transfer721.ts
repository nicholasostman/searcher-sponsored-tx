import { Contract, providers } from "ethers";
import { isAddress } from "ethers/lib/utils";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import { Base } from "./Base";

const ERC721_ABI = [
  {
    "inputs": [{"internalType": "address", "name": "from", "type": "address"},
               {"internalType": "address", "name": "to", "type": "address"},
               {"internalType": "uint256", "name": "tokenId", "type": "uint256"}],
    "name": "safeTransferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "tokenId", "type": "uint256"}],
    "name": "ownerOf",
    "outputs": [{"internalType": "address", "name": "", "type": "address"}],
    "stateMutability": "view",
    "type": "function"
  }
]

export interface NftTransfer {
  contractAddress: string;
  tokenId: number;
}

export class Transfer721 extends Base {
  private _provider: providers.JsonRpcProvider;
  private _sender: string;
  private _recipient: string;
  private _transfers: NftTransfer[];

  constructor(provider: providers.JsonRpcProvider, sender: string, recipient: string, transfers: NftTransfer[]) {
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
    const lines = this._transfers.map(t => `  ${t.contractAddress} #${t.tokenId}`)
    return `Transfer ${this._transfers.length} ERC721 token(s) to ${this._recipient}:\n${lines.join("\n")}`
  }

  async getSponsoredTransactions(): Promise<Array<TransactionRequest>> {
    await Promise.all(this._transfers.map(async ({ contractAddress, tokenId }) => {
      const contract = new Contract(contractAddress, ERC721_ABI, this._provider);
      const owner: string = await contract.ownerOf(tokenId);
      if (owner.toLowerCase() !== this._sender.toLowerCase()) {
        throw new Error(`Token ${tokenId} at ${contractAddress} is not owned by ${this._sender} (owned by ${owner})`)
      }
    }))
    return Promise.all(this._transfers.map(async ({ contractAddress, tokenId }) => {
      const contract = new Contract(contractAddress, ERC721_ABI, this._provider);
      return {
        ...(await contract.populateTransaction.safeTransferFrom(this._sender, this._recipient, tokenId)),
      }
    }))
  }
}
