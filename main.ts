// Bounce Rebound — BTC Race 24h (btc-race-24h-20261117-0603)
//
// Dip-buy with bounce confirmation + TP/SL measured from the entry fill price.
// Long only, full size, at most one position, deterministic (no clock, no
// randomness, no environment reads). All decisions come only from the bars.
//
// Entry (flat only): >= 50 closes seen, latest close >= 0.7% below the
// 50-bar SMA of closes, and latest close higher than the previous close.
// Exit (position open): sell everything when the latest close is >= +1.5%
// above, or >= -0.6% below, the entry fill price reported by the harness.
// A stop-loss exit blocks re-entry for the next 30 bars (downtrend guard).
import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_LEN = 50;
const DIP_PCT = 0.007; // 0.7% below the 50-bar SMA
const TP_PCT = 0.015; // +1.5% above the entry fill price
const SL_PCT = 0.006; // -0.6% below the entry fill price
const MAX_SLIPPAGE_BPS = 100;

// History of 1-minute closes, in dollars. The entry fill price, in dollars,
// once a buy has filled (null while flat).
const closes: number[] = [];
let entryFill: number | null = null;
// Re-entry is blocked while closes.length <= slCooldownUntil. Set when a
// stop-loss fires, so a downtrend cannot whipsaw the bot into repeated
// small losses by re-buying every dead-cat bounce right after an SL exit.
let slCooldownUntil = 0;
const SL_COOLDOWN_BARS = 30;

function priceScale(state: BarsState): number {
  return state.symbols.get(SYMBOL)?.price_scale ?? 5;
}

function closeDollars(state: BarsState, batch: Batch): number | null {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return null;
  return Number(BigInt(bar.c)) / 10 ** priceScale(state);
}

function sma(values: number[], len: number): number | null {
  if (values.length < len) return null;
  let sum = 0;
  for (let i = values.length - len; i < values.length; i++) sum += values[i];
  return sum / len;
}

await runBars({
  onBatch(state, batch) {
    // 1. Fold in this batch's fills: a filled buy sets the entry fill price,
    //    a filled sell clears it. The TP/SL are measured from this price.
    const scale = priceScale(state);
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (f.side === 'buy') entryFill = Number(BigInt(f.price)) / 10 ** scale;
      if (f.side === 'sell') entryFill = null;
    }

    // 2. Record this bar's close. Skip the bar (no trade) if it is missing
    //    or malformed, rather than crashing.
    const close = closeDollars(state, batch);
    if (close === null || !Number.isFinite(close) || close <= 0) return [];
    closes.push(close);

    // 3. Never trade on warm-up batches; their orders would be rejected.
    //    Closes are still recorded above, so the SMA is built from them.
    if (state.warmingUp) return [];

    const pos = state.positions.get(SYMBOL);
    const heldQty = pos === undefined ? 0n : pos.qty;

    // 4. Exit: TP / SL measured from the entry fill price.
    if (heldQty > 0n) {
      let ref = entryFill;
      if (ref === null && pos !== undefined) {
        // Fallback (should not normally happen): average cost per unit from
        // the position's recorded cost. cost is micro-USDC, qty is at
        // qty_scale 8, so dollars per unit = cost * 100 / qty.
        const qtyNum = Number(pos.qty);
        const costNum = Number(BigInt(pos.cost_quote_units));
        if (qtyNum > 0 && costNum > 0) ref = (costNum * 100) / qtyNum;
      }
      if (ref !== null && ref > 0) {
        if (close >= ref * (1 + TP_PCT)) {
          return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        if (close <= ref * (1 - SL_PCT)) {
          // Stop-loss: block re-entry for the next 30 bars so a downtrend
          // cannot whipsaw the bot into repeated small losses.
          slCooldownUntil = closes.length + SL_COOLDOWN_BARS;
          return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // 5. Entry: flat, >= 50 closes, dip >= 0.7% below SMA50, and bouncing.
    if (entryFill !== null) entryFill = null; // flat: no entry price in force
    if (closes.length < SMA_LEN) return [];
    const sma50 = sma(closes, SMA_LEN);
    if (sma50 === null) return [];
    const prevClose = closes[closes.length - 2];
    if (prevClose === undefined) return [];
    const dipped = close <= sma50 * (1 - DIP_PCT);
    const bouncing = close > prevClose;
    const cooledDown = closes.length > slCooldownUntil;
    if (!dipped || !bouncing || !cooledDown) return [];
    if (state.cash <= 0n) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
