// Tests for the privacy-chain Penny Oracle adapters. The unit tests
// stub `fetchImpl` so they're fully deterministic; the live tests
// (gated on the env vars SENESCHAL_TEST_MONERO=1 / _ZCASH=1) hit a
// real monerod / zebra node when one is available locally. The live
// path runs by default in dev environments where the daemons are
// reachable at the standard localhost ports — set the env vars to
// 0 to skip them in CI.

import { describe, test, expect, beforeAll } from '@jest/globals';

import {
	monRpc,
	zecRpc,
	qXmrHeight,
	qXmrMempool,
	qXmrFee,
	qXmrLastBlock,
	qZecHeight,
	qZecMempool,
	qZecLastBlock,
	dispatchChainQuestion,
	CHAIN_QUESTION_REGISTRY,
	createChainCache
} from '../src/queries-q-chain.js';

function stubFetchOk(body) {
	return async () => ({
		ok: true,
		status: 200,
		json: async () => body
	});
}

function stubFetchErr({ status = 500, errBody = null } = {}) {
	return async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => errBody ?? { error: { message: `HTTP ${status}` } }
	});
}

describe('monRpc', () => {
	test('returns result on 200', async () => {
		const r = await monRpc('http://x', 'm', {}, {
			fetchImpl: stubFetchOk({ result: { ok: 1 } })
		});
		expect(r).toEqual({ ok: 1 });
	});

	test('throws on HTTP error', async () => {
		await expect(monRpc('http://x', 'm', {}, {
			fetchImpl: stubFetchErr({ status: 502 })
		})).rejects.toThrow(/HTTP 502/);
	});

	test('throws on JSON-RPC error envelope', async () => {
		await expect(monRpc('http://x', 'm', {}, {
			fetchImpl: stubFetchOk({ error: { message: 'method not found' } })
		})).rejects.toThrow(/method not found/);
	});

	test('rejects empty rpcUrl', async () => {
		await expect(monRpc('', 'm')).rejects.toThrow(/rpcUrl is required/);
	});

	test('aborts on timeout', async () => {
		const slow = (_url, opts) => new Promise((_, reject) => {
			opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
		});
		await expect(monRpc('http://x', 'm', {}, {
			fetchImpl: slow,
			timeoutMs: 10
		})).rejects.toThrow(/aborted/);
	});
});

describe('zecRpc', () => {
	test('returns result on 200', async () => {
		const r = await zecRpc('http://x', 'm', [], {
			fetchImpl: stubFetchOk({ result: 'hash' })
		});
		expect(r).toBe('hash');
	});

	test('rejects empty rpcUrl', async () => {
		await expect(zecRpc('', 'm')).rejects.toThrow(/rpcUrl is required/);
	});

	test('throws on JSON-RPC error envelope', async () => {
		await expect(zecRpc('http://x', 'm', [], {
			fetchImpl: stubFetchOk({ error: { message: 'unknown' } })
		})).rejects.toThrow(/unknown/);
	});
});

describe('qXmr* adapters (stubbed)', () => {
	test('qXmrHeight surfaces sync state + behind blocks', async () => {
		const fetchImpl = stubFetchOk({
			result: {
				height: 3678425, target_height: 0, synchronized: true,
				top_block_hash: '7a4e35', nettype: 'mainnet'
			}
		});
		const r = await qXmrHeight('http://x', { fetchImpl });
		expect(r.chain).toBe('monero');
		expect(r.height).toBe(3678425);
		expect(r.synchronized).toBe(true);
		expect(r.behind_blocks).toBe(0);
		expect(r.nettype).toBe('mainnet');
	});

	test('qXmrHeight reports behind_blocks when target > height', async () => {
		const fetchImpl = stubFetchOk({
			result: { height: 100, target_height: 150, synchronized: false }
		});
		const r = await qXmrHeight('http://x', { fetchImpl });
		expect(r.behind_blocks).toBe(50);
		expect(r.synchronized).toBe(false);
	});

	test('qXmrMempool returns count', async () => {
		const fetchImpl = stubFetchOk({
			result: { tx_pool_size: 42, synchronized: true }
		});
		const r = await qXmrMempool('http://x', { fetchImpl });
		expect(r.count).toBe(42);
	});

	test('qXmrFee surfaces per-byte and per-kb', async () => {
		const fetchImpl = stubFetchOk({
			result: { fee: 20000, quantization_mask: 10000 }
		});
		const r = await qXmrFee('http://x', { fetchImpl });
		expect(r.fee_per_byte_piconero).toBe(20000);
		expect(r.fee_per_kb_piconero).toBe(20000 * 1024);
		expect(r.quantization_mask).toBe(10000);
	});

	test('qXmrLastBlock computes age', async () => {
		const fetchImpl = stubFetchOk({
			result: {
				block_header: {
					height: 100, hash: 'abc', timestamp: 1700000000,
					difficulty: 1000, block_size: 4096
				}
			}
		});
		const r = await qXmrLastBlock('http://x', { fetchImpl }, { nowMs: 1700000050_000 });
		expect(r.height).toBe(100);
		// timestamp is 1700000000 sec → 1700000000000 ms; now is
		// 1700000050000 ms → diff 50_000 ms → 50 s.
		expect(r.age_s).toBe(50);
		expect(r.size_bytes).toBe(4096);
	});

	test('qXmrLastBlock returns age_s null when timestamp missing', async () => {
		const fetchImpl = stubFetchOk({
			result: { block_header: { height: 0, hash: '', timestamp: 0 } }
		});
		const r = await qXmrLastBlock('http://x', { fetchImpl });
		expect(r.age_s).toBeNull();
	});
});

