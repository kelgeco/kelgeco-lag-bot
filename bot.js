// ============================================================
//  KELGECO LAG BOT v3.0 — BESTIA MODE 😈
//  Multi-mercado: BTC + ETH + SOL
//  Doble confirmación + Parlay Tracker + Auto-entry ready
// ============================================================

const WebSocket = require('ws');
const https = require('https');

const CONFIG = {
  DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1511644951065268316/y70Ccn6PupluNTRAIh297TWKFIA8ABFQnGODq94HaEj4z1G029sB7ZWaYp5XCFi0g-Lr',

  // Thresholds por mercado
  MARKETS: {
    BTC: { symbol: 'btcusdt', threshold: 0.20, name: 'BTC', emoji: '₿' },
    ETH: { symbol: 'ethusdt', threshold: 0.25, name: 'ETH', emoji: 'Ξ' },
    SOL: { symbol: 'solusdt', threshold: 0.35, name: 'SOL', emoji: '◎' },
  },

  SPIKE_WINDOW_MS: 3000,
  COOLDOWN_MS: 15000,         // cooldown por mercado
  MIN_CONFIDENCE: 60,          // confianza mínima para señal
  AUTO_ENTRY_CONFIDENCE: 85,   // confianza para auto-entry (cuando tengas fondos)
  DASHBOARD_PORT: 3001,

  // Parlay config
  PARLAY_START: 20,            // capital inicial simulado en USDC
  AUTO_ENTRY_ENABLED: false,   // ← cambia a true cuando tengas fondos
};

// ─── STATE ────────────────────────────────────────────────────
const state = {
  prices: { BTC: null, ETH: null, SOL: null },
  buffers: { BTC: [], ETH: [], SOL: [] },
  lastSignal: { BTC: 0, ETH: 0, SOL: 0 },
  totalSignals: 0,
  sessionStart: Date.now(),
  dashboardClients: new Set(),

  // Parlay tracker
  parlay: {
    active: false,
    balance: CONFIG.PARLAY_START,
    startBalance: CONFIG.PARLAY_START,
    trades: [],
    wins: 0,
    losses: 0,
    lastDirection: null,
  },

  // Stats por mercado
  stats: {
    BTC: { signals: 0, up: 0, down: 0 },
    ETH: { signals: 0, up: 0, down: 0 },
    SOL: { signals: 0, up: 0, down: 0 },
  },
};

// ─── COLORS ───────────────────────────────────────────────────
const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  orange: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

function log(type, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' });
  const prefix = {
    INFO:    C.dim(`[${time}] i`),
    SIGNAL:  C.green(`[${time}] SIGNAL`),
    PARLAY:  C.orange(`[${time}] PARLAY`),
    ALERT:   C.yellow(`[${time}] DISCORD`),
    DASH:    C.cyan(`[${time}] DASHBOARD`),
    AUTO:    C.bold(C.green(`[${time}] AUTO-ENTRY`)),
    ERROR:   C.red(`[${time}] ERROR`),
    BOOT:    C.bold(`[${time}] BOOT`),
    STATS:   C.cyan(`[${time}] STATS`),
  }[type] || `[${time}]`;
  console.log(`${prefix}  ${msg}`);
}

// ─── DASHBOARD BROADCAST ─────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  state.dashboardClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function startDashboardServer() {
  const wss = new WebSocket.Server({ port: CONFIG.DASHBOARD_PORT });
  wss.on('connection', (ws) => {
    state.dashboardClients.add(ws);
    log('DASH', `Cliente conectado (total: ${state.dashboardClients.size})`);
    ws.send(JSON.stringify({
      type: 'INIT',
      totalSignals: state.totalSignals,
      parlay: state.parlay,
      stats: state.stats,
      prices: state.prices,
    }));
    ws.on('close', () => {
      state.dashboardClients.delete(ws);
    });
  });
  log('BOOT', `Dashboard WS en ws://localhost:${CONFIG.DASHBOARD_PORT}`);
}

