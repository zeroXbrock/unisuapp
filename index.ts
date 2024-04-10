import IntentsContract from "./out/Intents.sol/Intents.json";
import config, { getL1ChainDefinition } from "./intents-lib/env";
import { Bundle, FulfillIntentRequest, TxMeta } from "./intents-lib/intentBundle";
import {
	LimitOrder,
	deployIntentRouter, // needed if you decide to re-deploy
} from "./intents-lib/limitOrder";
import { SuaveRevert } from "./intents-lib/suaveError";
import { chainContext, getWeth } from "./intents-lib/utils";
const ADDRESS_FILE = "./addresses.json";
import ChainContext from "./addresses.json";
import {
	type Hex,
	type Transport,
	concatHex,
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	encodeFunctionData,
	formatEther,
	getEventSelector,
	http,
	padHex,
	parseEther,
	toHex,
	hexToBigInt,
	decodeAbiParameters,
    parseAbi,
	parseAbiParameters,
	hexToString,
	type PublicClient,
} from "@flashbots/suave-viem";
import {
	type SuaveProvider,
	SuaveTxTypes,
	type SuaveWallet,
	type TransactionReceiptSuave,
	type TransactionRequestSuave,
	getSuaveProvider,
	getSuaveWallet,
} from "@flashbots/suave-viem/chains/utils";
import { privateKeyToAccount } from "@flashbots/suave-viem/accounts";
import fs from "fs/promises";

const isLocal = ["localhost", "127.0.0.1", "http://"].map((s) =>
	config.SUAVE_RPC_URL.includes(s)).reduce((acc, cur) => acc || cur, false)

