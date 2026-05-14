#!/usr/bin/env node
// systemd entrypoint for the REST API.

import { start } from '../src/rest-server.js';

start().then(app => {
	app.log.info({
		host: app.server.address().address,
		port: app.server.address().port
	}, 'seneschal-rest listening');
}).catch(err => {
	// eslint-disable-next-line no-console
	console.error('seneschal-rest failed to start:', err);
	process.exit(1);
});
