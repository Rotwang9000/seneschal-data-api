// Penny Oracle — privacy-chain atomic facts.
//
// `queries-q.js` covers the DeFi-flavoured questions sourced from
// our own SQLite + shadow-blocks recorder. This module covers facts
// sourced from external full nodes — currently Monero (`monerod`)
// and Zcash (`zebra`) — exposed at $0.001 each via the same x402
// paywall.
//
// We talk JSON-RPC over HTTP because that's what both daemons natively
// speak. Each call wraps a tiny `fetch` with a hard timeout — agents
// pay for an answer, not for our node being slow — and the route
// handler in `rest-server.js` wraps THAT in a chain-cache so a hot
// loop hammering /v1/q/xmr/height costs the daemon zero extra work.

const DEFAULT_TIMEOUT_MS = 4000;

// ── tiny JSON-RPC helpers ────────────────────────────────────────

/**
 * Monero daemon JSON-RPC. monerod exposes a single endpoint at
 * `/json_rpc` for high-level methods (get_info, get_fee_estimate,
 * get_last_block_header), and a flat REST surface at `/get_transactions`
 * et al. for binary-style RPC. The high-level set is all we need.
 *
 * `fetchImpl` is injected so tests can use a deterministic stub
 * without relying on undici / nock.
 */
export async function monRpc(rpcUrl, method, params = {}, {
	fetchImpl = globalThis.fetch,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	id = 'seneschal'
} = {}) {
	if (!rpcUrl || typeof rpcUrl !== 'string') {
		throw new TypeError(`monRpc: rpcUrl is required (got ${rpcUrl})`);
	}
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${rpcUrl.replace(/\/$/, '')}/json_rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
			signal: ctrl.signal
		});
		if (!res.ok) {
			throw new Error(`monRpc ${method}: HTTP ${res.status}`);
		}
		const body = await res.json();
		if (body.error) {
			throw new Error(`monRpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
		}
		return body.result;
	} finally {
		clearTimeout(t);
	}
}

/**
 * Zebra (Zcash) speaks JSON-RPC 1.0 directly at the root path. The
 * surface mirrors zcashd's RPC: getblockchaininfo, getmempoolinfo,
 * getbestblockhash, getblockheader, getnetworkhashps.
 */
export async function zecRpc(rpcUrl, method, params = [], {
	fetchImpl = globalThis.fetch,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	id = 'seneschal'
} = {}) {
	if (!rpcUrl || typeof rpcUrl !== 'string') {
		throw new TypeError(`zecRpc: rpcUrl is required (got ${rpcUrl})`);
	}
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(rpcUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
			signal: ctrl.signal
		});
		if (!res.ok) {
			throw new Error(`zecRpc ${method}: HTTP ${res.status}`);
		}
		const body = await res.json();
		if (body.error) {
			throw new Error(`zecRpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
		}
		return body.result;
	} finally {
		clearTimeout(t);
	}
}

// ── Monero atomic facts ──────────────────────────────────────────

/**
 * Q: how high is the Monero chain?
 * Returns the top block height + whether monerod thinks it's synced.
 * `target_height: 0` is monerod's convention when synced — we
 * surface a friendlier `behind_blocks` field instead.
 */
export async function qXmrHeight(rpcUrl, deps = {}) {
	const info = await monRpc(rpcUrl, 'get_info', {}, deps);
	const tgt = Number(info.target_height ?? 0);
	const h = Number(info.height ?? 0);
	const behind = tgt === 0 ? 0 : Math.max(0, tgt - h);
	return {
		as_of_ms: Date.now(),
		chain: 'monero',
		height: h,
		synchronized: Boolean(info.synchronized),
		behind_blocks: behind,
		top_block_hash: info.top_block_hash ?? null,
		nettype: info.nettype ?? null
	};
}

