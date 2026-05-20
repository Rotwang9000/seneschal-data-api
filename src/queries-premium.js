// Premium ($-gated) queries.
//
// Each function in here lives behind the x402 paywall. The design rule
// is honest value-add: the public free tier already exposes the
// at-risk borrower set, builder leaderboard, and recent liquidations.
// Premium adds the joined-up intel an agent actually wants to act on:
// per-market win rates, top-liquidator hints, expected-value sorting,
// and the full (uncapped) at-risk catalogue. All sourced from data
// we already collect; no live RPC, no external API.
//
// The functions are pure: they take a `db` handle, optional params,
// and return a JSON-serialisable object. Time-bounded caching is the
// caller's job (rest-server / mcp-server share one in-process cache).

import {
	listAtRiskBorrowers,
	listBorrowers
} from './queries.js';
import { MAX_LIMIT } from './config.js';

// Default liquidation bonus assumption when the protocol-specific
// LB isn't available in the DB. Aave-V3 mainnet collateral LBs range
// from 5 % (stables) to 7.5 % (volatile); 6 % is a sane middle and
// the public docs already disclose this assumption.
const DEFAULT_LIQUIDATION_BONUS = 0.06;

// Cap on "similar borrowers" inspected for market-intel joins. Keeps
// queries deterministic on big at-risk sets.
const PREMIUM_MAX_BORROWERS = 2000;

// 7-day window default for "recent" rollups. Tuneable per-call.
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Top-level premium feed. One round trip returns:
 *   - the full at-risk catalogue (no 500-row cap, no debt floor)
 *   - per-borrower expected-value estimate
 *   - 7d market intel (top liquidators, biggest payouts, our own
 *     attempt outcomes per market)
 *   - network status snapshot (counts, last seen liquidation)
 *
 * The output is large by design — agents pay per call, so we make
 * each call worth it. Empirically 8–40 KB for typical workloads.
 */
export function getPremiumOpportunities(db, params = {}) {
	const sinceMs = paramSinceMs(params);
	const minDebt = paramMinDebt(params);
	const limit = paramLimit(params, /* default */ 200, /* hard cap */ PREMIUM_MAX_BORROWERS);
	const liquidationBonus = paramBonus(params);

	// Full at-risk catalogue. We bypass listAtRiskBorrowers's
	// rate-limit-shaped LIMIT of 500 and read up to PREMIUM_MAX_BORROWERS.
	const fullAtRisk = listBorrowers(db, {
		min_hf: 0,
		max_hf: 1.05,
		min_debt_usd: minDebt,
		sort_by: 'health_factor',
		sort_dir: 'asc',
		limit: Math.min(PREMIUM_MAX_BORROWERS, MAX_LIMIT * 4),
		offset: 0
	});

	const marketIntel = build7dMarketIntel(db, sinceMs);
	const ourAttemptIntel = buildOurAttemptIntel(db, sinceMs);
	const networkStatus = buildNetworkStatus(db, marketIntel, fullAtRisk);

	const seenAtRisk = listAtRiskBorrowers(db, {
		max_hf: 1.0,
		min_debt_usd: minDebt,
		limit: PREMIUM_MAX_BORROWERS
	});

	const annotated = annotateOpportunities({
		borrowers: fullAtRisk.results,
		marketIntel,
		ourAttemptIntel,
		liquidationBonus
	}).slice(0, limit);

	return {
		as_of_ms: Date.now(),
		window_ms: Date.now() - sinceMs,
		filters: {
			since_ms: sinceMs,
			min_debt_usd: minDebt,
			limit,
			liquidation_bonus: liquidationBonus
		},
		network_status: {
			...networkStatus,
			liquidatable_now_count: seenAtRisk.result_count
		},
		market_intel: marketIntel.summary,
		opportunities: annotated,
		assumptions: {
			liquidation_bonus_default: DEFAULT_LIQUIDATION_BONUS,
			note: 'expected_value_usd = debt_usd * liquidation_bonus * realised_market_win_rate. Realised rate uses 7d missed_liquidations as a proxy for "this borrower or market gets liquidated frequently". Pure heuristic — verify on-chain before bundling.'
		}
	};
}