// ─── PARLAY TRACKER ──────────────────────────────────────────
function updateParlay(direction, confidence, market) {
  const p = state.parlay;

  // Simula odds de Polymarket (aprox 55-65¢ para el lado favorito)
  const odds = confidence > 80 ? 1.6 : confidence > 70 ? 1.45 : 1.3;
  const betAmount = p.balance * 0.5; // apuesta 50% del balance
  const isWin = Math.random() < (confidence / 100); // simulado

  if (isWin) {
    const profit = betAmount * (odds - 1);
    p.balance += profit;
    p.wins++;
    p.trades.push({ market, direction, bet: betAmount, result: +profit, balance: p.balance, win: true });
    log('PARLAY', C.green(`WIN +$${profit.toFixed(2)} → Balance: $${p.balance.toFixed(2)}`));
  } else {
    p.balance -= betAmount;
    p.losses++;
    p.trades.push({ market, direction, bet: betAmount, result: -betAmount, balance: p.balance, win: false });
    log('PARLAY', C.red(`LOSS -$${betAmount.toFixed(2)} → Balance: $${p.balance.toFixed(2)}`));
  }

  p.lastDirection = direction;
  const totalReturn = ((p.balance - p.startBalance) / p.startBalance * 100).toFixed(1);
  log('PARLAY', `ROI simulado: ${totalReturn}% | W:${p.wins} L:${p.losses}`);

  broadcast({ type: 'PARLAY_UPDATE', parlay: p });
}

// ─── CONFIDENCE ───────────────────────────────────────────────
function calcConfidence(deltaPct, market) {
  const base = Math.min(95, 50 + Math.abs(deltaPct) * 80);
  // SOL es más volátil = menos confianza base
  const multiplier = market === 'SOL' ? 0.9 : market === 'ETH' ? 0.95 : 1.0;
  return Math.round(base * multiplier);
}

// ─── DOUBLE CONFIRMATION ─────────────────────────────────────
const pendingSignals = {};

function confirmSignal(market, direction, price, delta, confidence) {
  const key = `${market}_${direction}`;
  const now = Date.now();

  if (!pendingSignals[key]) {
    // Primera detección — espera 500ms para segunda confirmación
    pendingSignals[key] = { time: now, price, delta, confidence };
    setTimeout(() => {
      if (pendingSignals[key]) {
        delete pendingSignals[key];
      }
    }, 1500);
    return false; // no confirmado aún
  }

  // Segunda confirmación dentro de 1.5s = señal confirmada
  const first = pendingSignals[key];
  delete pendingSignals[key];

  // Promediar confianza de ambas detecciones
  const avgConfidence = Math.round((first.confidence + confidence) / 2);
  return avgConfidence;
}

// ─── SPIKE DETECTOR ──────────────────────────────────────────
function detectSpike(market, currentPrice, currentTime) {
  const buffer = state.buffers[market];
  buffer.push({ price: currentPrice, time: currentTime });
  state.buffers[market] = buffer.filter(p => currentTime - p.time <= CONFIG.SPIKE_WINDOW_MS);

  if (buffer.length < 3) return null;

  const oldest = buffer[0].price;
  const delta = ((currentPrice - oldest) / oldest) * 100;
  const threshold = CONFIG.MARKETS[market].threshold;

  if (Math.abs(delta) >= threshold) {
    return {
      direction: delta > 0 ? 'UP' : 'DOWN',
      delta,
      confidence: calcConfidence(delta, market),
    };
  }
  return null;
}

// ─── DISCORD ──────────────────────────────────────────────────
function sendDiscord(market, direction, price, delta, confidence, isAutoEntry = false) {
  const cfg = CONFIG.MARKETS[market];
  const isUp = direction === 'UP';
  const color = isUp ? 0x00ff87 : 0xff3c5a;
  const emoji = isUp ? '🟢' : '🔴';
  const sign = delta > 0 ? '+' : '';
  const uptime = Math.floor((Date.now() - state.sessionStart) / 60000);
  const p = state.parlay;

  const fields = [
    { name: `${cfg.emoji} ${market} Price`, value: `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
    { name: '📊 Movimiento', value: `${sign}${delta.toFixed(3)}% en <3s`, inline: true },
    { name: '🎯 Confianza', value: `**${confidence}%**`, inline: true },
    { name: '🔗 Polymarket', value: '[Abrir mercado](https://polymarket.com/markets?category=crypto)', inline: true },
    { name: '💰 Parlay Balance', value: `$${p.balance.toFixed(2)} (desde $${p.startBalance})`, inline: true },
    { name: '📈 Sesión', value: `${state.totalSignals} señales · ${uptime}min · W:${p.wins}/L:${p.losses}`, inline: true },
  ];

  if (confidence >= CONFIG.AUTO_ENTRY_CONFIDENCE) {
    fields.push({ name: '⚡ AUTO-ENTRY', value: CONFIG.AUTO_ENTRY_ENABLED ? '✅ EJECUTADO' : '⚠️ ACTIVA cuando tengas fondos', inline: false });
  }

  const payload = JSON.stringify({
    username: 'KELGECO LAG BOT',
    embeds: [{
      title: `${emoji} SEÑAL #${state.totalSignals} · ${market} ${direction}${confidence >= CONFIG.AUTO_ENTRY_CONFIDENCE ? ' ⚡ HIGH CONF' : ''}`,
      color: confidence >= CONFIG.AUTO_ENTRY_CONFIDENCE ? 0xffd60a : color,
      fields,
      footer: { text: `KELGECO v3.0 · Limon -> Finland · ${market} Lag Exploit` },
      timestamp: new Date().toISOString(),
    }]
  });

  const url = new URL(CONFIG.DISCORD_WEBHOOK);
  const req = https.request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    if (res.statusCode === 204) log('ALERT', `Discord OK · ${market} ${direction} ${confidence}%`);
  });
  req.on('error', () => {});
  req.write(payload); req.end();
}

