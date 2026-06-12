// crypto-recv-poller — re-exported from the open-source `viewkey-watch` package.
//
// Inbound XMR/ZEC detection loop: scans our own receiving wallet via the
// wallet-scanner, matches payments to quotes, credits the watch. The
// implementation now lives in viewkey-watch
// (https://github.com/Rotwang9000/viewkey-watch) and the data-api consumes it
// as a pinned dependency (single source of truth).
export * from 'viewkey-watch/crypto-recv-poller';