/**
 * Q: how busy is the Monero mempool?
 * Returns the count of pending txs (`tx_pool_size` per monerod).
 * For byte size, callers should hit `get_transaction_pool` directly —
 * we don't expose that at $0.001 because the response is bulky.
 */
export async function qXmrMempool(rpcUrl, deps = {}) {
	const info = await monRpc(rpcUrl, 'get_info', {}, deps);
	return {
		as_of_ms: Date.now(),
		chain: 'monero',
		count: Number(info.tx_pool_size ?? 0),
		synchronized: Boolean(info.synchronized)
	};
}

/**
 * Q: what fee should I pay for next-block inclusion on Monero?
 * `get_fee_estimate` returns per-byte cost in piconero. We surface
 * the raw number plus a friendlier per-kilobyte version.
 */
export async function qXmrFee(rpcUrl, deps = {}) {
	const r = await monRpc(rpcUrl, 'get_fee_estimate', { grace_blocks: 10 }, deps);
	const perByte = Number(r.fee ?? 0);
	return {
		as_of_ms: Date.now(),
		chain: 'monero',
		fee_per_byte_piconero: perByte,
		fee_per_kb_piconero: perByte * 1024,
		quantization_mask: Number(r.quantization_mask ?? 1)
	};
}

/**
 * Q: how long ago did the last Monero block arrive?
 * Useful for hashrate-tracking / "is the chain stalled?" agents.
 */
export async function qXmrLastBlock(rpcUrl, deps = {}, { nowMs = Date.now() } = {}) {
	const r = await monRpc(rpcUrl, 'get_last_block_header', {}, deps);
	const ts = Number(r.block_header?.timestamp ?? 0) * 1000;
	return {
		as_of_ms: nowMs,
		chain: 'monero',
		height: Number(r.block_header?.height ?? 0),
		hash: r.block_header?.hash ?? null,
		timestamp_ms: ts,
		age_s: ts > 0 ? Math.round((nowMs - ts) / 1000) : null,
		difficulty: Number(r.block_header?.difficulty ?? 0),
		size_bytes: Number(r.block_header?.block_size ?? 0)
	};
}

// ── Zcash atomic facts ───────────────────────────────────────────

/**
 * Q: how high is the Zcash chain?
 * `getblockchaininfo` is the one-stop shop here. We surface a
 * boolean `synchronized` derived from `verificationprogress` so
 * callers don't have to know that 0.99999 ≈ "in sync".
 */
export async function qZecHeight(rpcUrl, deps = {}) {
	const info = await zecRpc(rpcUrl, 'getblockchaininfo', [], deps);
	const verify = Number(info.verificationprogress ?? 0);
	return {
		as_of_ms: Date.now(),
		chain: 'zcash',
		height: Number(info.blocks ?? 0),
		estimated_height: Number(info.estimatedheight ?? info.headers ?? 0),
		synchronized: verify >= 0.999,
		verification_progress: verify,
		best_block_hash: info.bestblockhash ?? null,
		chain_name: info.chain ?? null
	};
}

/**
 * Q: how busy is the Zcash mempool?
 * `getmempoolinfo` returns count + bytes + usage. We surface count
 * + bytes; usage is an implementation detail.
 */
export async function qZecMempool(rpcUrl, deps = {}) {
	const info = await zecRpc(rpcUrl, 'getmempoolinfo', [], deps);
	return {
		as_of_ms: Date.now(),
		chain: 'zcash',
		count: Number(info.size ?? 0),
		bytes: Number(info.bytes ?? 0)
	};
}

/**
 * Q: how long ago did the last Zcash block arrive?
 * Composed of two RPC calls — bestblockhash then blockheader. We
 * pay the round-trip cost once per cache entry (10s).
 */
