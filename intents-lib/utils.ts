import { type Hash, type Hex, type WalletClient, formatEther, type PublicClient } from '@flashbots/suave-viem'
import ChainContext from "../rigil.json";
import { getL1ChainDefinition } from './env';

export const ETH = 1000000000000000000n

export const roundEth = (n: bigint) => Number.parseFloat(formatEther(n)).toPrecision(4)

export async function getWeth(amount: bigint, wallet: WalletClient, l1Provider: PublicClient, l1Context: ReturnType<typeof chainContext>): Promise<Hash> {
    if (!process.env.L1_KEY) {
        throw new Error('L1_KEY must be set to get WETH')
    }
    if (!wallet.account) {
        throw new Error('wallet must have an account to get WETH')
    }
    const gasPrice = await l1Provider.getGasPrice()
    const txRequest = await wallet.prepareTransactionRequest({
        account: wallet.account,
        chain: getL1ChainDefinition(),
        to: l1Context.contracts.weth as Hex,
        value: amount, // 0.1 WETH
        data: '0xd0e30db0' as Hex, // deposit()
        gas: 50000n,
        gasPrice: gasPrice + 5000000000n,
    })
    const signedTx = await wallet.signTransaction(txRequest)
    return await wallet.sendRawTransaction({serializedTransaction: signedTx})
}

export const chainContext = (id: number) => {
	switch (id) {
		case 1:
			return {
				name: "mainnet",
				contracts: ChainContext.mainnet,
			};
		case 5:
			return {name: "goerli", contracts: ChainContext.goerli};
		case 17000:
			return {name: "holesky", contracts: ChainContext.holesky};
		default:
			throw new Error("invalid chain ID");
	}
}
