// Curated catalogue of Ethereum mainnet flash-loan providers. Static
// because the data changes on the order of months (fee tweaks,
// contract migrations) and any agent that needs millisecond freshness
// is doing it wrong (they should query liquidity from their own RPC).
//
// `fee_bps` is the FLAT fee the provider charges, expressed in basis
// points (1 bp = 0.01 %). `liquidity_note` is intentionally
// qualitative — we don't try to query live liquidity because that's
// either chain-state (the agent's job) or stale (a cached number is
// worse than no number).
//
// FlashBank is included as one of the providers because it IS one,
// not because we have any commercial arrangement with it. The
// catalogue is editorially open — if another provider wants to be
// listed, send a PR.

export const FLASHLOAN_PROVIDERS = Object.freeze([
	{
		id: 'aave-v3',
		name: 'Aave V3 Pool',
		chain: 'ethereum',
		chain_id: 1,
		address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
		fee_bps: 5,
		fee_bps_note: '0.05% — fixed across all flashLoan() and flashLoanSimple() calls',
		docs: 'https://aave.com/docs/developers/smart-contracts/pool#flashloan',
		liquidity_note: 'Deep — Aave is the largest mainnet flash-loan source by available liquidity in WETH, WBTC, USDC, USDT, DAI, LINK and most blue-chip assets.',
		supports_multi_asset: true,
		notable_constraints: [
			'Must be a contract caller (no EOA flash loans).',
			'Repayment + premium must be approved before flashLoan() returns.'
		]
	},
	{
		id: 'balancer-v2',
		name: 'Balancer V2 Vault',
		chain: 'ethereum',
		chain_id: 1,
		address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
		fee_bps: 0,
		fee_bps_note: '0 bps — no premium charged (Balancer absorbs the cost via vault economics)',
		docs: 'https://docs.balancer.fi/reference/contracts/flash-loans.html',
		liquidity_note: 'Variable per pool. Deep in WETH, WBTC, USDC, USDT, wstETH, rETH, BAL. Always check `Vault.totalSupply` for the specific token before relying on a large amount.',
		supports_multi_asset: true,
		notable_constraints: [
			'Flash loans go via the Vault, not individual pools.',
			'Always cheapest provider when liquidity is sufficient — recommended default for fee-sensitive callers.'
		]
	},
	{
		id: 'morpho-blue',
		name: 'Morpho Blue (free flash callback)',
		chain: 'ethereum',
		chain_id: 1,
		address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
		fee_bps: 0,
		fee_bps_note: '0 bps — Morpho exposes `flashLoan(token, amount, data)` with no premium',
		docs: 'https://docs.morpho.org/morpho/contracts/morpho-blue#flashloan',
		liquidity_note: 'Bounded by the total supply of each Morpho market for that token. Usually less liquidity than Aave V3 / Balancer for the same asset but with zero fee.',
		supports_multi_asset: false,
		notable_constraints: [
			'Single-asset only.',
			'The token must be supplied as collateral or loan asset in at least one live market.'
		]
	},
	{
		id: 'flashbank',
		name: 'FlashBank Router',
		chain: 'ethereum',
		chain_id: 1,
		address: '0xBDcC71d5F73962d017756A04919FBba9d30F0795',
		fee_bps: 2,
		fee_bps_note: "0.02% — configurable per token via setTokenConfig (1–100 bps range)",
		docs: 'https://flashbank.net',
		liquidity_note: "Just-in-time model: WETH is pulled from LPs' wallets only during the flash loan, never deposited into a pool. Available liquidity equals the sum of active LP commitments, queryable via `getCommitments(token)`. As of launch, mainnet commitments are 0 — useful if and when LPs arrive.",
		supports_multi_asset: false,
		notable_constraints: [
			'WETH-first at launch; other ERC-20s require setTokenConfig.',
			'Provider availability depends on LP commitments — query before assuming liquidity.',
			'Lower fee than Aave but currently lower liquidity than Balancer + Aave.'
		]
	},
	{
		id: 'uniswap-v3',
		name: 'Uniswap V3 Pool (flash callback)',
		chain: 'ethereum',
		chain_id: 1,
		address: 'per-pool — varies',
		fee_bps: null,
		fee_bps_note: "Equals the pool's swap fee tier (5/30/100 bps) — Uniswap charges the fee tier as flash premium",
		docs: 'https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/callback/IUniswapV3FlashCallback',
		liquidity_note: 'Per-pool. Useful if you already need a Uniswap callback in your call stack; otherwise more expensive than Aave/Balancer and constrained by individual pool depth.',
		supports_multi_asset: true,
		notable_constraints: [
			'flash() takes amount0 and amount1 of the pool tokens.',
			'Fee tier (0.05/0.3/1.0%) is paid back as the flash premium.'
		]
	}
]);

// Compute the cheapest provider for a target amount + token. We don't
// know live liquidity here — caller is expected to verify. We return
// providers in ascending fee order so the caller's "first viable" loop
// hits the cheapest one first.
export function rankByFee() {
	return [...FLASHLOAN_PROVIDERS]
		.filter(p => p.fee_bps != null)
		.sort((a, b) => a.fee_bps - b.fee_bps);
}

// Filter providers by a basic "viability" predicate: chain match,
// multi-asset support if required, fee cap if specified. Pure function
// so easy to test.
export function filterProviders({ chain = 'ethereum', maxFeeBps = null, multiAsset = null } = {}) {
	return FLASHLOAN_PROVIDERS.filter(p => {
		if (chain && p.chain !== chain) return false;
		// When a fee cap is set, indeterminate-fee providers (Uniswap V3
		// is per-pool, fee_bps=null) are excluded because we can't prove
		// they satisfy the cap.
		if (maxFeeBps != null) {
			if (p.fee_bps == null) return false;
			if (p.fee_bps > maxFeeBps) return false;
		}
		if (multiAsset === true && !p.supports_multi_asset) return false;
		return true;
	});
}