describe('qZec* adapters (stubbed)', () => {
	test('qZecHeight surfaces sync derived from verification progress', async () => {
		const fetchImpl = stubFetchOk({
			result: {
				blocks: 3349316, estimatedheight: 3349317, headers: 3349317,
				verificationprogress: 0.99999, bestblockhash: 'cbd', chain: 'main'
			}
		});
		const r = await qZecHeight('http://x', { fetchImpl });
		expect(r.height).toBe(3349316);
		expect(r.synchronized).toBe(true);
		expect(r.verification_progress).toBe(0.99999);
		expect(r.chain_name).toBe('main');
	});

	test('qZecHeight reports unsync when verifyprogress under 0.999', async () => {
		const fetchImpl = stubFetchOk({
			result: { blocks: 100, estimatedheight: 200, verificationprogress: 0.5 }
		});
		const r = await qZecHeight('http://x', { fetchImpl });
		expect(r.synchronized).toBe(false);
	});

	test('qZecMempool returns count + bytes', async () => {
		const fetchImpl = stubFetchOk({
			result: { size: 5, bytes: 12000, usage: 99 }
		});
		const r = await qZecMempool('http://x', { fetchImpl });
		expect(r.count).toBe(5);
		expect(r.bytes).toBe(12000);
	});

	test('qZecLastBlock chains getbestblockhash + getblockheader', async () => {
		let call = 0;
		const fetchImpl = async (_url, opts) => {
			call += 1;
			const body = JSON.parse(opts.body);
			if (body.method === 'getbestblockhash') {
				return { ok: true, status: 200, json: async () => ({ result: 'beef' }) };
			}
			if (body.method === 'getblockheader') {
				expect(body.params).toEqual(['beef']);
				return {
					ok: true, status: 200,
					json: async () => ({
						result: { height: 100, time: 1700000000, difficulty: 1, size: 2048 }
					})
				};
			}
			throw new Error(`unexpected method ${body.method}`);
		};
		const r = await qZecLastBlock('http://x', { fetchImpl }, { nowMs: 1700000010_000 });
		expect(call).toBe(2);
		expect(r.height).toBe(100);
		expect(r.hash).toBe('beef');
		// timestamp 1700000000 s → 1700000000000 ms; now 1700000010000 ms → 10_000 ms → 10 s.
		expect(r.age_s).toBe(10);
	});
});

describe('dispatchChainQuestion', () => {
	test('routes by name', async () => {
		const r = await dispatchChainQuestion({
			name: 'xmr/height',
			deps: { fetchImpl: stubFetchOk({
				result: { height: 1, target_height: 0, synchronized: true }
			}) },
			rpcUrls: { monero: 'http://x', zcash: 'http://y' }
		});
		expect(r.height).toBe(1);
	});

	test('throws on unconfigured chain', async () => {
		await expect(dispatchChainQuestion({
			name: 'xmr/height',
			deps: {},
			rpcUrls: { monero: null, zcash: 'http://y' }
		})).rejects.toThrow(/monero.*not configured/);
	});

	test('throws on unknown question', async () => {
		await expect(dispatchChainQuestion({
			name: 'xmr/bogus',
			deps: {},
			rpcUrls: { monero: 'http://x' }
		})).rejects.toThrow(/not registered/);
	});

	test('registry advertises 7 chain questions', () => {
		expect(Object.keys(CHAIN_QUESTION_REGISTRY).sort()).toEqual([
			'xmr/fee',
			'xmr/height',
			'xmr/last-block',
			'xmr/mempool',
			'zec/height',
			'zec/last-block',
			'zec/mempool'
		]);
	});
});