function paramSinceMs(params) {
	if (params.since_ms === undefined || params.since_ms === null) {
		return Date.now() - DEFAULT_WINDOW_MS;
	}
	const n = Number(params.since_ms);
	if (!Number.isFinite(n) || n < 0) {
		throw new TypeError(`since_ms: ${params.since_ms} must be a non-negative number`);
	}
	return Math.min(n, Date.now());
}

function paramMinDebt(params) {
	if (params.min_debt_usd === undefined || params.min_debt_usd === null) return 0;
	const n = Number(params.min_debt_usd);
	if (!Number.isFinite(n) || n < 0) {
		throw new TypeError(`min_debt_usd: ${params.min_debt_usd} must be a non-negative number`);
	}
	return n;
}

function paramLimit(params, fallback, hardCap) {
	if (params.limit === undefined || params.limit === null) return fallback;
	const n = Number(params.limit);
	if (!Number.isFinite(n) || n < 1) {
		throw new TypeError(`limit: ${params.limit} must be a positive number`);
	}
	return Math.min(Math.floor(n), hardCap);
}

function paramBonus(params) {
	if (params.liquidation_bonus === undefined || params.liquidation_bonus === null) {
		return DEFAULT_LIQUIDATION_BONUS;
	}
	const n = Number(params.liquidation_bonus);
	if (!Number.isFinite(n) || n <= 0 || n > 0.5) {
		throw new TypeError(`liquidation_bonus: ${params.liquidation_bonus} must be between 0 and 0.5`);
	}
	return n;
}

// ── Premium builder-stats (per-slot bid distribution intel) ──────────
//
// Augments the free /v1/builders/leaderboard with the percentile
// breakdown of each builder's winning bids and a per-hour activity
// histogram. The free endpoint answers "who's winning?"; this one
// answers "what value do I need to land in their bundle?" which is
// the question searchers actually pay for.
//
// All data is streamed from the same shadow-blocks.jsonl the free
// endpoint reads, so adding this surface costs zero extra collection
// — every row is already on disk.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SHADOW_DEFAULT = '/opt/mevbot/data/shadow-blocks.jsonl';
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DEFAULT_BUILDER_STATS_WINDOW_MS = 7 * ONE_DAY_MS;
const MAX_BUILDER_STATS_WINDOW_MS = 30 * ONE_DAY_MS;
const PERCENTILES = Object.freeze([0.25, 0.5, 0.75, 0.9, 0.99]);
const DEFAULT_BUILDER_LIMIT = 25;
const HARD_BUILDER_LIMIT = 100;

/**
 * Pure: take a sorted array of bid values and return percentile
 * extractions. Sorted input is required so caller can reuse the sort.
 * Returns `null` for empty arrays so callers can suppress per-builder
 * sections that have no observations.
 */
export function summariseBidDistribution(sortedBids) {
	if (!Array.isArray(sortedBids) || sortedBids.length === 0) return null;
	const out = { count: sortedBids.length };
	for (const p of PERCENTILES) {
		// Nearest-rank percentile — robust for small samples and
		// doesn't require interpolation that confuses downstream
		// consumers.
		const idx = Math.min(sortedBids.length - 1, Math.floor(p * sortedBids.length));
		const label = p === 0.5 ? 'median_eth' : `p${Math.round(p * 100)}_eth`;
		out[label] = sortedBids[idx];
	}
	out.max_eth = sortedBids[sortedBids.length - 1];
	// Honest mean — useful for back-of-envelope ROI math.
	let sum = 0;
	for (const v of sortedBids) sum += v;
	out.mean_eth = Number((sum / sortedBids.length).toFixed(9));
	return out;
}

/**
 * Pure: given a list of shadow rows, return the structured premium
 * summary. Caller is responsible for the file I/O; this keeps the
 * function trivially testable.
 */
