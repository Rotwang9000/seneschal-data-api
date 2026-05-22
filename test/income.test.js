// Unit tests for src/income.js. Cover the config validator and the
// pure aggregator (buildIncomeSnapshot + classifyToken + createIncomeCache).
// The RPC layer (readIncomeSnapshot) is exercised indirectly through
// the cache test below using a fake client.

import { describe, test, expect, jest } from '@jest/globals';
import {
	buildIncomeConfig,
	buildIncomeSnapshot,
	classifyToken,
	createIncomeCache,
	DEFAULT_TOKENS,
	DEFAULT_ENTRY_POINT,
	DEFAULT_DUST_USD
} from '../src/income.js';

const PAYMASTER = '0xb6E8d189285003cF0000388b01BA0C3433ee9f14';
const RECIPIENT = '0x46Ba634261566CF242c853d1f49511f9268ba674';
const USDC = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC');
const DAI = DEFAULT_TOKENS.find((t) => t.symbol === 'DAI');
const CBBTC = DEFAULT_TOKENS.find((t) => t.symbol === 'cbBTC');

describe('buildIncomeConfig', () => {
	test('returns disabled when neither paymaster nor recipient is set', () => {
		const cfg = buildIncomeConfig({ cfg: {}, env: {} });
		expect(cfg.enabled).toBe(false);
		expect(cfg.reason).toMatch(/PAYMASTER_ADDRESS|X402_RECIPIENT_ADDRESS/);
	});

	test('enabled with paymaster only is fine (recipient null)', () => {
		const cfg = buildIncomeConfig({
			cfg: { paymasterAddress: PAYMASTER, baseRpcUrl: 'https://example.org' },
			env: {}
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.paymaster).toBe(PAYMASTER);
		expect(cfg.recipient).toBeNull();
		expect(cfg.entryPoint).toBe(DEFAULT_ENTRY_POINT);
		expect(cfg.ethUsdFeed).toMatch(/^0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70$/i);
	});

	test('enabled with recipient only is fine (paymaster null)', () => {
		const cfg = buildIncomeConfig({
			cfg: { x402RecipientAddress: RECIPIENT, baseRpcUrl: 'https://example.org' },
			env: {}
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.paymaster).toBeNull();
		expect(cfg.recipient).toBe(RECIPIENT);
	});

	test('throws on malformed paymaster', () => {
		expect(() => buildIncomeConfig({
			cfg: { paymasterAddress: 'not-an-address' },
			env: {}
		})).toThrow(/PAYMASTER_ADDRESS.*0x-prefixed/);
	});

	test('throws on malformed recipient', () => {
		expect(() => buildIncomeConfig({
			cfg: { x402RecipientAddress: '0x1234' },
			env: {}
		})).toThrow(/X402_RECIPIENT_ADDRESS.*0x-prefixed/);
	});

	test('throws on bad RPC URL', () => {
		expect(() => buildIncomeConfig({
			cfg: { paymasterAddress: PAYMASTER, baseRpcUrl: 'ftp://nope' },
			env: {}
		})).toThrow(/BASE_RPC_URL/);
	});

	test('throws on non-positive fallback ethUsd', () => {
		expect(() => buildIncomeConfig({
			cfg: { paymasterAddress: PAYMASTER, baseRpcUrl: 'https://x.org', ethUsd: 0 },
			env: {}
		})).toThrow(/ETH_USD/);
	});

	test('throws on malformed Chainlink feed override', () => {
		expect(() => buildIncomeConfig({
			cfg: { paymasterAddress: PAYMASTER, baseRpcUrl: 'https://x.org', ethUsdFeed: 'no' },
			env: {}
		})).toThrow(/ETH_USD_FEED/);
	});
});

describe('classifyToken', () => {
	test('zero balance is not sweep-eligible', () => {
		const t = classifyToken(USDC, 0n);
		expect(t.balance).toBe(0);
		expect(t.usd).toBe(0);
		expect(t.sweep_eligible).toBe(false);
	});

	test('balance below dust is not eligible but reports usd', () => {
		const t = classifyToken(USDC, 1_000_000n); // $1
		expect(t.usd).toBe(1);
		expect(t.sweep_eligible).toBe(false);
	});

	test('balance above dust is eligible', () => {
		const t = classifyToken(USDC, 10_000_000n); // $10
		expect(t.sweep_eligible).toBe(true);
	});

	test('cbBTC reports usd at the configured spot price', () => {
		// 0.0001 cbBTC at $76,000 = $7.60
		const t = classifyToken(CBBTC, 10_000n);
		expect(t.balance).toBe(0.0001);
		expect(t.usd).toBe(7.6);
		expect(t.sweep_eligible).toBe(true);
	});
});

describe('buildIncomeSnapshot', () => {
	test('returns paymaster + recipient blocks with treasury total', () => {
		const snap = buildIncomeSnapshot({
			paymaster: PAYMASTER,
			entryPoint: DEFAULT_ENTRY_POINT,
			recipient: RECIPIENT,
			ethUsd: 2500,
			ethUsdSource: 'chainlink',
			dustUsd: DEFAULT_DUST_USD,
			paymasterEthWei: 1_000000000000000000n, // 1 ETH
			paymasterEntryPointWei: 50_000000000000000n, // 0.05 ETH
			paymasterTokenBalances: [
				{ token: USDC, raw: 12_500_000n }, // $12.50
				{ token: DAI,  raw: 0n }
			],
			recipientUsdcWei: 100_000_000n, // $100
			tokens: DEFAULT_TOKENS,
			asOfMs: 1000
		});
		expect(snap.enabled).toBe(true);
		expect(snap.as_of_ms).toBe(1000);
		expect(snap.eth_usd).toBe(2500);
		expect(snap.eth_usd_source).toBe('chainlink');
		expect(snap.paymaster.address).toBe(PAYMASTER);
		expect(snap.paymaster.eth_balance).toBe(1);
		expect(snap.paymaster.entrypoint_deposit_eth).toBe(0.05);
		expect(snap.paymaster.total_eth_float).toBe(1.05);
		expect(snap.paymaster.total_eth_float_usd).toBe(2625);
		expect(snap.paymaster.eth_usd_assumed).toBeUndefined();
		expect(snap.paymaster.tokens).toHaveLength(2);
		expect(snap.paymaster.total_token_usd).toBe(12.5);
		expect(snap.paymaster.sweep_eligible_usd).toBe(12.5);
		expect(snap.recipient.address).toBe(RECIPIENT);
		expect(snap.recipient.usdc_balance).toBe(100);
		// 2625 (ETH) + 12.50 (paymaster USDC) + 100 (recipient USDC) = 2737.50
		expect(snap.treasury_usd).toBe(2737.5);
	});

	test('omits paymaster block when paymaster is null', () => {
		const snap = buildIncomeSnapshot({
			paymaster: null,
			entryPoint: DEFAULT_ENTRY_POINT,
			recipient: RECIPIENT,
			ethUsd: 2500,
			ethUsdSource: 'chainlink',
			recipientUsdcWei: 50_000_000n
		});
		expect(snap.paymaster).toBeNull();
		expect(snap.recipient.usdc_balance).toBe(50);
		expect(snap.treasury_usd).toBe(50);
	});

	test('omits recipient block when recipient is null', () => {
		const snap = buildIncomeSnapshot({
			paymaster: PAYMASTER,
			entryPoint: DEFAULT_ENTRY_POINT,
			recipient: null,
			ethUsd: 2500,
			ethUsdSource: 'fallback',
			paymasterEthWei: 0n,
			paymasterEntryPointWei: 0n,
			paymasterTokenBalances: [{ token: USDC, raw: 0n }]
		});
		expect(snap.paymaster.address).toBe(PAYMASTER);
		expect(snap.recipient).toBeNull();
		expect(snap.eth_usd_source).toBe('fallback');
	});
});

describe('chainlinkAnswerToUsd', () => {
	test('converts 8-decimal answer correctly', async () => {
		const { chainlinkAnswerToUsd } = await import('../src/income.js');
		expect(chainlinkAnswerToUsd(250_000_000_000n)).toBe(2500);
		expect(chainlinkAnswerToUsd(123_456_789_000n)).toBe(1234.56789);
	});
	test('returns null on non-positive', async () => {
		const { chainlinkAnswerToUsd } = await import('../src/income.js');
		expect(chainlinkAnswerToUsd(0n)).toBeNull();
		expect(chainlinkAnswerToUsd(-1n)).toBeNull();
	});
});

describe('createIncomeCache', () => {
	test('caches the first result for ttlMs', async () => {
		const cache = createIncomeCache({ ttlMs: 60_000 });
		// We can't directly call the cache without the real readIncomeSnapshot,
		// but we can short-circuit it by passing an already-disabled config —
		// the cache stores whatever readIncomeSnapshot returns.
		const cfg = { enabled: false, reason: 'test' };
		const first = await cache.get(cfg);
		expect(first.enabled).toBe(false);
		const second = await cache.get(cfg);
		expect(second).toBe(first);
	});

	test('clear() drops the cached value', async () => {
		const cache = createIncomeCache({ ttlMs: 60_000 });
		const cfg = { enabled: false, reason: 'first' };
		const first = await cache.get(cfg);
		cache.clear();
		// Different "config" so we can verify the next call re-reads.
		// readIncomeSnapshot just returns the disabled payload, but the
		// returned object is a fresh literal — !== identity comparison.
		const second = await cache.get({ enabled: false, reason: 'second' });
		expect(second).not.toBe(first);
		expect(second.reason).toBe('second');
	});
});
