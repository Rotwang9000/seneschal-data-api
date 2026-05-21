// Thin client over the local NFPT wallet-scanner API
// (https://github.com/Rotwang9000/NFPT). NFPT already runs the
// expensive bits — monero-lws subscription for view-key based balance
// scanning, an Orchard UFVK scanner for Zcash — so this module just
// adapts its job-style endpoints into the surface our poller needs.
//
// NFPT contract (recap):
//
//   POST /api/wallet-scanner/monero/scan/job
//     body { address, viewKey, fromHeight? } -> { jobId, jobToken }
//   GET  /api/wallet-scanner/monero/scan/job/:jobId
//     headers x-job-token; returns { status, progress, balance }
//   DELETE same path -> cancels
//
//   POST /api/wallet-scanner/orchard/scan-ufvk/job
//     body { ufvk, birthdayHeight?, endHeight?, autoDetect? }
//      -> { jobId, jobToken }
//   GET /api/wallet-scanner/orchard/scan-ufvk/job/:jobId
//     returns { status, progress, results: { notes: [...] } }
//
// Everything below is pure JSON-RPC-style HTTP — no streaming, no
// websockets — so we can stub `fetchImpl` in tests with zero ceremony.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:3555';

/**
 * Create a client bound to a particular NFPT host. All methods accept
 * the client object as the first argument so unit tests can construct
 * a stub fetch and inject it cleanly.
 */
export function createNfptClient({
	baseUrl = DEFAULT_BASE_URL,
	apiKey = 'development-key-for-testing',
	timeoutMs = DEFAULT_TIMEOUT_MS,
	fetchImpl = globalThis.fetch
} = {}) {
	if (typeof baseUrl !== 'string' || !/^https?:\/\//u.test(baseUrl)) {
		throw new TypeError(`createNfptClient: baseUrl=${baseUrl} must be an http(s) URL`);
	}
	if (typeof apiKey !== 'string' || apiKey.length === 0) {
		throw new TypeError('createNfptClient: apiKey is required');
	}
	if (typeof fetchImpl !== 'function') {
		throw new TypeError('createNfptClient: fetchImpl must be a function (e.g. globalThis.fetch)');
	}
	return Object.freeze({
		baseUrl: baseUrl.replace(/\/$/u, ''),
		apiKey,
		timeoutMs,
		fetchImpl
	});
}

function authHeaders(client, extra = {}) {
	return {
		'content-type': 'application/json',
		'accept': 'application/json',
		'x-api-key': client.apiKey,
		...extra
	};
}

async function nfptFetch(client, path, init = {}) {
	const url = `${client.baseUrl}${path}`;
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(new Error('nfpt: request timed out')), client.timeoutMs);
	try {
		const res = await client.fetchImpl(url, {
			...init,
			signal: ac.signal,
			headers: { ...(init.headers || {}) }
		});
		const text = await res.text();
		let body = null;
		if (text) {
			try { body = JSON.parse(text); }
			catch { body = { raw: text }; }
		}
		return { status: res.status, body };
	}
	finally {
		clearTimeout(t);
	}
}

