#!/usr/bin/env node
// systemd entrypoint for the MCP HTTP server.

import { startMcpHttpServer } from '../src/mcp-server.js';
import config from '../src/config.js';

startMcpHttpServer().then(server => {
	const addr = server.address();
	// eslint-disable-next-line no-console
	console.log(`seneschal-mcp listening on ${addr.address}:${addr.port} (service=${config.serviceName})`);
}).catch(err => {
	// eslint-disable-next-line no-console
	console.error('seneschal-mcp failed to start:', err);
	process.exit(1);
});
