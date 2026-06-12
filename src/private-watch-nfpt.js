// private-watch-nfpt — re-exported from the open-source `viewkey-watch` package.
//
// The implementation now lives in viewkey-watch
// (https://github.com/Rotwang9000/viewkey-watch) and the data-api consumes it
// as a pinned dependency, so the published package and the production service
// run the exact same code (single source of truth). Seneschal-specific wiring
// stays in rest-server.js and the poller scripts.
export * from 'viewkey-watch/private-watch-nfpt';
