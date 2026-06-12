// private-watch — re-exported from the open-source `viewkey-watch` package,
// with Seneschal-branded defaults bound onto buildPrivateInfo.
//
// Validation, SSRF guard, credit-meter math and payload builders now live in
// viewkey-watch (https://github.com/Rotwang9000/viewkey-watch); the data-api
// consumes it as a pinned dependency (single source of truth). The package
// defaults buildPrivateInfo to vendor-neutral strings, so we bind Seneschal's
// service name + signature header here to keep /v1/private/info wording stable.
//
// The SENESCHAL_* constants are the single home for the brand strings the
// embedded payments-gateway plugin (rest-server.js, mcp-server.js) and the
// branded poller shim (private-watch-poller.js) need — touch one constant,
// every surface follows.
export * from 'viewkey-watch/private-watch';
import * as _pw from 'viewkey-watch/private-watch';

export const SENESCHAL_SERVICE_NAME = 'Seneschal Private Watch';
export const SENESCHAL_SIGNATURE_HEADER = 'X-Seneschal-Signature';
export const SENESCHAL_WEBHOOK_HEADER_PREFIX = 'x-seneschal';
export const SENESCHAL_WEBHOOK_USER_AGENT = 'Seneschal-PrivateWatch/1.0 (+https://seneschal.space)';
export const SENESCHAL_MEMO_PREFIX = 'SNS';
export const SENESCHAL_DERIVE_DOCS_URL = 'https://docs.seneschal.space/derive-locally';

export function buildPrivateInfo(opts = {}) {
	return _pw.buildPrivateInfo({
		serviceName: SENESCHAL_SERVICE_NAME,
		signatureHeader: SENESCHAL_SIGNATURE_HEADER,
		...opts
	});
}
