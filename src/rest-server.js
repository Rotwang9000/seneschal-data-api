// Public Seneschal REST API.
//
// Surface (all GET unless noted):
//   /v1/health
//   /v1/liquidations/atrisk?protocol&max_hf&min_debt_usd&limit
//   /v1/liquidations/recent?since_ms&limit&protocol
//   /v1/borrowers/:address?
//   /v1/borrowers/:address/history?protocol&since_ms&until_ms&granularity&limit
//   /v1/builders/leaderboard?window&limit
//
// Errors are surfaced as { error: { code, message } } with the appropriate
// HTTP status. Validation errors from queries.js bubble up as 400.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import config from './config.js';
import {
	openLiveDb,
	fileMtimeMs
} from './db.js';
import {
	getHealth,
	listAtRiskBorrowers,
	recentLiquidations,
	getBorrower,
	getBorrowerHistory,
	getBuilderLeaderboard
} from './queries.js';

// `buildApp` is exported separately so tests can spin up a Fastify
// instance against a fixture DB without touching the live one.
export async function buildApp(options = {}) {
	const app = Fastify({
		logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
		trustProxy: options.trustProxy ?? true
	});

	const db = options.db ?? openLiveDb();
	const shadowPath = options.shadowPath ?? config.shadowBlocksPath;
	const morphoPath = options.morphoPath ?? config.morphoBorrowersPath;
	const sparkPath = options.sparkPath ?? config.sparkBorrowersPath;
	const ttlMs = options.leaderboardTtlMs ?? config.leaderboardCacheTtlMs;
	const apiVersion = options.apiVersion ?? config.apiVersion;

	await app.register(cors, {
		origin: true,
		methods: ['GET', 'OPTIONS'],
		maxAge: 86400
	});

	if (options.rateLimit !== false) {
		await app.register(rateLimit, {
			max: options.rateLimitMax ?? config.rateLimitPerMin,
			timeWindow: options.rateLimitWindow ?? config.rateLimitTimeWindowMs,
			cache: 10000,
			allowList: options.rateLimitAllowList ?? []
		});
	}

	// Global error handler: validation errors become 400, anything else 500.
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) {
			req.log.warn({ err: err.message, url: req.url }, 'bad request');
			return reply.code(400).send({
				error: { code: 'invalid_request', message: err.message }
			});
		}
		req.log.error({ err: err.stack ?? err.message, url: req.url }, 'unhandled');
		return reply.code(500).send({
			error: { code: 'internal_error', message: 'internal error' }
		});
	});

	app.get('/', async () => ({
		service: config.serviceName,
		version: apiVersion,
		docs: 'https://docs.seneschal.space',
		endpoints: [
			'GET /v1/health',
			'GET /v1/liquidations/atrisk',
			'GET /v1/liquidations/recent',
			'GET /v1/borrowers/:address',
			'GET /v1/borrowers/:address/history',
			'GET /v1/builders/leaderboard'
		]
	}));

	app.get('/v1/health', async () => {
		return getHealth(db, {
			version: apiVersion,
			morphoMtimeMs: fileMtimeMs(morphoPath),
			sparkMtimeMs: fileMtimeMs(sparkPath),
			shadowMtimeMs: fileMtimeMs(shadowPath)
		});
	});

	app.get('/v1/liquidations/atrisk', async (req) => {
		const q = req.query ?? {};
		return listAtRiskBorrowers(db, {
			protocol: q.protocol,
			max_hf: q.max_hf,
			min_debt_usd: q.min_debt_usd,
			limit: q.limit,
			_sparkPath: sparkPath
		});
	});

	app.get('/v1/liquidations/recent', async (req) => {
		const q = req.query ?? {};
		return recentLiquidations(db, {
			since_ms: q.since_ms,
			limit: q.limit,
			protocol: q.protocol
		});
	});

	app.get('/v1/borrowers/:address', async (req) => {
		return getBorrower(db, {
			address: req.params.address,
			_sparkPath: sparkPath
		});
	});

	app.get('/v1/borrowers/:address/history', async (req) => {
		const q = req.query ?? {};
		return getBorrowerHistory(db, {
			address: req.params.address,
			protocol: q.protocol,
			since_ms: q.since_ms,
			until_ms: q.until_ms,
			granularity: q.granularity,
			limit: q.limit
		});
	});

	app.get('/v1/builders/leaderboard', async (req) => {
		const q = req.query ?? {};
		return getBuilderLeaderboard({
			window: q.window,
			limit: q.limit,
			_shadowPath: shadowPath,
			_ttlMs: ttlMs
		});
	});

	app.setNotFoundHandler((req, reply) => {
		reply.code(404).send({
			error: { code: 'not_found', message: `route ${req.method} ${req.url} not found` }
		});
	});

	return app;
}

// Entrypoint helper for bin/rest.mjs.
export async function start() {
	const app = await buildApp();
	await app.listen({ port: config.restPort, host: config.restHost });
	return app;
}