// ─── AUTO ENTRY (ready cuando tengas fondos) ─────────────────
function autoEntry(market, direction, price, confidence) {
  if (!CONFIG.AUTO_ENTRY_ENABLED) {
    log('AUTO', C.yellow(`[SIMULADO] ${market} ${direction} @ $${price} · confianza ${confidence}% — activa AUTO_ENTRY_ENABLED cuando tengas fondos`));
    return;
  }
  // TODO: Polymarket API entry cuando tengas fondos
  log('AUTO', C.green(`ENTRANDO en Polymarket · ${market} ${direction} @ $${price}`));
}

// ─── PROCESS SIGNAL ──────────────────────────────────────────
function processSignal(market, spike, price) {
  const now = Date.now();
  if (now - state.lastSignal[market] < CONFIG.COOLDOWN_MS) return;
  if (spike.confidence < CONFIG.MIN_CONFIDENCE) return;

  // Doble confirmación
  const confirmedConf = confirmSignal(market, spike.direction, price, spike.delta, spike.confidence);
  if (confirmedConf === false) {
    log('INFO', C.dim(`${market} primera detección · esperando confirmación...`));
    return;
  }

  state.lastSignal[market] = now;
  state.totalSignals++;
  state.stats[market].signals++;
  spike.direction === 'UP' ? state.stats[market].up++ : state.stats[market].down++;

  console.log('');
  log('SIGNAL', C.bold(`${market} ${spike.direction} | Δ ${spike.delta.toFixed(3)}% | Conf: ${confirmedConf}% | DOBLE CONFIRMADO ✓`));

  // Broadcast al dashboard
  broadcast({
    type: 'SIGNAL',
    market,
    direction: spike.direction,
    price,
    delta: spike.delta,
    confidence: confirmedConf,
    totalSignals: state.totalSignals,
    stats: state.stats,
    time: new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' }),
  });

  // Parlay tracker
  updateParlay(spike.direction, confirmedConf, market);

  // Discord
  sendDiscord(market, spike.direction, price, spike.delta, confirmedConf);

  // Auto entry si confianza alta
  if (confirmedConf >= CONFIG.AUTO_ENTRY_CONFIDENCE) {
    autoEntry(market, spike.direction, price, confirmedConf);
  }
}