async function testIntents<T extends Transport>(
	_suaveWallet: SuaveWallet<T>,
	suaveProvider: SuaveProvider<T>,
	l1Key: Hex,
	l1Provider: PublicClient<T>,
	l1Context: ReturnType<typeof chainContext>,
	kettleAddress: Hex,
) {
	// set DEPLOY=true in process.env if you want to re-deploy the IntentRouter
	// `DEPLOY=true bun run index.ts`
	const intentRouterAddress = process.env.DEPLOY
		? await (async () => {
				const address = await deployIntentRouter(_suaveWallet, suaveProvider)
				// replace address in file
				const newConfig = ChainContext
				if (isLocal) {
					newConfig.suave.local.intentRouter = address
				} else {
					newConfig.suave.rigil.intentRouter = address
				}
				fs.writeFile(ADDRESS_FILE, JSON.stringify(newConfig, null, 4))
                return address
		  })()
		: (isLocal ?
			ChainContext.suave.local :
			ChainContext.suave.rigil
		).intentRouter as Hex;

	const l1Wallet = createWalletClient({
		account: privateKeyToAccount(l1Key),
		transport: http(config.L1_RPC_URL),
	});

	console.log("intentRouterAddress", intentRouterAddress);
	console.log("suaveWallet", _suaveWallet.account.address);
	console.log("l1Wallet", l1Wallet.account.address);

	// automagically decode revert messages before throwing them
	// TODO: build this natively into the wallet client
	const suaveWallet = _suaveWallet.extend((client) => ({
		async sendTransaction(tx: TransactionRequestSuave): Promise<Hex> {
			try {
				return await client.sendTransaction(tx);
			} catch (e) {
				throw new SuaveRevert(e as Error);
			}
		},
	}));

	const amountIn = parseEther("0.01");
	console.log(`buying tokens with ${formatEther(amountIn)} WETH`);
	const limitOrder = new LimitOrder(
		{
			amountInMax: amountIn,
			amountOutMin: 13n,
			expiryTimestamp: BigInt(Math.round(new Date().getTime() / 1000) + 3600),
			senderKey: l1Key,
			tokenIn: l1Context.contracts.weth as Hex,
			tokenOut: l1Context.contracts.dai as Hex,
			to: l1Wallet.account.address,
		},
		suaveProvider,
		intentRouterAddress,
		kettleAddress,
	);

	console.log("orderId", limitOrder.orderId());

	const tx = await limitOrder.toTransactionRequest();
	console.log("tx", tx)
	const limitOrderTxHash: Hex = await suaveWallet.sendTransaction(tx);
	console.log("limitOrderTxHash", limitOrderTxHash);

	let ccrReceipt: TransactionReceiptSuave | null = null;

	let fails = 0;
	for (let i = 0; i < 10; i++) {
		try {
			ccrReceipt = await suaveProvider.waitForTransactionReceipt({
				hash: limitOrderTxHash,
			});
			console.log("ccrReceipt logs", ccrReceipt.logs);
			break;
		} catch (e) {
			console.warn("error", e);
			if (++fails >= 10) {
				throw new Error("failed to get receipt: timed out");
			}
		}
	}
	if (!ccrReceipt) {
		throw new Error("no receipt (this should never happen)");
	}

	const txRes = await suaveProvider.getTransaction({ hash: limitOrderTxHash });
	console.log("txRes", txRes);

	if (txRes.type !== SuaveTxTypes.Suave) {
		throw new Error("expected SuaveTransaction type (0x50)");
	}

	// check `confidentialComputeResult`; should be calldata for `onReceivedIntent`
	const fnSelector: Hex = `0x${IntentsContract.methodIdentifiers["onReceivedIntent((address,address,uint256,uint256,uint256),bytes32,bytes16)"]}`;
	const expectedData = [
		limitOrder.tokenIn,
		limitOrder.tokenOut,
		toHex(limitOrder.amountInMax),
		toHex(limitOrder.amountOutMin),
		toHex(limitOrder.expiryTimestamp),
		limitOrder.orderId(),
	]
		.map((param) => padHex(param, { size: 32 }))
		.reduce((acc, cur) => concatHex([acc, cur]));

	// this test is extremely sensitive to changes. comment out if/when changing the contract to reduce stress.
	const expectedRawResult = concatHex([fnSelector, expectedData]);
	if (
		!txRes.confidentialComputeResult.startsWith(expectedRawResult.toLowerCase())
	) {
		throw new Error(
			"expected confidential compute result to be calldata for `onReceivedIntent`",
		);
	}

	// check onchain for intent
	const intentResult = await suaveProvider.call({
		to: intentRouterAddress,
		data: encodeFunctionData({
			abi: IntentsContract.abi,
			args: [limitOrder.orderId()],
			functionName: "intentsPending",
		}),
	});
	console.log("intentResult", intentResult);

	// get dataId from event logs in receipt
	const LIMIT_ORDER_RECEIVED_SIG: Hex = getEventSelector(
		"LimitOrderReceived(bytes32,bytes16,address,address,uint256)",
	);
	const intentReceivedLog = ccrReceipt.logs.find(
		(log) => log.topics[0] === LIMIT_ORDER_RECEIVED_SIG,
	);
	if (!intentReceivedLog) {
		throw new Error("no LimitOrderReceived event found in logs");
	}
	const decodedLog = decodeEventLog({
		abi: IntentsContract.abi,
		...intentReceivedLog,
	}).args;
	console.log("*** decoded log", decodedLog);
	const { dataId } = decodedLog as { dataId: Hex };
	if (!dataId) {
		throw new Error("no dataId found in logs");
	}

	// get user's latest L1 nonce
	const nonce = await l1Provider.getTransactionCount({
		address: l1Wallet.account.address,
	});
	const blockNumber = await l1Provider.getBlockNumber();
	const targetBlock = blockNumber + 2n;
	console.log("targeting blockNumber", targetBlock);

	// tx params for L1 txs
	const l1GasPrice = await l1Provider.getGasPrice();
	const txMetaApprove = new TxMeta()
		.withChainId(config.L1_CHAIN_ID)
		.withNonce(nonce)
		.withGas(70000n)
		.withGasPrice(l1GasPrice + 2500000000n);
	const txMetaSwap = new TxMeta()
		.withChainId(config.L1_CHAIN_ID)
		.withNonce(nonce + 1)
		.withGas(200000n)
		.withGasPrice(l1GasPrice + 2500000000n);

	const fulfillIntent = new FulfillIntentRequest(
		{
			orderId: limitOrder.orderId(),
			dataId: dataId,
			txMeta: [txMetaApprove, txMetaSwap],
			bundleTxs: new Bundle().signedTxs,
			blockNumber: targetBlock,
		},
		suaveProvider,
		intentRouterAddress,
		kettleAddress,
	);
	const txRequest = await fulfillIntent.toTransactionRequest();
	console.log("fulfillIntent txRequest", txRequest);

	// send the CCR
	let fulfillIntentTxHash: Hex = "0x";
	for (let i = 0; i < 3; i++) {
		try {
			fulfillIntentTxHash = await suaveWallet.sendTransaction(txRequest)
			console.log("fulfillIntentTxHash", fulfillIntentTxHash)
			break
		} catch (_) {
			console.warn("failed to send fulfillIntent tx, retrying...")
			// sleep for 1 second
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}
	if (fulfillIntentTxHash === "0x") {
		throw new Error("failed to send fulfillIntent tx");
	}

	// wait for tx receipt, then log it
	const fulfillIntentReceipt = await suaveProvider.waitForTransactionReceipt({
		hash: fulfillIntentTxHash,
	});
	console.log("fulfillIntentReceipt", fulfillIntentReceipt);
	if (
		fulfillIntentReceipt.logs[0].data ===
		"0x0000000000000000000000000000000000000000000000000000000000009001"
	) {
		throw new Error("fulfillIntent failed: invalid function signature.");
	}
	if (
		fulfillIntentReceipt.logs[0].topics[0] !==
		"0x6cfef2b359d2bc325989410c5b08045b006cd80ea36a48c332233798808abacb"
	) {
		throw new Error("fulfillIntent failed: invalid event signature.");
	}

	for (const log of fulfillIntentReceipt.logs) {
		const decodedLog = decodeEventLog({
			abi: IntentsContract.abi,
			...log,
		});
		console.log("decodedLog", decodedLog);
		const logData = decodedLog.args as { orderId: Hex; receiptRes: Hex };
		const [orderRes, egps] = decodeAbiParameters(
			parseAbiParameters("bytes, uint64[10]"),
			logData.receiptRes,
		);
		console.log(hexToString(orderRes));
		console.log("egps", egps);
	}
}

async function main() {
	if (!config.L1_KEY) {
		console.warn(
			"L1_KEY is not set, using default. Your bundle will not land.\nTo fix, update .env in the project root.\n",
		);
	}
	if (!config.SUAVE_KEY) {
		console.warn(
			"SUAVE_KEY is not set, using default. Your SUAVE request may not land.\nTo fix, update .env in the project root.\n",
		);
	}
	const l1Context = chainContext(config.L1_CHAIN_ID);
	if (!l1Context) {
		throw new Error("invalid chain id");
	}
	// get a suave wallet & provider, connected to rigil testnet
	const suaveWallet = getSuaveWallet({
		privateKey: (config.SUAVE_KEY ||
			ChainContext.suave.defaultAdminKey) as Hex,
		transport: http(config.SUAVE_RPC_URL),
	});
	console.log("suaveWallet", suaveWallet.account.address);
	const suaveProvider = getSuaveProvider(
		http(config.SUAVE_RPC_URL),
	);

	// L1 signer & provider
	const l1Key = (config.L1_KEY ||
		"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
	const l1Wallet = createWalletClient({
		account: privateKeyToAccount(l1Key),
		transport: http(config.L1_RPC_URL),
	});
	const l1Provider = createPublicClient({
		chain: getL1ChainDefinition(),
		transport: http(config.L1_RPC_URL),
	});
	console.log("l1Wallet", l1Wallet.account.address);
	console.log("L1 blockNum", await l1Provider.getBlockNumber())
	console.log(config.L1_RPC_URL)

	// get L1 weth balance, top up if needed
	const wethBalanceRes = (
		await l1Provider.call({
			account: l1Wallet.account.address,
			to: l1Context.contracts.weth as Hex,
			data: encodeFunctionData({
				functionName: "balanceOf",
				args: [l1Wallet.account.address],
				abi: parseAbi([
					"function balanceOf(address) public view returns (uint256)",
				]),
			}),
		})
	).data;
	if (!wethBalanceRes) {
		throw new Error("failed to get WETH balance");
	}
	const wethBalance = hexToBigInt(wethBalanceRes);
	console.log("wethBalance", formatEther(wethBalance));
	const minBalance = parseEther("0.1");
	if (wethBalance < minBalance) {
		console.log("topping up WETH")
		const txHash = await getWeth(minBalance, l1Wallet, l1Provider, l1Context)
		console.log(`got ${minBalance} weth`, txHash)
		// wait for 12 seconds for the tx to land
		console.log("waiting for tx to land on L1...")
		let attempts = 0
		while (true) {
			try {
				const receipt = await l1Provider.getTransactionReceipt({
					hash: txHash,
				})
				if (receipt.status === "success") {
					console.log("tx landed")
					break
				}
			} catch (_) {
				if (attempts > 5) {
					throw new Error("tx failed to land")
				}
				attempts++
				await new Promise((resolve) => setTimeout(resolve, attempts * 1000))
			}
		}
	}

	// run test script
	await testIntents(
		suaveWallet,
		suaveProvider,
		l1Key,
		l1Provider,
		l1Context,
		(isLocal ? ChainContext.suave.local : ChainContext.suave.rigil).kettleAddress as Hex,
	);
}

main().catch(console.error)
