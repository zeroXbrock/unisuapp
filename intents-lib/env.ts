import dotenv from "dotenv";
import path from "path";
import { chainContext } from './utils';
import fs from "fs";

const defaultEnvFiles = [
	".env",
	".env.local",
];
function envPath(filename: string) {
	return path.resolve(import.meta.dir, `../${filename}`)
}

let envFilePath = "";
if (process.env.APP_ENV) {
	console.debug("APP_ENV", process.env.APP_ENV);
	envFilePath = envPath(`.env.${process.env.APP_ENV}`);
} else {
	for (const fp of defaultEnvFiles) {
		const fullPath = envPath(fp)
		if (fs.existsSync(fullPath)) {
			console.debug(`found env file ${fp}`);
			envFilePath = fullPath;
			break;
		}
	}
}

if (!envFilePath || !fs.existsSync(envFilePath)) {
	throw new Error("dotenv file not found. specify a .env.X suffix with APP_ENV=X");
}
console.debug(`loading env from ${envFilePath}`);

/// prepend 0x if var exists and 0x is not present
function prefix0x (hex?: string) {
	if (hex && !hex.startsWith("0x")) {
		return `0x${hex}`;
	}
	return hex;
}

function loadEnv() {
	const {parsed} = dotenv.config({
		path: envFilePath,
	});
	const getVar = (key: string, noDefault?: boolean): string | undefined => {
		const pv = parsed ? parsed[key] : null
		const value = pv || process.env[key]
		if (!value) {
			console.warn(`${key} is not set${noDefault ? "" : ", using default"}`);
			if (noDefault) {
				throw new Error(`${key} must be set`);
			}
		}
		return value
	}
	const L1_CHAIN_ID = parseInt(getVar("L1_CHAIN_ID") || "17000");
	const L1_KEY = prefix0x(getVar("L1_KEY", true));
	const SUAVE_KEY = prefix0x(getVar("SUAVE_KEY", true));

	const L1_RPC_URL =
		getVar("L1_RPC_URL") || "http://rpc-holesky.flashbots.net"
	const SUAVE_RPC_URL = getVar("SUAVE_RPC_URL") || "https://rpc.rigil.suave.flashbots.net"

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
