'use strict';
/**
 * Radio Udine RP — server push-to-talk in stile walkie-talkie.
 *
 * - Serve l'app web (cartella /public)
 * - Canali con un solo utente in trasmissione alla volta (come una vera radio)
 * - Audio in tempo reale via WebSocket (PCM 16 bit, 16 kHz, mono)
 * - Cronologia degli ultimi messaggi vocali e di testo per ogni canale
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');
const VERSION = require('./package.json').version;

const config = loadConfig();

const PORT = Number(process.env.PORT) || Number(config.porta) || 3000;
const SERVER_PASSWORD = String(process.env.SERVER_PASSWORD ?? config.passwordServer ?? '');
const SAMPLE_RATE = 16000;
const MAX_TALK_MS = Math.max(5, Number(config.durataMassimaTrasmissione) || 60) * 1000;
const MAX_VOICE_HISTORY = Math.max(0, Number(config.messaggiVocaliSalvati ?? 20));
const MAX_TEXT_HISTORY = 60;
const MAX_HISTORY_BYTES = 12 * 1024 * 1024; // per canale
const MIN_VOICE_SECONDS = 0.3;
const MAX_AUDIO_FRAME = 32 * 1024;
const MAX_SEND_BUFFER = 1024 * 1024;
const HEARTBEAT_MS = 25000;

// ------------------------------------------------------------------ config

function fail(msg) {
  console.error('\n[ERRORE] ' + msg + '\n');
  process.exit(1);
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    fail(`Non trovo il file di configurazione: ${CONFIG_FILE}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    fail(`config.json non è valido (${e.message}).\nControlla virgole e virgolette, oppure ripristina il file originale.`);
  }
  if (!Array.isArray(cfg.canali) || cfg.canali.length === 0) fail('config.json: la lista "canali" è vuota.');
  if (!Array.isArray(cfg.reparti) || cfg.reparti.length === 0) cfg.reparti = ['Civile'];
  return cfg;
}

const REPARTI = config.reparti.map((r) =>
  typeof r === 'string'
    ? { nome: r, icona: '👤', colore: '#9ca3af' }
    : { nome: String(r.nome), icona: r.icona || '👤', colore: r.colore || '#9ca3af' }
);
const REPARTI_NOMI = new Set(REPARTI.map((r) => r.nome));

const channels = new Map();
for (const c of config.canali) {
  const id = String(c.id || c.nome || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!id || channels.has(id)) continue;
  channels.set(id, {
    id,
    nome: String(c.nome || id),
    icona: c.icona || '📻',
    descrizione: String(c.descrizione || ''),
    password: String(c.password || ''),
    clients: new Set(),
    talker: null,
    current: null,
    talkTimer: null,
    voice: [],
    voiceBytes: 0,
    texts: [],
  });
}

// ------------------------------------------------------------------ utilità

const clients = new Map(); // id -> client (solo utenti che hanno fatto login)
const byKey = new Map(); // chiave sessione -> client
let nextId = 1;

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const rid = () => crypto.randomBytes(8).toString('hex');
const time = () => new Date().toLocaleTimeString('it-IT');
const log = (...a) => console.log(`[${time()}]`, ...a);

function send(client, obj) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(obj));
}

function broadcast(ch, obj, except) {
  const data = JSON.stringify(obj);
  for (const c of ch.clients) {
    if (c !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

const publicUser = (c) => ({ id: c.id, nome: c.nome, sigla: c.sigla, reparto: c.reparto });

const channelInfo = (ch) => ({
  id: ch.id,
  nome: ch.nome,
  icona: ch.icona,
  descrizione: ch.descrizione,
  protetto: !!ch.password,
  utenti: ch.clients.size,
  attivo: !!ch.talker,
});

const channelList = () => [...channels.values()].map(channelInfo);

let channelsTimer = null;
function scheduleChannelsUpdate() {
  if (channelsTimer) return;
  channelsTimer = setTimeout(() => {
    channelsTimer = null;
    const data = JSON.stringify({ t: 'channels', channels: channelList() });
    for (const c of clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }, 150);
}

function channelFeed(ch) {
  return ch.voice
    .map((v) => v.meta)
    .concat(ch.texts)
    .sort((a, b) => a.ts - b.ts)
    .slice(-100);
}

function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ------------------------------------------------------------------ canali e trasmissione

function leaveChannel(client) {
  const ch = client.channel && channels.get(client.channel);
  client.channel = null;
  if (!ch) return;
  if (ch.talker === client) endTalk(ch, 'left');
  ch.clients.delete(client);
  broadcast(ch, { t: 'user_leave', user: publicUser(client) });
  scheduleChannelsUpdate();
}

function endTalk(ch, reason) {
  clearTimeout(ch.talkTimer);
  ch.talkTimer = null;
  const cur = ch.current;
  ch.talker = null;
  ch.current = null;
  if (!cur) return;

  const seconds = cur.bytes / 2 / SAMPLE_RATE;
  let meta = null;
  if (seconds >= MIN_VOICE_SECONDS) {
    meta = { tipo: 'voce', id: cur.id, from: cur.from, ts: cur.ts, durata: Math.round(seconds * 10) / 10 };
    if (MAX_VOICE_HISTORY > 0) {
      const pcm = Buffer.concat(cur.chunks);
      ch.voice.push({ meta, pcm });
      ch.voiceBytes += pcm.length;
      while (ch.voice.length > MAX_VOICE_HISTORY || ch.voiceBytes > MAX_HISTORY_BYTES) {
        const old = ch.voice.shift();
        ch.voiceBytes -= old.pcm.length;
      }
    }
    log(`#${ch.id}  ${cur.from.nome} ha parlato ${meta.durata}s`);
  }
  broadcast(ch, { t: 'talk_end', user: cur.from, id: cur.id, msg: meta, reason });
  scheduleChannelsUpdate();
}

function onAudio(client, data) {
  const ch = client.channel && channels.get(client.channel);
  if (!ch || ch.talker !== client || !ch.current) return;
  if (data.length === 0 || data.length > MAX_AUDIO_FRAME || data.length % 2 !== 0) return;
  if (MAX_VOICE_HISTORY > 0) ch.current.chunks.push(data);
  ch.current.bytes += data.length;
  for (const c of ch.clients) {
    if (c === client || c.ws.readyState !== WebSocket.OPEN) continue;
    if (c.ws.bufferedAmount > MAX_SEND_BUFFER) continue; // utente con rete lenta: salta il pacchetto
    c.ws.send(data, { binary: true });
  }
}

function handle(client, msg) {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') {
    if (SERVER_PASSWORD && String(msg.password || '') !== SERVER_PASSWORD) {
      send(client, { t: 'error', code: 'server_password', msg: 'Codice di accesso errato' });
      return;
    }
    client.nome = clean(msg.nome, 24) || 'Anonimo';
    client.sigla = clean(msg.sigla, 16);
    client.reparto = REPARTI_NOMI.has(msg.reparto) ? msg.reparto : REPARTI[0].nome;
    if (!client.authed) {
      client.authed = true;
      clients.set(client.id, client);
      byKey.set(client.key, client);
      log(`+ ${client.nome} (${client.reparto}) connesso — utenti online: ${clients.size}`);
    }
    send(client, {
      t: 'welcome',
      id: client.id,
      key: client.key,
      server: config.nomeServer,
      channels: channelList(),
      maxTalk: MAX_TALK_MS / 1000,
    });
    return;
  }

  if (!client.authed) return;
  const ch = client.channel && channels.get(client.channel);

  switch (msg.t) {
    case 'join': {
      const target = channels.get(String(msg.channel));
      if (!target) return send(client, { t: 'error', code: 'no_channel', msg: 'Canale inesistente' });
      if (target.password && String(msg.password || '') !== target.password) {
        return send(client, { t: 'error', code: 'channel_password', channel: target.id, msg: 'Password del canale errata' });
      }
      if (client.channel !== target.id) {
        leaveChannel(client);
        client.channel = target.id;
        target.clients.add(client);
        broadcast(target, { t: 'user_join', user: publicUser(client) }, client);
        scheduleChannelsUpdate();
      }
      send(client, {
        t: 'joined',
        channel: channelInfo(target),
        users: [...target.clients].map(publicUser),
        talker: target.talker ? publicUser(target.talker) : null,
        feed: channelFeed(target),
      });
      break;
    }

    case 'leave':
      leaveChannel(client);
      break;

    case 'ptt_start': {
      if (!ch) return;
      if (ch.talker && ch.talker !== client) return send(client, { t: 'ptt_busy', by: publicUser(ch.talker) });
      if (ch.talker === client) return send(client, { t: 'ptt_ok', maxTalk: MAX_TALK_MS / 1000 });
      ch.talker = client;
      ch.current = { id: rid(), from: publicUser(client), ts: Date.now(), chunks: [], bytes: 0 };
      ch.talkTimer = setTimeout(() => {
        if (ch.talker !== client) return;
        send(client, { t: 'ptt_timeout' });
        endTalk(ch, 'timeout');
      }, MAX_TALK_MS);
      send(client, { t: 'ptt_ok', maxTalk: MAX_TALK_MS / 1000 });
      broadcast(ch, { t: 'talk_start', user: publicUser(client), id: ch.current.id }, client);
      scheduleChannelsUpdate();
      break;
    }

    case 'ptt_stop':
      if (ch && ch.talker === client) endTalk(ch, 'stop');
      break;

    case 'text': {
      if (!ch) return;
      const now = Date.now();
      if (now - client.lastText < 600) return;
      const testo = clean(msg.text, 300);
      if (!testo) return;
      client.lastText = now;
      const m = { tipo: 'testo', id: rid(), from: publicUser(client), ts: now, testo };
      ch.texts.push(m);
      if (ch.texts.length > MAX_TEXT_HISTORY) ch.texts.shift();
      broadcast(ch, { t: 'text', msg: m });
      break;
    }

    case 'alert': {
      if (!ch) return;
      const now = Date.now();
      if (now - client.lastAlert < 15000) {
        return send(client, { t: 'error', code: 'rate', msg: 'Aspetta qualche secondo prima di inviare un altro SOS' });
      }
      client.lastAlert = now;
      const m = { tipo: 'allerta', id: rid(), from: publicUser(client), ts: now, testo: clean(msg.text, 120) };
      ch.texts.push(m);
      if (ch.texts.length > MAX_TEXT_HISTORY) ch.texts.shift();
      broadcast(ch, { t: 'alert', msg: m });
      log(`#${ch.id}  🚨 SOS da ${client.nome}${m.testo ? ' — ' + m.testo : ''}`);
      break;
    }

    case 'ping':
      send(client, { t: 'pong' });
      break;
  }
}

// ------------------------------------------------------------------ HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('Richiesta non valida');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Vietato');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Non trovato');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }

  if (url.pathname === '/api/info') {
    return sendJson(res, 200, {
      nome: config.nomeServer || 'Udine RP ITA',
      richiedePassword: !!SERVER_PASSWORD,
      reparti: REPARTI,
      versione: VERSION,
    });
  }

  // Riascolto di un messaggio vocale: /api/msg/<canale>/<id>.wav?k=<chiave sessione>
  const m = url.pathname.match(/^\/api\/msg\/([^/]+)\/([a-f0-9]{16})\.wav$/);
  if (m) {
    const client = byKey.get(url.searchParams.get('k') || '');
    const ch = channels.get(decodeURIComponent(m[1]));
    if (!client || !ch || client.channel !== ch.id) return sendJson(res, 403, { errore: 'Non autorizzato' });
    const item = ch.voice.find((v) => v.meta.id === m[2]);
    if (!item) return sendJson(res, 404, { errore: 'Messaggio non più disponibile' });
    const wav = wavFromPcm(item.pcm);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
    return res.end(wav);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(url.pathname, res);
});

// ------------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const client = {
    id: nextId++,
    key: crypto.randomBytes(16).toString('hex'),
    ws,
    nome: '',
    sigla: '',
    reparto: '',
    channel: null,
    authed: false,
    lastText: 0,
    lastAlert: 0,
  };

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) return onAudio(client, data);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    handle(client, msg);
  });

  ws.on('close', () => {
    leaveChannel(client);
    if (client.authed) {
      clients.delete(client.id);
      byKey.delete(client.key);
      log(`- ${client.nome} disconnesso — utenti online: ${clients.size}`);
      scheduleChannelsUpdate();
    }
  });

  ws.on('error', () => {});
});

// Controllo periodico: chiude le connessioni "morte" (telefono spento, rete persa…)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
}, HEARTBEAT_MS);

// ------------------------------------------------------------------ avvio

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`La porta ${PORT} è già usata da un altro programma (forse la radio è già accesa in un'altra finestra?).`);
  }
  fail(err.message);
});

server.listen(PORT, () => {
  const line = '='.repeat(62);
  console.log(`\n${line}`);
  console.log(`  📻  RADIO ${String(config.nomeServer || 'Udine RP ITA').toUpperCase()} — server acceso (v${VERSION})`);
  console.log(line);
  console.log(`  Su questo PC apri:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Stessa rete Wi-Fi:      http://${ip}:${PORT}   (solo ascolto*)`);
  console.log(`  Canali: ${[...channels.values()].map((c) => c.nome).join(', ')}`);
  if (SERVER_PASSWORD) console.log('  🔒 Accesso protetto da codice (passwordServer)');
  console.log('\n  * Per PARLARE da telefono serve un link https:// — vedi LEGGIMI.md');
  console.log('  Per spegnere il server chiudi questa finestra o premi CTRL+C.');
  console.log(`${line}\n`);
});
