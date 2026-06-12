// private-watch-poller — Seneschal-branded shim over the canonical poller in
// the open-source `viewkey-watch` package (single source of truth).
//
// Since viewkey-watch 0.1.2 the poller threads `headerPrefix`/`userAgent`
// through to every outbound webhook, so the old 470-line fork (whose ONLY
// divergence was the hardcoded x-seneschal headers) is gone. This shim binds
// the Seneschal branding as the default; callers can still override per-call.
// Outbound webhook headers stay byte-identical to what receivers already
// verify: x-seneschal-signature / -watch-id / -event.

import {
	runPollerTick as libRunPollerTick,
	deliverWebhook as libDeliverWebhook
} from 'viewkey-watch/private-watch-poller';
import {
	SENESCHAL_WEBHOOK_HEADER_PREFIX,
	SENESCHAL_WEBHOOK_USER_AGENT
} from './private-watch.js';

export { POLLER_CONSTANTS } from 'viewkey-watch/private-watch-poller';

export async function runPollerTick(deps = {}) {
	return libRunPollerTick({
		headerPrefix: SENESCHAL_WEBHOOK_HEADER_PREFIX,
		userAgent: SENESCHAL_WEBHOOK_USER_AGENT,
		...deps
	});
}

export async function deliverWebhook(opts = {}) {
	return libDeliverWebhook({
		headerPrefix: SENESCHAL_WEBHOOK_HEADER_PREFIX,
		userAgent: SENESCHAL_WEBHOOK_USER_AGENT,
		...opts
	});
}