/** Start a fresh Monero scan job on NFPT for (address, viewKey). */
export async function startMoneroJob(client, { address, viewKey, fromHeight }) {
	if (!address || !viewKey) {
		throw new TypeError('startMoneroJob: address and viewKey are required');
	}
	const { status, body } = await nfptFetch(client, '/api/wallet-scanner/monero/scan/job', {
		method: 'POST',
		headers: authHeaders(client),
		body: JSON.stringify({ address, viewKey, fromHeight })
	});
	if (status !== 202 && status !== 200) {
		throw new Error(`startMoneroJob: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	const { jobId, jobToken } = body?.data ?? {};
	if (!jobId || !jobToken) {
		throw new Error(`startMoneroJob: NFPT returned no jobId/jobToken (body=${describe(body)})`);
	}
	return { jobId, jobToken };
}

/** Poll a Monero scan job, returning the normalised snapshot. */
export async function pollMoneroJob(client, { jobId, jobToken }) {
	if (!jobId) throw new TypeError('pollMoneroJob: jobId is required');
	const { status, body } = await nfptFetch(client, `/api/wallet-scanner/monero/scan/job/${encodeURIComponent(jobId)}`, {
		method: 'GET',
		headers: authHeaders(client, { 'x-job-token': jobToken ?? '' })
	});
	if (status === 404) return { found: false };
	if (status === 403) return { found: false, forbidden: true };
	if (status !== 200) {
		throw new Error(`pollMoneroJob: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	const job = body?.data?.job;
	if (!job) {
		throw new Error(`pollMoneroJob: NFPT returned no job payload (body=${describe(body)})`);
	}
	return { found: true, snapshot: normaliseMonero(job) };
}

/** Cancel a Monero scan job (best-effort). */
export async function cancelMoneroJob(client, { jobId, jobToken }) {
	if (!jobId) return { cancelled: false };
	const { status } = await nfptFetch(client, `/api/wallet-scanner/monero/scan/job/${encodeURIComponent(jobId)}`, {
		method: 'DELETE',
		headers: authHeaders(client, { 'x-job-token': jobToken ?? '' })
	});
	return { cancelled: status === 200 };
}

/** Start a fresh Orchard scan job on NFPT for (ufvk, birthdayHeight). */
export async function startOrchardJob(client, { ufvk, birthdayHeight, autoDetect, endHeight }) {
	if (!ufvk) throw new TypeError('startOrchardJob: ufvk is required');
	const { status, body } = await nfptFetch(client, '/api/wallet-scanner/orchard/scan-ufvk/job', {
		method: 'POST',
		headers: authHeaders(client),
		body: JSON.stringify({ ufvk, birthdayHeight, endHeight, autoDetect: autoDetect === true })
	});
	if (status !== 202 && status !== 200) {
		throw new Error(`startOrchardJob: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	const { jobId, jobToken } = body?.data ?? {};
	if (!jobId || !jobToken) {
		throw new Error(`startOrchardJob: NFPT returned no jobId/jobToken (body=${describe(body)})`);
	}
	return { jobId, jobToken };
}

/** Poll an Orchard scan job, returning the normalised snapshot. */
export async function pollOrchardJob(client, { jobId, jobToken }) {
	if (!jobId) throw new TypeError('pollOrchardJob: jobId is required');
	const { status, body } = await nfptFetch(client, `/api/wallet-scanner/orchard/scan-ufvk/job/${encodeURIComponent(jobId)}`, {
		method: 'GET',
		headers: authHeaders(client, { 'x-job-token': jobToken ?? '' })
	});
	if (status === 404) return { found: false };
	if (status === 403) return { found: false, forbidden: true };
	if (status !== 200) {
		throw new Error(`pollOrchardJob: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	const job = body?.data?.job;
	if (!job) {
		throw new Error(`pollOrchardJob: NFPT returned no job payload (body=${describe(body)})`);
	}
	return { found: true, snapshot: normaliseOrchard(job) };
}

/** Cancel an Orchard scan job (best-effort). */
export async function cancelOrchardJob(client, { jobId, jobToken }) {
	if (!jobId) return { cancelled: false };
	const { status } = await nfptFetch(client, `/api/wallet-scanner/orchard/scan-ufvk/job/${encodeURIComponent(jobId)}`, {
		method: 'DELETE',
		headers: authHeaders(client, { 'x-job-token': jobToken ?? '' })
	});
	return { cancelled: status === 200 };
}

/**
 * Quick liveness probe — no API key required for the upstream
 * /health, but we send it anyway so callers see the same auth surface
 * as the rest of the methods.
 */
export async function healthCheck(client) {
	const { status, body } = await nfptFetch(client, '/api/wallet-scanner/lightwallet/status', {
		method: 'GET',
		headers: authHeaders(client)
	});
	return {
		ok: status === 200,
		status,
		lightwallet: body?.data?.lightwallet ?? null
	};
}

/**
 * Derive a Zcash Unified Full Viewing Key (UFVK) from a BIP-39
 * mnemonic. Thin wrapper around NFPT's `/orchard/export-ufvk` route
 * which itself shells out to the orchard-scanner Rust binary. The
 * mnemonic is forwarded verbatim — caller is responsible for the
 * security warning that ships with the data-api endpoint.
 */
export async function deriveUfvk(client, { mnemonic, network = 'mainnet' }) {
	if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
		throw new TypeError('deriveUfvk: mnemonic is required');
	}
	const { status, body } = await nfptFetch(client, '/api/wallet-scanner/orchard/export-ufvk', {
		method: 'POST',
		headers: authHeaders(client),
		body: JSON.stringify({ mnemonic, network })
	});
	if (status !== 200) {
		throw new Error(`deriveUfvk: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	const payload = body?.data ?? body ?? {};
	const ufvk = payload.ufvk ?? payload.unifiedFvk ?? null;
	if (typeof ufvk !== 'string' || !ufvk.startsWith('uview')) {
		throw new Error(`deriveUfvk: NFPT returned no UFVK (body=${describe(body)})`);
	}
	return {
		ufvk,
		sapling_fvk: payload.sapling_fvk ?? payload.saplingFvk ?? null,
		transparent_fvk: payload.transparent_fvk ?? payload.transparentFvk ?? null
	};
}

/**
 * Run a synchronous historical scan for the given chain. Internally
 * this opens an NFPT job, polls until `status === 'completed'`, then
 * normalises the result into a chain-agnostic summary. The view key
 * is held in memory only — we never touch the data-api SQLite.
 *
 * Returns:
 *   { totals: { received_atomic, spent_atomic, balance_atomic },
 *     notes: [...],            // present iff includeNotes
 *     blocks_scanned, latest_height, chain_height,
 *     truncated: bool          // true if notes > maxNotes
 *   }
 */
export async function scanHistorical(client, {
	chain,
	address,
	viewKey,
	birthdayHeight,
	toHeight,
	includeNotes = false,
	maxNotes = 5_000,
	pollIntervalMs = 1_500,
	maxWaitMs = 240_000
}) {
	if (chain !== 'monero' && chain !== 'zcash') {
		throw new TypeError(`scanHistorical: chain must be 'monero' or 'zcash'`);
	}
	// For Zcash we deliberately turn autoDetect ON for historical
	// lookups — the user has explicitly paid for a (possibly
	// minutes-long) scan and we want to find their earliest note
	// without making them guess a birthday height.
	const started = chain === 'monero'
		? await startMoneroJob(client, { address, viewKey, fromHeight: birthdayHeight })
		: await startOrchardJob(client, {
			ufvk: viewKey,
			birthdayHeight: birthdayHeight ?? undefined,
			endHeight: toHeight ?? undefined,
			autoDetect: birthdayHeight == null
		});
	const startedAt = Date.now();
	let lastJob = null;
	while (Date.now() - startedAt < maxWaitMs) {
		const polled = chain === 'monero'
			? await pollMoneroJob(client, started)
			: await pollOrchardJob(client, started);
		if (!polled.found) {
			throw new Error(`scanHistorical: NFPT lost the job (chain=${chain}, jobId=${started.jobId})`);
		}
		lastJob = polled.snapshot;
		if (lastJob.error) {
			throw new Error(`scanHistorical: upstream error: ${lastJob.error}`);
		}
		const isComplete = lastJob.status === 'completed'
			|| (lastJob.scanProgress != null && lastJob.scanProgress >= 0.999);
		if (isComplete) break;
		await sleep(pollIntervalMs);
	}
	if (!lastJob) {
		throw new Error('scanHistorical: NFPT never returned a job snapshot');
	}
	// Pull the per-note breakdown from the raw upstream when the
	// caller asked for it. The normalise* functions reduce to the
	// summary numbers; for historical we want richer detail.
	const fullJob = await fetchRawJob(client, chain, started);
	const notes = collectHistoricalNotes(chain, fullJob, maxNotes);
	const totals = computeHistoricalTotals(notes, lastJob);
	// Best-effort cancel so we don't tie up an NFPT slot indefinitely.
	try {
		if (chain === 'monero') await cancelMoneroJob(client, started);
		else await cancelOrchardJob(client, started);
	}
	catch { /* swallow — the job was already complete */ }
	return {
		chain,
		totals,
		notes: includeNotes ? notes.slice(0, maxNotes).map(n => publicNote(chain, n)) : null,
		blocks_scanned: fullJob?.progress?.blocksScanned ?? fullJob?.progress?.totalBlocks ?? null,
		latest_height: lastJob.scannedHeight ?? null,
		chain_height: lastJob.chainHeight ?? null,
		truncated: notes.length > maxNotes
	};
}

async function fetchRawJob(client, chain, { jobId, jobToken }) {
	const path = chain === 'monero'
		? `/api/wallet-scanner/monero/scan/job/${encodeURIComponent(jobId)}`
		: `/api/wallet-scanner/orchard/scan-ufvk/job/${encodeURIComponent(jobId)}`;
	const { status, body } = await nfptFetch(client, path, {
		method: 'GET',
		headers: authHeaders(client, { 'x-job-token': jobToken ?? '' })
	});
	if (status !== 200) {
		throw new Error(`fetchRawJob: NFPT returned HTTP ${status}: ${describe(body)}`);
	}
	return body?.data?.job ?? null;
}

function collectHistoricalNotes(chain, job, _maxNotes) {
	if (!job) return [];
	if (chain === 'zcash') {
		const notes = Array.isArray(job?.results?.notes) ? job.results.notes : [];
		return notes;
	}
	const txs = Array.isArray(job?.transactions) ? job.transactions : [];
	return txs;
}

function computeHistoricalTotals(notes, snapshot) {
	if (!Array.isArray(notes) || notes.length === 0) {
		return {
			received_atomic: snapshot.receivedAtomic ?? '0',
			spent_atomic: '0',
			balance_atomic: snapshot.balanceAtomic ?? '0',
			note_count: 0,
			unspent_note_count: 0
		};
	}
	let received = 0n;
	let spent = 0n;
	let unspent = 0;
	for (const n of notes) {
		const v = toBigInt(n?.value ?? n?.amount ?? n?.amountAtomic ?? 0);
		if (v === null) continue;
		// Monero "received" txs vs Zcash notes: both have a value;
		// Zcash also marks spent.
		received += v;
		if (n?.spent === true || n?.spent_atomic) {
			spent += v;
		}
		else {
			unspent += 1;
		}
	}
	return {
		received_atomic: received.toString(),
		spent_atomic: spent.toString(),
		balance_atomic: (received - spent).toString(),
		note_count: notes.length,
		unspent_note_count: unspent
	};
}

function publicNote(chain, n) {
	if (chain === 'zcash') {
		return {
			value_atomic: stringOrNull(n?.value),
			block_height: n?.height ?? n?.blockHeight ?? null,
			tx_hash: n?.txHash ?? n?.txid ?? null,
			spent: n?.spent === true,
			memo_present: Boolean(n?.memo || n?.memoHex)
		};
	}
	return {
		amount_atomic: stringOrNull(n?.amount ?? n?.value ?? n?.amountAtomic),
		block_height: n?.blockHeight ?? n?.height ?? null,
		tx_hash: n?.txHash ?? n?.txid ?? null,
		direction: n?.direction ?? null,
		spent: n?.spent === true
	};
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

// ─── Internal normalisers ────────────────────────────────────────

/** Reduce the NFPT Monero job summary to a stable shape we diff on. */
export function normaliseMonero(job) {
	const balance = job?.balance ?? {};
	const progress = job?.progress ?? {};
	return {
		chain: 'monero',
		status: job?.status ?? 'unknown',
		balanceAtomic: stringOrNull(balance.totalAtomic),
		spendableAtomic: stringOrNull(balance.spendableAtomic),
		lockedAtomic: stringOrNull(balance.lockedAtomic),
		pendingInAtomic: stringOrNull(balance.pendingInAtomic),
		pendingOutAtomic: stringOrNull(balance.pendingOutAtomic),
		scannedHeight: progress.scannedHeight ?? balance.scannedHeight ?? 0,
		chainHeight: progress.chainHeight ?? balance.chainHeight ?? 0,
		scanProgress: progress.scanProgress ?? balance.scanProgress ?? 0,
		percentComplete: progress.percentComplete ?? Math.round((progress.scanProgress ?? 0) * 100),
		error: job?.error ?? null
	};
}

/** Reduce the NFPT Orchard job summary to a stable shape we diff on. */
export function normaliseOrchard(job) {
	const progress = job?.progress ?? {};
	const notes = Array.isArray(job?.results?.notes) ? job.results.notes : [];
	let receivedAtomic = 0n;
	let unspentAtomic = 0n;
	for (const n of notes) {
		const v = toBigInt(n?.value);
		if (v === null) continue;
		receivedAtomic += v;
		if (n?.spent !== true) unspentAtomic += v;
	}
	return {
		chain: 'zcash',
		status: job?.status ?? 'unknown',
		balanceAtomic: unspentAtomic.toString(),
		receivedAtomic: receivedAtomic.toString(),
		notes: notes.length,
		unspentNotes: notes.filter((n) => n?.spent !== true).length,
		scannedHeight: progress.scannedToHeight ?? progress.endHeight ?? 0,
		chainHeight: progress.chainTip ?? progress.endHeight ?? 0,
		scanProgress: progress.percentComplete != null ? progress.percentComplete / 100 : 0,
		percentComplete: progress.percentComplete ?? 0,
		error: job?.error ?? null
	};
}

function stringOrNull(v) {
	if (v === undefined || v === null) return null;
	return String(v);
}

function toBigInt(v) {
	if (v === null || v === undefined) return null;
	try { return BigInt(v); }
	catch { return null; }
}

function describe(body) {
	if (body == null) return '(no body)';
	const s = typeof body === 'string' ? body : JSON.stringify(body);
	return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}
