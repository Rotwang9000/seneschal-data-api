// Income telemetry.
//
// Combines two on-chain signals into a single "are we earning?"
// snapshot, served via /v1/stats/income and embedded in
// /v1/stats/overview as `income`:
//
//   1. Paymaster — current ETH float (raw paymaster balance +
//      EntryPoint deposit) and per-stablecoin balances. ETH going
//      down means smart-account userOps are being sponsored; stables
//      going up means our markup is accruing inside the contract.
//
//   2. Recipient wallet — USDC balance of the address the paymaster
//      sweeps to and the x402 paywall pays to. Increases on either
//      a sweep or a paid /v1/premium/* call.
//
// All reads are live; we keep a small in-process cache so the stats
// dashboard doesn't hammer the RPC endpoint at 30s intervals.
// Historical time-series (for charts) comes from a separate JSONL
// snapshot file written by scripts/income-poller.mjs.

import { createPublicClient, http, parseAbi, formatUnits, formatEther } from 'viem';
import { base } from 'viem/chains';

// Same defaults as scripts/paymaster-sweep-check.mjs — keep these in
// sync if more tokens are added on the contract side.
export const DEFAULT_PAYMASTER = '0xb6E8d189285003cF0000388b01BA0C3433ee9f14';
export const DEFAULT_ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const DEFAULT_DUST_USD = 5;
export const DEFAULT_ETH_USD = 4200; // conservative — updated via env if needed.

