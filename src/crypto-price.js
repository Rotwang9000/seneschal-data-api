// crypto-price — re-exported from the open-source `viewkey-watch` package.
//
// USD<->coin conversion + the CoinGecko-backed price oracle. The implementation
// now lives in viewkey-watch (https://github.com/Rotwang9000/viewkey-watch) and
// the data-api consumes it as a pinned dependency (single source of truth).
export * from 'viewkey-watch/crypto-price';