describe('createChainCache', () => {
	test('returns miss then hit within TTL', async () => {
		let calls = 0;
		const cache = createChainCache({ ttlMs: 100 });
		const loader = async () => { calls += 1; return { v: calls }; };
		const first = await cache.get('k', loader);
		const second = await cache.get('k', loader);
		expect(first._cache).toBe('miss');
		expect(second._cache).toBe('hit');
		expect(first.v).toBe(1);
		expect(second.v).toBe(1);
		expect(calls).toBe(1);
	});

	test('expires after TTL', async () => {
		let t = 0;
		const cache = createChainCache({ ttlMs: 50, now: () => t });
		await cache.get('k', async () => ({ v: 1 }));
		t = 200;
		const r = await cache.get('k', async () => ({ v: 2 }));
		expect(r.v).toBe(2);
		expect(r._cache).toBe('miss');
	});

	test('evicts oldest beyond maxEntries', async () => {
		const cache = createChainCache({ ttlMs: 60_000, maxEntries: 2 });
		await cache.get('a', async () => ({ v: 'a' }));
		await cache.get('b', async () => ({ v: 'b' }));
		await cache.get('c', async () => ({ v: 'c' }));
		expect(cache._size()).toBe(2);
	});
});

// ── live tests ───────────────────────────────────────────────────
// These hit the real local nodes. Skipped automatically when
// SENESCHAL_TEST_MONERO=0 / _ZCASH=0 is set (e.g. in CI).
const MONERO_URL = process.env.SENESCHAL_TEST_MONERO_URL ?? 'http://127.0.0.1:18081';
const ZCASH_URL = process.env.SENESCHAL_TEST_ZCASH_URL ?? 'http://127.0.0.1:8232';
const RUN_MONERO_LIVE = process.env.SENESCHAL_TEST_MONERO !== '0';
const RUN_ZCASH_LIVE = process.env.SENESCHAL_TEST_ZCASH !== '0';

describe('live Monero adapters', () => {
	let online = false;
	beforeAll(async () => {
		if (!RUN_MONERO_LIVE) return;
		try {
			await monRpc(MONERO_URL, 'get_info', {}, { timeoutMs: 1500 });
			online = true;
		} catch { online = false; }
	});

	test('qXmrHeight against live node', async () => {
		if (!online) return;
		const r = await qXmrHeight(MONERO_URL);
		expect(r.chain).toBe('monero');
		expect(r.height).toBeGreaterThan(3_500_000);
	});

	test('qXmrFee against live node', async () => {
		if (!online) return;
		const r = await qXmrFee(MONERO_URL);
		expect(r.fee_per_byte_piconero).toBeGreaterThan(0);
	});

	test('qXmrLastBlock against live node', async () => {
		if (!online) return;
		const r = await qXmrLastBlock(MONERO_URL);
		expect(r.height).toBeGreaterThan(3_500_000);
		expect(r.age_s).toBeGreaterThanOrEqual(0);
	});
});

describe('live Zcash adapters', () => {
	let online = false;
	beforeAll(async () => {
		if (!RUN_ZCASH_LIVE) return;
		try {
			await zecRpc(ZCASH_URL, 'getblockchaininfo', [], { timeoutMs: 1500 });
			online = true;
		} catch { online = false; }
	});

	test('qZecHeight against live node', async () => {
		if (!online) return;
		const r = await qZecHeight(ZCASH_URL);
		expect(r.chain).toBe('zcash');
		expect(r.height).toBeGreaterThan(3_000_000);
		expect(r.chain_name).toBe('main');
	});

	test('qZecLastBlock against live node', async () => {
		if (!online) return;
		const r = await qZecLastBlock(ZCASH_URL);
		expect(r.height).toBeGreaterThan(3_000_000);
		expect(r.age_s).toBeGreaterThanOrEqual(0);
	});
});
