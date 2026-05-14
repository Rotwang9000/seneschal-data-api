import { describe, test, expect } from '@jest/globals';
import { FLASHLOAN_PROVIDERS, filterProviders, rankByFee } from '../src/flashloan-providers.js';

describe('FLASHLOAN_PROVIDERS catalogue', () => {
	test('contains the providers we promise', () => {
		const ids = FLASHLOAN_PROVIDERS.map(p => p.id).sort();
		expect(ids).toContain('aave-v3');
		expect(ids).toContain('balancer-v2');
		expect(ids).toContain('morpho-blue');
		expect(ids).toContain('flashbank');
		expect(ids).toContain('uniswap-v3');
	});

	test('every provider has the required fields', () => {
		for (const p of FLASHLOAN_PROVIDERS) {
			expect(typeof p.id).toBe('string');
			expect(typeof p.name).toBe('string');
			expect(p.chain).toBe('ethereum');
			expect(p.chain_id).toBe(1);
			expect(typeof p.address).toBe('string');
			expect(typeof p.docs).toBe('string');
			expect(typeof p.liquidity_note).toBe('string');
			expect(typeof p.supports_multi_asset).toBe('boolean');
			expect(Array.isArray(p.notable_constraints)).toBe(true);
		}
	});

	test('FlashBank is included with the documented fee', () => {
		const fb = FLASHLOAN_PROVIDERS.find(p => p.id === 'flashbank');
		expect(fb).toBeDefined();
		expect(fb.fee_bps).toBe(2);
		expect(fb.docs).toContain('flashbank.net');
	});

	test('catalogue is frozen — accidental mutation is forbidden', () => {
		expect(() => { FLASHLOAN_PROVIDERS.push({ id: 'fake' }); }).toThrow();
	});
});

describe('rankByFee', () => {
	test('orders providers by ascending fee, skipping nulls', () => {
		const ranked = rankByFee();
		expect(ranked[0].fee_bps).toBeLessThanOrEqual(ranked[1].fee_bps);
		expect(ranked.every(p => p.fee_bps != null)).toBe(true);
	});

	test('Balancer / Morpho with 0bps are at the top', () => {
		const ranked = rankByFee();
		const first = ranked[0];
		expect(first.fee_bps).toBe(0);
	});
});

describe('filterProviders', () => {
	test('default returns the full ethereum catalogue', () => {
		const r = filterProviders();
		expect(r.length).toBe(FLASHLOAN_PROVIDERS.length);
	});

	test('maxFeeBps drops dearer providers', () => {
		const r = filterProviders({ maxFeeBps: 0 });
		expect(r.every(p => p.fee_bps === 0)).toBe(true);
		expect(r.length).toBeGreaterThan(0);
	});

	test('multiAsset=true filters to multi-asset providers only', () => {
		const r = filterProviders({ multiAsset: true });
		expect(r.every(p => p.supports_multi_asset)).toBe(true);
		expect(r.length).toBeGreaterThan(0);
	});

	test('unknown chain returns empty', () => {
		const r = filterProviders({ chain: 'optimism' });
		expect(r).toEqual([]);
	});

	test('null maxFeeBps is treated as no filter', () => {
		const r = filterProviders({ maxFeeBps: null });
		expect(r.length).toBe(FLASHLOAN_PROVIDERS.length);
	});
});