export const DEFAULT_TOKENS = Object.freeze([
	Object.freeze({ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, usd: 1.0 }),
	Object.freeze({ symbol: 'EURC', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6, usd: 1.16 }),
	Object.freeze({ symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, usd: 1.0 }),
	Object.freeze({ symbol: 'DAI',  address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, usd: 1.0 }),
	Object.freeze({ symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, usd: 76_000 })
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

const ERC20_ABI = parseAbi([
	'function balanceOf(address) view returns (uint256)'
]);

const ENTRYPOINT_ABI = parseAbi([
	'function balanceOf(address) view returns (uint256)'
]);

/**
 * Validate the income-feature config block coming from src/config.js.
 * Returns `{ enabled: false, reason }` when there's no paymaster set
 * up — that's the dev-default — or throws if env vars are present but
 * malformed (a misconfigured address would silently break monitoring).
 */
export function buildIncomeConfig({ cfg = {}, env = process.env } = {}) {
	const paymaster = ((cfg.paymasterAddress ?? '') + '').trim();
	const recipient = ((cfg.x402RecipientAddress ?? '') + '').trim();
	const enabled = Boolean(paymaster || recipient);
	if (!enabled) {
		return Object.freeze({
			enabled: false,
			reason: 'income: neither PAYMASTER_ADDRESS nor X402_RECIPIENT_ADDRESS is set; nothing to monitor'
		});
	}
	if (paymaster && !ADDRESS_RE.test(paymaster)) {
		throw new TypeError(`income: PAYMASTER_ADDRESS=${paymaster} is not a 0x-prefixed 20-byte hex string`);
	}
	if (recipient && !ADDRESS_RE.test(recipient)) {
		throw new TypeError(`income: X402_RECIPIENT_ADDRESS=${recipient} is not a 0x-prefixed 20-byte hex string`);
	}
	const entryPoint = ((cfg.entryPointAddress ?? DEFAULT_ENTRY_POINT) + '').trim();
	if (entryPoint && !ADDRESS_RE.test(entryPoint)) {
		throw new TypeError(`income: ENTRYPOINT_ADDRESS=${entryPoint} is not a 0x-prefixed 20-byte hex string`);
	}
	const rpcUrl = ((cfg.baseRpcUrl ?? env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com') + '').trim();
	if (!/^https?:\/\//u.test(rpcUrl)) {
		throw new TypeError(`income: BASE_RPC_URL=${rpcUrl} must be an http(s) URL`);
	}
	const ethUsd = Number(cfg.ethUsd ?? DEFAULT_ETH_USD);
	if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
		throw new TypeError(`income: ETH_USD=${cfg.ethUsd} must be a positive number`);
	}
	return Object.freeze({
		enabled: true,
		paymaster: paymaster || null,
		entryPoint,
		recipient: recipient || null,
		rpcUrl,
		tokens: DEFAULT_TOKENS,
		ethUsd,
		dustUsd: DEFAULT_DUST_USD,
		cacheTtlMs: Number(cfg.cacheTtlMs ?? 60_000)
	});
}

/**
 * Pure: turn a token + raw balance into the structured entry the
 * snapshot exposes. Mirrors classifyBalance in the sweep-check script
 * but with a small set of differences: we always return a `sweep_eligible`
 * flag using the provided dust floor, and the per-token usd value is
 * available for the running total.
 */
export function classifyToken(token, raw, { dustUsd = DEFAULT_DUST_USD } = {}) {
	const human = Number(formatUnits(raw, token.decimals));
	const usd = human * token.usd;
	return {
		symbol: token.symbol,
		address: token.address,
		decimals: token.decimals,
		balance: Number(human.toFixed(Math.min(token.decimals, 8))),
		usd: Number(usd.toFixed(2)),
		sweep_eligible: usd >= dustUsd
	};
}

/**
 * Pure: combine three primitive reads + a token table into the final
 * snapshot object. Separated from the RPC layer so tests can inject
 * arbitrary balance shapes without faking a public client.
 */
export function buildIncomeSnapshot({
	paymaster,
	entryPoint,
	recipient,
	ethUsd,
	dustUsd = DEFAULT_DUST_USD,
	paymasterEthWei = 0n,
	paymasterEntryPointWei = 0n,
	paymasterTokenBalances = [],
	recipientUsdcWei = 0n,
	tokens = DEFAULT_TOKENS,
	asOfMs = Date.now()
}) {
	const tokensOut = paymasterTokenBalances.map(({ token, raw }) =>
		classifyToken(token, raw, { dustUsd })
	);
	const totalTokenUsd = tokensOut.reduce((acc, t) => acc + t.usd, 0);
	const sweepEligibleUsd = tokensOut
		.filter((t) => t.sweep_eligible)
		.reduce((acc, t) => acc + t.usd, 0);

	const ethBalance = Number(formatEther(paymasterEthWei));
	const epDeposit = Number(formatEther(paymasterEntryPointWei));
	const totalEthFloat = ethBalance + epDeposit;
	const totalEthFloatUsd = totalEthFloat * ethUsd;

	const usdc = tokens.find((t) => t.symbol === 'USDC');
	const recipientUsdcHuman = usdc ? Number(formatUnits(recipientUsdcWei, usdc.decimals)) : 0;
	const recipientUsdc = Number(recipientUsdcHuman.toFixed(2));

	const treasuryUsd = Number((totalTokenUsd + recipientUsdc + totalEthFloatUsd).toFixed(2));

	return {
		enabled: true,
		as_of_ms: asOfMs,
		paymaster: paymaster
			? {
				address: paymaster,
				entry_point: entryPoint,
				eth_balance: Number(ethBalance.toFixed(6)),
				entrypoint_deposit_eth: Number(epDeposit.toFixed(6)),
				total_eth_float: Number(totalEthFloat.toFixed(6)),
				total_eth_float_usd: Number(totalEthFloatUsd.toFixed(2)),
				eth_usd_assumed: ethUsd,
				tokens: tokensOut,
				total_token_usd: Number(totalTokenUsd.toFixed(2)),
				sweep_eligible_usd: Number(sweepEligibleUsd.toFixed(2))
			}
			: null,
		recipient: recipient
			? {
				address: recipient,
				usdc_balance: recipientUsdc,
				note: 'x402 paid-call settlements + paymaster sweeps both land here.'
			}
			: null,
		treasury_usd: treasuryUsd
	};
}

/**
 * Side-effecty: read the live on-chain state with a viem public
 * client. Wraps buildIncomeSnapshot — pure aggregator is reused, so
 * the wire-up here is just RPC calls. Errors bubble up so the caller
 * can return a graceful "error" payload rather than blanket 500.
 */
export async function readIncomeSnapshot(incomeCfg, { client } = {}) {
	if (!incomeCfg.enabled) {
		return { enabled: false, reason: incomeCfg.reason ?? 'income disabled' };
	}
	const pc = client ?? createPublicClient({
		chain: base,
		transport: http(incomeCfg.rpcUrl)
	});
	const reads = [];
	if (incomeCfg.paymaster) {
		reads.push(pc.getBalance({ address: incomeCfg.paymaster }));
		reads.push(pc.readContract({
			address: incomeCfg.entryPoint,
			abi: ENTRYPOINT_ABI,
			functionName: 'balanceOf',
			args: [incomeCfg.paymaster]
		}));
		for (const tok of incomeCfg.tokens) {
			reads.push(pc.readContract({
				address: tok.address,
				abi: ERC20_ABI,
				functionName: 'balanceOf',
				args: [incomeCfg.paymaster]
			}));
		}
	}
	if (incomeCfg.recipient) {
		const usdc = incomeCfg.tokens.find((t) => t.symbol === 'USDC');
		if (!usdc) throw new Error('income: USDC missing from token table');
		reads.push(pc.readContract({
			address: usdc.address,
			abi: ERC20_ABI,
			functionName: 'balanceOf',
			args: [incomeCfg.recipient]
		}));
	}
	const results = await Promise.all(reads);
	let i = 0;
	let paymasterEthWei = 0n;
	let paymasterEntryPointWei = 0n;
	const paymasterTokenBalances = [];
	if (incomeCfg.paymaster) {
		paymasterEthWei = results[i++];
		paymasterEntryPointWei = results[i++];
		for (const tok of incomeCfg.tokens) {
			paymasterTokenBalances.push({ token: tok, raw: results[i++] });
		}
	}
	let recipientUsdcWei = 0n;
	if (incomeCfg.recipient) {
		recipientUsdcWei = results[i++];
	}
	return buildIncomeSnapshot({
		paymaster: incomeCfg.paymaster,
		entryPoint: incomeCfg.entryPoint,
		recipient: incomeCfg.recipient,
		ethUsd: incomeCfg.ethUsd,
		dustUsd: incomeCfg.dustUsd,
		paymasterEthWei,
		paymasterEntryPointWei,
		paymasterTokenBalances,
		recipientUsdcWei,
		tokens: incomeCfg.tokens
	});
}

/**
 * Small in-process cache wrapper. The dashboard hits /v1/stats/overview
 * every 30s; 60s of staleness on balance numbers is acceptable and
 * halves our RPC bill. Cache stores the resolved snapshot, not the
 * promise — failed reads aren't retained, so a transient RPC blip
 * doesn't poison the cache.
 */
export function createIncomeCache({ ttlMs = 60_000 } = {}) {
	let cached = null;
	let cachedAt = 0;
	return {
		async get(incomeCfg) {
			const now = Date.now();
			if (cached && now - cachedAt < ttlMs) return cached;
			const snap = await readIncomeSnapshot(incomeCfg);
			cached = snap;
			cachedAt = now;
			return snap;
		},
		clear() { cached = null; cachedAt = 0; }
	};
}
