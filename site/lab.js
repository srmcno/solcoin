const form = document.querySelector('#economics-form');
const result = document.querySelector('#economics-result');
function calculate() {
  if (!form.checkValidity()) { document.querySelector('#scenario-bars').replaceChildren(); result.textContent = 'Enter valid non-negative costs and a creator fee greater than zero.'; return; }
  const cost = Number(form.elements.namedItem('cost').value);
  const overhead = Number(form.elements.namedItem('overhead').value);
  const rate = Number(form.elements.namedItem('rate').value) / 100;
  const volume = Number(form.elements.namedItem('volume').value);
  const total = cost + overhead;
  const net = volume * rate - total;
  result.textContent = `Break-even: ${(total / rate).toFixed(2)} SOL of independent trading volume. Scenario net: ${net >= 0 ? '+' : ''}${net.toFixed(4)} SOL per launch.`;
  document.querySelector('#scenario-bars').replaceChildren(...[0, 0.5, 1, 2].map(multiplier => {
    const row = document.createElement('div');
    row.className = 'scenario-row';
    const label = document.createElement('span');
    label.textContent = `${multiplier}× break-even volume`;
    const value = document.createElement('strong');
    const profit = total * (multiplier - 1);
    value.textContent = `${profit >= 0 ? '+' : ''}${profit.toFixed(4)} SOL`;
    value.className = profit < 0 ? 'loss' : 'gain';
    row.append(label, value); return row;
  }));
}
form.addEventListener('input', calculate);
form.addEventListener('submit', event => { event.preventDefault(); calculate(); });
calculate();
const quote = document.querySelector('#sol-quote');
const status = document.querySelector('#quote-status');
const button = document.querySelector('#refresh-quote');
let lastSuccess = 0;
let pending = false;
async function refreshQuote() {
  if (pending || document.hidden) return;
  pending = true; button.disabled = true; status.textContent = 'Checking Coinbase public spot quote…';
  try {
    const response = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!response.ok) throw new Error('Quote unavailable');
    const payload = await response.json();
    const price = Number(payload?.data?.amount);
    if (!Number.isFinite(price) || price <= 0 || payload?.data?.currency !== 'USD') throw new Error('Invalid quote');
    lastSuccess = Date.now();
    quote.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price);
    status.textContent = `Coinbase spot reference · fetched ${new Date(lastSuccess).toLocaleTimeString()} · 60-second polling, not an execution quote`;
  } catch {
    status.textContent = lastSuccess ? `STALE · last successful fetch ${new Date(lastSuccess).toLocaleTimeString()}. Refresh failed.` : 'Quote unavailable. No sample price is substituted.';
  } finally { pending = false; button.disabled = false; }
}
button.addEventListener('click', refreshQuote);
setInterval(() => void refreshQuote(), 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshQuote(); });
void refreshQuote();
