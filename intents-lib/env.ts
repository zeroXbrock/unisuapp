import dotenv from "dotenv";
import path from "path";
import { chainContext } from './utils';

dotenv.config({
	path: path.resolve(import.meta.dir, "../../../.env"),
});

/// prepend 0x if var exists and 0x is not present
function prefix0x (hex?: string) {
	if (hex && !hex.startsWith("0x")) {
		return `0x${hex}`;
	}
	return hex;
}

function loadEnv() {
	const L1_CHAIN_ID = parseInt(process.env.L1_CHAIN_ID || "17000");
	const L1_KEY = prefix0x(process.env.L1_KEY);
	const SUAVE_KEY = prefix0x(process.env.SUAVE_KEY);
	
	if (!process.env.L1_RPC_URL) {
		console.warn("L1_RPC_URL is not set, using default.\n");
	}
	if (!process.env.SUAVE_RPC_URL) {
		console.warn("SUAVE_RPC_URL is not set, using default.\n");
	}
	const L1_RPC_URL =
		process.env.L1_RPC_URL || "http://rpc-holesky.flashbots.net"
	const SUAVE_RPC_URL = process.env.SUAVE_RPC_URL || "https://rpc.rigil.suave.flashbots.net"

	return {
		L1_CHAIN_ID,
		L1_KEY,
		L1_RPC_URL,
		SUAVE_KEY,
		SUAVE_RPC_URL,
	};
}

const env = loadEnv();

export const getL1ChainDefinition = () => {
	const l1Context = chainContext(env.L1_CHAIN_ID);
    return {
        id: env.L1_CHAIN_ID,
        name: l1Context.name,
        nativeCurrency: {
            name: "Ether",
            symbol: "ETH",
            decimals: 18,
        },
        network: l1Context.name,
        rpcUrls: {
            default: {
                http: [env.L1_RPC_URL],
            },
            public: {
                http: [env.L1_RPC_URL],
            },
        },
    }
}

export default env;