export async function qZecLastBlock(rpcUrl, deps = {}, { nowMs = Date.now() } = {}) {
	const hash = await zecRpc(rpcUrl, 'getbestblockhash', [], deps);
	const header = await zecRpc(rpcUrl, 'getblockheader', [hash], deps);
	const ts = Number(header.time ?? 0) * 1000;
	return {
		as_of_ms: nowMs,
		chain: 'zcash',
		height: Number(header.height ?? 0),
		hash,
		timestamp_ms: ts,
		age_s: ts > 0 ? Math.round((nowMs - ts) / 1000) : null,
		difficulty: Number(header.difficulty ?? 0),
		size_bytes: Number(header.size ?? 0)
	};
}

// ── question registry (mirrors queries-q.js style) ───────────────
//
// The registry is intentionally separate from the DeFi questions so
// the chain wiring can be lazy-loaded; rest-server.js merges both
// into a single advertised catalogue.

export const CHAIN_QUESTION_REGISTRY = Object.freeze({
	'xmr/height':     { fn: 'qXmrHeight',     chain: 'monero', inputs: [] },
	'xmr/mempool':    { fn: 'qXmrMempool',    chain: 'monero', inputs: [] },
	'xmr/fee':        { fn: 'qXmrFee',        chain: 'monero', inputs: [] },
	'xmr/last-block': { fn: 'qXmrLastBlock',  chain: 'monero', inputs: [] },
	'zec/height':     { fn: 'qZecHeight',     chain: 'zcash',  inputs: [] },
	'zec/mempool':    { fn: 'qZecMempool',    chain: 'zcash',  inputs: [] },
	'zec/last-block': { fn: 'qZecLastBlock',  chain: 'zcash',  inputs: [] }
});

export async function dispatchChainQuestion({ name, deps = {}, rpcUrls }) {
	if (!Object.prototype.hasOwnProperty.call(CHAIN_QUESTION_REGISTRY, name)) {
		throw new TypeError(`chain question '${name}' not registered. Available: ${Object.keys(CHAIN_QUESTION_REGISTRY).join(', ')}`);
	}
	const entry = CHAIN_QUESTION_REGISTRY[name];
	const rpcUrl = entry.chain === 'monero' ? rpcUrls.monero : rpcUrls.zcash;
	if (!rpcUrl) {
		throw new Error(`chain '${entry.chain}' is not configured on this server (missing MONERO_RPC_URL / ZCASH_RPC_URL)`);
	}
	switch (entry.fn) {
		case 'qXmrHeight':    return qXmrHeight(rpcUrl, deps);
		case 'qXmrMempool':   return qXmrMempool(rpcUrl, deps);
		case 'qXmrFee':       return qXmrFee(rpcUrl, deps);
		case 'qXmrLastBlock': return qXmrLastBlock(rpcUrl, deps);
		case 'qZecHeight':    return qZecHeight(rpcUrl, deps);
		case 'qZecMempool':   return qZecMempool(rpcUrl, deps);
		case 'qZecLastBlock': return qZecLastBlock(rpcUrl, deps);
		default: throw new Error(`chain dispatch: unknown impl '${entry.fn}'`);
	}
}

// ── generic TTL cache for hot atomic-fact paths ──────────────────
//
// Agents hitting /v1/q/xmr/height in a tight loop would otherwise
// hammer the daemon for the same answer N times per second. We cache
// each `key`'s result for `ttlMs` milliseconds. The cache is a tiny
// in-memory Map; we keep a soft size cap so misbehaving callers
// can't OOM the process.

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 256;

export function createChainCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
	const store = new Map();
	function trim() {
		while (store.size > maxEntries) {
			const oldest = store.keys().next().value;
			store.delete(oldest);
		}
	}
	return {
		async get(key, loader) {
			const t = now();
			const hit = store.get(key);
			if (hit && hit.expires > t) return { ...hit.value, _cache: 'hit' };
			const fresh = await loader();
			const expires = t + ttlMs;
			store.delete(key);
			store.set(key, { value: fresh, expires });
			trim();
			return { ...fresh, _cache: 'miss' };
		},
		_size() { return store.size; },
		_purge() { store.clear(); }
	};
}