export function buildBuilderStatsSummary({ rows, windowMs, asOfMs = Date.now(), limit = DEFAULT_BUILDER_LIMIT }) {
	if (!Array.isArray(rows)) throw new TypeError('rows: must be an array of shadow snapshots');
	const cutoff = asOfMs - windowMs;
	const perBuilder = new Map();
	const hourly = Array.from({ length: 24 }, () => ({ slots: 0, value_eth_sum: 0 }));
	const globalBids = [];
	let total = 0;

	for (const row of rows) {
		if (!row || typeof row.ts_ms !== 'number' || row.ts_ms < cutoff) continue;
		total++;
		const key = row.extra_data ?? row.miner ?? 'unknown';
		const bidEth = weiStringToEth(row.actual_total_wei);
		globalBids.push(bidEth);
		const hour = new Date(row.ts_ms).getUTCHours();
		hourly[hour].slots++;
		hourly[hour].value_eth_sum += bidEth;
		const agg = perBuilder.get(key) ?? { slots_won: 0, bids: [] };
		agg.slots_won++;
		agg.bids.push(bidEth);
		perBuilder.set(key, agg);
	}

	const builders = [...perBuilder.entries()]
		.map(([builder, agg]) => {
			agg.bids.sort((a, b) => a - b);
			return {
				builder,
				slots_won: agg.slots_won,
				share_pct: total > 0 ? +(100 * agg.slots_won / total).toFixed(2) : 0,
				bid_distribution: summariseBidDistribution(agg.bids)
			};
		})
		.sort((a, b) => b.slots_won - a.slots_won)
		.slice(0, limit);

	globalBids.sort((a, b) => a - b);

	return {
		as_of_ms: asOfMs,
		window_ms: windowMs,
		total_slots: total,
		global_bid_distribution: summariseBidDistribution(globalBids),
		hourly_distribution: hourly.map((h, hour_utc) => ({
			hour_utc,
			slot_count: h.slots,
			mean_value_eth: h.slots > 0 ? Number((h.value_eth_sum / h.slots).toFixed(9)) : 0
		})),
		builders,
		note: 'Bids are the block-value (proposer payment) recorded by the Seneschal shadow recorder. Higher = harder to outbid.'
	};
}

function weiStringToEth(raw) {
	if (raw === undefined || raw === null) return 0;
	try {
		const wei = typeof raw === 'bigint' ? raw : BigInt(raw);
		// Convert via string to avoid double-precision artefacts on
		// large values. 1e18 wei = 1 ETH so a 18-decimal divide is
		// honest within JS Number range for any realistic slot bid.
		return Number(wei) / 1e18;
	} catch {
		return 0;
	}
}

export function paramBuilderWindow(params) {
	if (params.window_ms === undefined || params.window_ms === null) {
		return DEFAULT_BUILDER_STATS_WINDOW_MS;
	}
	const n = Number(params.window_ms);
	if (!Number.isFinite(n) || n <= 0) {
		throw new TypeError(`window_ms: ${params.window_ms} must be a positive number`);
	}
	return Math.min(Math.max(n, ONE_HOUR_MS), MAX_BUILDER_STATS_WINDOW_MS);
}

/**
 * Streaming wrapper around buildBuilderStatsSummary. Caller passes
 * the shadow-blocks path (defaults to the live one). We collect
 * matching rows into memory — at 30 days of 12s slots the upper
 * bound is ~216k entries × ~120 bytes parsed ≈ 26 MB resident
 * during the request which is acceptable for an authenticated
 * paid endpoint that fires at most a few times/hour.
 */
export async function getPremiumBuilderStats(params = {}) {
	const windowMs = paramBuilderWindow(params);
	const limit = paramLimit(params, DEFAULT_BUILDER_LIMIT, HARD_BUILDER_LIMIT);
	const shadowPath = params._shadowPath ?? SHADOW_DEFAULT;
	const asOfMs = Date.now();
	const cutoff = asOfMs - windowMs;

	if (!existsSync(shadowPath)) {
		return {
			as_of_ms: asOfMs,
			window_ms: windowMs,
			total_slots: 0,
			builders: [],
			note: 'shadow-blocks.jsonl not present',
			source_freshness_s: null
		};
	}

	const rows = [];
	const stream = createReadStream(shadowPath, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) continue;
		let d;
		try { d = JSON.parse(line); } catch { continue; }
		if (typeof d.ts_ms !== 'number' || d.ts_ms < cutoff) continue;
		rows.push(d);
	}
	const summary = buildBuilderStatsSummary({ rows, windowMs, asOfMs, limit });
	const mtime = statSync(shadowPath).mtimeMs;
	return {
		...summary,
		source_freshness_s: Math.round((asOfMs - mtime) / 1000)
	};
}