// ─── BINANCE MULTI-STREAM ─────────────────────────────────────
function connectBinance() {
  const symbols = Object.values(CONFIG.MARKETS).map(m => `${m.symbol}@trade`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${symbols}`);

  ws.on('open', () => {
    log('BOOT', C.green(`Multi-stream conectado: BTC + ETH + SOL`));

    // Discord inicio
    const payload = JSON.stringify({
      username: 'KELGECO LAG BOT',
      embeds: [{
        title: '😈 BOT v3.0 BESTIA INICIADO',
        color: 0xffd60a,
        description: `Monitoreando **BTC + ETH + SOL** simultáneo\nDoble confirmación activada\nParlay tracker: $${CONFIG.PARLAY_START} inicial\nAuto-entry: ${CONFIG.AUTO_ENTRY_ENABLED ? '✅ ACTIVO' : '⚠️ Listo cuando tengas fondos'}`,
        footer: { text: 'KELGECO v3.0 · Limon -> Finland' },
        timestamp: new Date().toISOString(),
      }]
    });
    const url = new URL(CONFIG.DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.on('error', () => {});
    req.write(payload); req.end();
  });

  ws.on('message', (raw) => {
    try {
      const { data } = JSON.parse(raw);
      if (!data) return;

      const price = parseFloat(data.p);
      const time = data.T;
      const symbol = data.s?.toUpperCase();

      // Map symbol to market
      const market = symbol === 'BTCUSDT' ? 'BTC' : symbol === 'ETHUSDT' ? 'ETH' : symbol === 'SOLUSDT' ? 'SOL' : null;
      if (!market) return;

      state.prices[market] = price;

      // Broadcast precio
      broadcast({ type: 'PRICE', market, price, time });

      // Detecta spike
      const spike = detectSpike(market, price, time);
      if (spike) processSignal(market, spike, price);

      // Status line
      const btc = state.prices.BTC ? `BTC $${state.prices.BTC.toLocaleString('en-US',{maximumFractionDigits:0})}` : 'BTC ...';
      const eth = state.prices.ETH ? `ETH $${state.prices.ETH.toLocaleString('en-US',{maximumFractionDigits:0})}` : 'ETH ...';
      const sol = state.prices.SOL ? `SOL $${state.prices.SOL.toLocaleString('en-US',{maximumFractionDigits:1})}` : 'SOL ...';
      process.stdout.write(`\r${C.dim(btc)}  ${C.dim(eth)}  ${C.dim(sol)}  signals:${state.totalSignals} parlay:$${state.parlay.balance.toFixed(0)}   `);

    } catch (err) {
      log('ERROR', err.message);
    }
  });

  ws.on('close', () => {
    log('ERROR', 'Stream cerrado. Reconectando en 5s...');
    setTimeout(connectBinance, 5000);
  });
  ws.on('error', (err) => log('ERROR', err.message));
}

// ─── STATS REPORT cada 30 min ────────────────────────────────
setInterval(() => {
  const uptime = Math.floor((Date.now() - state.sessionStart) / 60000);
  const p = state.parlay;
  const roi = ((p.balance - p.startBalance) / p.startBalance * 100).toFixed(1);
  console.log('');
  log('STATS', C.bold('─── REPORTE 30min ───────────────────'));
  log('STATS', `Uptime: ${uptime}min | Señales totales: ${state.totalSignals}`);
  log('STATS', `BTC: ${state.stats.BTC.signals} señales (↑${state.stats.BTC.up} ↓${state.stats.BTC.down})`);
  log('STATS', `ETH: ${state.stats.ETH.signals} señales (↑${state.stats.ETH.up} ↓${state.stats.ETH.down})`);
  log('STATS', `SOL: ${state.stats.SOL.signals} señales (↑${state.stats.SOL.up} ↓${state.stats.SOL.down})`);
  log('STATS', `Parlay: $${p.balance.toFixed(2)} | ROI: ${roi}% | W:${p.wins} L:${p.losses}`);
  log('STATS', C.bold('─────────────────────────────────────'));

  // Manda reporte a Discord
  const payload = JSON.stringify({
    username: 'KELGECO LAG BOT',
    embeds: [{
      title: '📊 REPORTE 30min',
      color: 0x4488ff,
      fields: [
        { name: 'Señales totales', value: state.totalSignals.toString(), inline: true },
        { name: 'Uptime', value: `${uptime} min`, inline: true },
        { name: 'BTC signals', value: `${state.stats.BTC.signals} (↑${state.stats.BTC.up} ↓${state.stats.BTC.down})`, inline: true },
        { name: 'ETH signals', value: `${state.stats.ETH.signals} (↑${state.stats.ETH.up} ↓${state.stats.ETH.down})`, inline: true },
        { name: 'SOL signals', value: `${state.stats.SOL.signals} (↑${state.stats.SOL.up} ↓${state.stats.SOL.down})`, inline: true },
        { name: 'Parlay simulado', value: `$${p.balance.toFixed(2)} | ROI: ${roi}% | W:${p.wins}/L:${p.losses}`, inline: false },
      ],
      footer: { text: 'KELGECO v3.0 · Limon -> Finland' },
      timestamp: new Date().toISOString(),
    }]
  });
  const url = new URL(CONFIG.DISCORD_WEBHOOK);
  const req = https.request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  });
  req.on('error', () => {});
  req.write(payload); req.end();

}, 30 * 60 * 1000);

// ─── BOOT ─────────────────────────────────────────────────────
console.log(C.bold(C.green(`
╔══════════════════════════════════════════╗
║   KELGECO LAG BOT  v3.0  😈 BESTIA       ║
║   BTC + ETH + SOL  Multi-stream          ║
║   Doble confirm + Parlay + Auto-entry    ║
║   Limon -> Finland  🇫🇮                   ║
╚══════════════════════════════════════════╝
`)));

startDashboardServer();
connectBinance();