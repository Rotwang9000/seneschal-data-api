// private-watch-crypto — re-exported from the open-source `viewkey-watch` package.
//
// View-key encryption (AES-256-GCM) + webhook HMAC signing. The implementation
// now lives in viewkey-watch (https://github.com/Rotwang9000/viewkey-watch) and
// the data-api consumes it as a pinned dependency, so the published package and
// the production service run the exact same code (single source of truth).
export * from 'viewkey-watch/private-watch-crypto';