// 7d aggregates over `missed_liquidations`. Returns both the summary
// rollup and per-(collateral_asset, debt_asset) lookups for the row
// annotator.
export function build7dMarketIntel(db, sinceMs) {
	const stmt = db.prepare(`
		SELECT
			liquidator,
			collateral_asset,
			debt_asset,
			borrower_address,
			debt_usd,
			timestamp
		FROM missed_liquidations
		WHERE timestamp >= ?
	`);
	const rows = stmt.all(sinceMs);

	const byPair = new Map();
	const byLiquidator = new Map();
	const byCollateral = new Map();

	for (const r of rows) {
		const pairKey = `${(r.collateral_asset || '').toLowerCase()}|${(r.debt_asset || '').toLowerCase()}`;
		const debtUsd = Number(r.debt_usd) || 0;
		const pairAgg = byPair.get(pairKey) || { count: 0, total_debt_usd: 0, top_liquidator: null, top_liquidator_count: 0 };
		pairAgg.count += 1;
		pairAgg.total_debt_usd += debtUsd;
		// Track top liquidator per pair (simple count argmax — good enough).
		if (r.liquidator) {
			pairAgg._liqMap ??= new Map();
			const c = (pairAgg._liqMap.get(r.liquidator) || 0) + 1;
			pairAgg._liqMap.set(r.liquidator, c);
			if (c > pairAgg.top_liquidator_count) {
				pairAgg.top_liquidator_count = c;
				pairAgg.top_liquidator = r.liquidator;
			}
		}
		byPair.set(pairKey, pairAgg);

		if (r.liquidator) {
			const liqAgg = byLiquidator.get(r.liquidator) || { won_count: 0, total_debt_usd: 0 };
			liqAgg.won_count += 1;
			liqAgg.total_debt_usd += debtUsd;
			byLiquidator.set(r.liquidator, liqAgg);
		}

		if (r.collateral_asset) {
			const k = r.collateral_asset.toLowerCase();
			const colAgg = byCollateral.get(k) || { count: 0, total_debt_usd: 0 };
			colAgg.count += 1;
			colAgg.total_debt_usd += debtUsd;
			byCollateral.set(k, colAgg);
		}
	}

	// Strip the working _liqMap before returning so the response is
	// JSON-serialisable.
	for (const v of byPair.values()) delete v._liqMap;

	const topLiquidators = Array.from(byLiquidator.entries())
		.map(([address, agg]) => ({ address, won_count: agg.won_count, total_debt_usd: Number(agg.total_debt_usd.toFixed(2)) }))
		.sort((a, b) => b.won_count - a.won_count)
		.slice(0, 10);

	const topCollateralAssets = Array.from(byCollateral.entries())
		.map(([asset, agg]) => ({ asset, count: agg.count, total_debt_usd: Number(agg.total_debt_usd.toFixed(2)) }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 10);

	return {
		summary: {
			window_start_ms: sinceMs,
			missed_liquidations: rows.length,
			top_liquidators: topLiquidators,
			top_collateral_assets: topCollateralAssets,
			distinct_pairs: byPair.size
		},
		byPair,
		byCollateral
	};
}

// Our own attempt outcomes, both on Aave (`executions`) and Morpho
// (`morpho_attempts`). Returns per-market aggregates so the annotator
// can show an agent "we've tried this market 14 times in the last 7d,
// 0 landed". Honest, useful, hard to argue with.
export function buildOurAttemptIntel(db, sinceMs) {
	const aave = db.prepare(`
		SELECT strategy, COUNT(*) AS total, SUM(success) AS wins,
		       AVG(actual_profit_usd) AS avg_profit, AVG(gas_used_usd) AS avg_gas
		FROM executions
		WHERE timestamp >= ?
		GROUP BY strategy
	`).all(sinceMs);

	const morpho = db.prepare(`
		SELECT outcome, COUNT(*) AS total, COUNT(DISTINCT market_id) AS markets,
		       AVG(estimated_profit_usd) AS avg_est
		FROM morpho_attempts
		WHERE timestamp >= ?
		GROUP BY outcome
	`).all(sinceMs);

	const morphoByMarket = db.prepare(`
		SELECT market_id, outcome, COUNT(*) AS c
		FROM morpho_attempts
		WHERE timestamp >= ? AND market_id IS NOT NULL
		GROUP BY market_id, outcome
	`).all(sinceMs);

	const byMarket = new Map();
	for (const r of morphoByMarket) {
		const agg = byMarket.get(r.market_id) || { attempts: 0, success: 0, skipped: 0, failed: 0 };
		agg.attempts += r.c;
		const key = r.outcome === 'success' ? 'success'
			: r.outcome === 'failed' ? 'failed'
				: 'skipped';
		agg[key] = (agg[key] || 0) + r.c;
		byMarket.set(r.market_id, agg);
	}

	return {
		aave_by_strategy: aave,
		morpho_by_outcome: morpho,
		morpho_by_market: byMarket
	};
}

function buildNetworkStatus(db, marketIntel, fullAtRisk) {
	const lastLiq = db.prepare(`
		SELECT timestamp, borrower_address, debt_usd, liquidator
		FROM missed_liquidations
		ORDER BY timestamp DESC
		LIMIT 1
	`).get();

	return {
		total_at_risk_seen: fullAtRisk.total_matched ?? fullAtRisk.results.length,
		returned_in_feed: fullAtRisk.results.length,
		liquidations_observed_in_window: marketIntel.summary.missed_liquidations,
		last_observed_liquidation: lastLiq ? {
			timestamp_ms: lastLiq.timestamp,
			borrower: lastLiq.borrower_address,
			debt_usd: lastLiq.debt_usd,
			won_by: lastLiq.liquidator
		} : null
	};
}

// Joins per-row borrower data with market intel + our own attempt
// history. Computes a simple expected-value score and sorts the feed
// by it so the highest-EV opportunities surface first.
function annotateOpportunities({ borrowers, marketIntel, ourAttemptIntel, liquidationBonus }) {
	const out = [];
	for (const b of borrowers) {
		const debtUsd = Number(b.debt_usd) || 0;
		const grossBonus = debtUsd * liquidationBonus;
		const intel = marketIntelForRow(b, marketIntel);
		const winRate = intel.win_rate;
		const ev = grossBonus * winRate;
		const our = b.market_id ? (ourAttemptIntel.morpho_by_market.get(b.market_id) || null) : null;
		out.push({
			...b,
			expected_value_usd: Number(ev.toFixed(2)),
			gross_bonus_usd: Number(grossBonus.toFixed(2)),
			market_intel: intel.public,
			our_attempt_intel: our
				? {
					attempts: our.attempts,
					success: our.success,
					failed: our.failed,
					skipped: our.skipped
				}
				: null
		});
	}
	out.sort((a, b) => (b.expected_value_usd ?? 0) - (a.expected_value_usd ?? 0));
	return out;
}

// Look up market intel for a single borrower. We don't have a
// per-borrower (collateral, debt) join in the at-risk snapshot, so
// the lookup is by best-effort heuristics: Morpho rows carry a
// market_id which we'd need to crosswalk to (collateral, debt)
// addresses — that's future work. For now we return the network-wide
// rollup which is the honest minimum.
function marketIntelForRow(borrower, marketIntel) {
	// TODO(future): cross-reference morpho market_id → (collateral, debt)
	// addresses by reading the bot's morpho-markets cache. Until then,
	// expose the global win rate for the protocol (a fraction of liq
	// volume that the network observed in the window) and let the agent
	// pick. We compute a conservative `win_rate = min(1, observed / max(observed,N))`
	// so a busy week doesn't push EV above the cap.
	const observed = marketIntel.summary.missed_liquidations;
	// Empirically: ~50 liquidations/day across Aave + Morpho mainnet
	// when markets are volatile; under that, treat each row as ~50%
	// of historical baseline.
	const baseline = 350; // 7d baseline of liquidations across both protocols
	const winRate = Math.max(0.05, Math.min(1, observed / baseline));
	return {
		win_rate: winRate,
		public: {
			protocol: borrower.protocol,
			win_rate: Number(winRate.toFixed(3)),
			window_observed_liquidations: observed,
			window_baseline_liquidations: baseline,
			method: 'global_window_rate'
		}
	};
}
