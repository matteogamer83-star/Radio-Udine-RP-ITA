'use strict';
/**
 * Radio Udine RP — server push-to-talk in stile walkie-talkie (v2)
 *
 * - Si entra solo con un account creato dal Founder o dallo Staff
 * - Ruoli personalizzati con permessi, decisi solo dal Founder
 * - Pannello per gestire utenti, canali (radio), password e ruoli
 * - Audio in tempo reale via WebSocket (PCM 16 bit, 16 kHz, mono)
 * - Tasto PTT per Windows che funziona anche con il gioco in primo piano
 * - SOS con sirena e posizione, inoltrato anche ai canali "Centrale"
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createStore, Persist } = require('./lib/store');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = require('./package.json').version;

const config = loadConfig();

const PORT = Number(process.env.PORT) || Number(config.porta) || 3000;
const SAMPLE_RATE = 16000;
const MAX_TEXT_HISTORY = 60;
const MAX_HISTORY_BYTES = 12 * 1024 * 1024; // per canale
const MIN_VOICE_SECONDS = 0.3;
const MAX_AUDIO_FRAME = 32 * 1024;
const MAX_SEND_BUFFER = 1024 * 1024;
const HEARTBEAT_MS = 25000;
const TOKEN_DAYS = 120;

const NO_PERMS = { utenti: false, canali: false, tuttiCanali: false };
const FOUNDER_ROLE = { id: 'founder', nome: 'Founder', icona: '👑', colore: '#f2c230' };
const ECO_ROLE = { id: 'eco', nome: 'Prova audio', icona: '🔁', colore: '#22d3ee' };
const ECO_USER = { id: 0, uid: 'eco', nome: 'Eco · la tua voce', sigla: '', ruolo: 'eco' };

// ================================================================== config iniziale

function fail(msg) {
  console.error('\n[ERRORE] ' + msg + '\n');
  process.exit(1);
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    fail(`Non trovo il file di configurazione: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`config.json non è valido (${e.message}).\nControlla virgole e virgolette, oppure ripristina il file originale.`);
  }
}

// ================================================================== utilità

const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const rid = (bytes) => crypto.randomBytes(bytes || 8).toString('hex');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('it-IT')}]`, ...a);

function slug(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'canale'
  );
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Errore da mostrare all'utente così com'è */
class Fail extends Error {}
function need(cond, msg) {
  if (!cond) throw new Fail(msg);
}

// ================================================================== dati permanenti

const store = createStore(ROOT);
let db = null; // dati: utenti, ruoli, canali, impostazioni
let dbError = ''; // archivio non raggiungibile
let setupCode = null; // codice per creare il Founder (solo al primo avvio)
let setupBusy = false;
const persist = new Persist(store, () => db);

function seedData() {
  const roles = (config.reparti || ['Civile']).map((r) => {
    const o = typeof r === 'string' ? { nome: r } : r;
    return { id: 'r' + rid(4), nome: clean(o.nome, 30) || 'Ruolo', icona: o.icona || '👤', colore: o.colore || '#9ca3af', permessi: { ...NO_PERMS } };
  });
  let staff = roles.find((r) => /staff/i.test(r.nome));
  if (!staff) {
    staff = { id: 'r' + rid(4), nome: 'Staff', icona: '⭐', colore: '#f472b6', permessi: {} };
    roles.push(staff);
  }
  staff.permessi = { utenti: true, canali: true, tuttiCanali: true };

  const used = new Set();
  const channels = (config.canali || [{ nome: 'Generale' }]).map((c) => {
    let id = slug(c.id || c.nome);
    while (used.has(id)) id += '-' + rid(1);
    used.add(id);
    return {
      id,
      nome: clean(c.nome, 40) || id,
      icona: c.icona || '📻',
      descrizione: clean(c.descrizione, 80),
      password: String(c.password || ''),
      ruoli: c.soloStaff || id === 'staff' ? [staff.id] : [],
      riceveSos: !!c.riceveSos || id === 'centrale',
      eco: !!c.eco,
    };
  });

  return {
    version: 2,
    secret: rid(32),
    settings: {
      nomeServer: clean(config.nomeServer, 40) || 'Udine RP ITA',
      durataMassimaTrasmissione: Number(config.durataMassimaTrasmissione) || 60,
      messaggiVocaliSalvati: Number(config.messaggiVocaliSalvati ?? 20),
    },
    roles,
    users: [],
    channels,
  };
}

function migrate(d) {
  d.version = 2;
  if (!d.secret) d.secret = rid(32);
  d.settings = Object.assign({ nomeServer: 'Udine RP ITA', durataMassimaTrasmissione: 60, messaggiVocaliSalvati: 20 }, d.settings || {});
  d.roles = Array.isArray(d.roles) ? d.roles : [];
  for (const r of d.roles) r.permessi = Object.assign({}, NO_PERMS, r.permessi || {});
  d.users = Array.isArray(d.users) ? d.users : [];
  for (const u of d.users) {
    if (u.tv == null) u.tv = 1;
    if (u.attivo == null) u.attivo = true;
  }
  d.channels = Array.isArray(d.channels) ? d.channels : [];
  for (const c of d.channels) {
    c.ruoli = Array.isArray(c.ruoli) ? c.ruoli : [];
    c.password = c.password || '';
    c.riceveSos = !!c.riceveSos;
    c.eco = !!c.eco;
  }
  return d;
}

const settings = () => db.settings;
const maxTalkMs = () => clamp(Number(settings().durataMassimaTrasmissione) || 60, 5, 300) * 1000;
const maxVoice = () => clamp(Number(settings().messaggiVocaliSalvati ?? 20), 0, 50);

// ================================================================== ruoli e permessi

function roleOf(user) {
  if (user.founder) return { ...FOUNDER_ROLE, permessi: { utenti: true, canali: true, tuttiCanali: true } };
  return db.roles.find((r) => r.id === user.ruolo) || { id: user.ruolo, nome: '—', icona: '👤', colore: '#9ca3af', permessi: { ...NO_PERMS } };
}
function permsOf(user) {
  const p = roleOf(user).permessi;
  return { founder: !!user.founder, utenti: !!p.utenti, canali: !!p.canali, tuttiCanali: !!p.tuttiCanali };
}
const isAdminRole = (r) => !!(r && r.permessi && (r.permessi.utenti || r.permessi.canali || r.permessi.tuttiCanali));
const hasAdmin = (user) => {
  const p = permsOf(user);
  return p.founder || p.utenti || p.canali;
};
function canSee(user, cfg) {
  const p = permsOf(user);
  return p.founder || p.tuttiCanali || cfg.ruoli.length === 0 || cfg.ruoli.includes(user.ruolo);
}
function needsPassword(user, cfg) {
  const p = permsOf(user);
  return !!cfg.password && !p.founder && !p.tuttiCanali;
}
/** Chi può modificare chi: il Founder tutto; gli altri solo utenti "normali" (e sé stessi in parte) */
function canManageUser(actor, target) {
  if (actor.founder) return true;
  if (target.founder) return false;
  if (target.id === actor.id) return 'self';
  return !isAdminRole(roleOf(target));
}
function canAssignRole(actor, roleId) {
  const r = db.roles.find((x) => x.id === roleId);
  if (!r) return false;
  return actor.founder || !isAdminRole(r);
}
const displayName = (u) => (u.sigla ? `${u.sigla} · ${u.nome}` : u.nome);
const publicRoles = () => [FOUNDER_ROLE, ECO_ROLE, ...db.roles.map((r) => ({ id: r.id, nome: r.nome, icona: r.icona, colore: r.colore }))];

// ================================================================== sessioni (token firmati)

const hmac = (s) => crypto.createHmac('sha256', db.secret).update(s).digest('base64url');

function makeToken(user) {
  const payload = `${user.id}.${user.tv}.${Date.now()}`;
  return `${payload}.${hmac(payload)}`;
}

function checkToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [uid, tv, iat, sig] = parts;
  if (!safeEqual(sig, hmac(`${uid}.${tv}.${iat}`))) return null;
  if (Date.now() - Number(iat) > TOKEN_DAYS * 86400000) return null;
  const user = db.users.find((u) => u.id === uid);
  if (!user || !user.attivo || String(user.tv) !== tv) return null;
  return user;
}

function hashPassword(password, salt) {
  salt = salt || rid(16);
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), salt, 32, (err, key) => (err ? reject(err) : resolve({ salt, hash: key.toString('hex') })))
  );
}
async function verifyPassword(user, password) {
  const { hash } = await hashPassword(password, user ? user.salt : 'x');
  return !!user && safeEqual(hash, user.hash);
}

// limite tentativi di accesso
const fails = new Map();
function waitSeconds(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function addFail(key, max, ms) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= max) {
    f.until = Date.now() + ms;
    f.n = 0;
  }
  fails.set(key, f);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of fails) if (f.until < now && f.n === 0) fails.delete(k);
}, 10 * 60000).unref();

// ================================================================== validazione

function vUsername(s) {
  const v = String(s || '').trim().toLowerCase();
  need(/^[a-z0-9._-]{3,20}$/.test(v), 'Nome utente: da 3 a 20 caratteri, solo lettere minuscole, numeri, punto o trattino (niente spazi).');
  return v;
}
function vPassword(s) {
  const v = String(s || '');
  need(v.length >= 6 && v.length <= 64, 'La password deve avere almeno 6 caratteri.');
  return v;
}
function vText(s, max, what, required) {
  const v = clean(s, max);
  if (required) need(v.length > 0, `${what}: campo obbligatorio.`);
  return v;
}
const vIcon = (s, def) => clean(s, 8) || def;
const vColor = (s) => (/^#[0-9a-f]{6}$/i.test(String(s || '')) ? String(s).toLowerCase() : '#9ca3af');

// ================================================================== canali a runtime

const channels = new Map(); // id -> { cfg, clients, talker, current, voice, texts, ... }

function syncChannels() {
  if (!db) return;
  const ids = new Set(db.channels.map((c) => c.id));
  for (const [id, ch] of channels) {
    if (ids.has(id)) continue;
    for (const c of [...ch.clients]) {
      leaveChannel(c);
      send(c, { t: 'channel_gone', msg: `Il canale ${ch.cfg.nome} è stato eliminato.` });
    }
    clearTimeout(ch.talkTimer);
    channels.delete(id);
  }
  const old = new Map(channels);
  channels.clear();
  for (const cfg of db.channels) {
    const ch = old.get(cfg.id) || { id: cfg.id, clients: new Set(), talker: null, current: null, talkTimer: null, voice: [], voiceBytes: 0, texts: [] };
    ch.cfg = cfg;
    channels.set(cfg.id, ch);
  }
}

// ================================================================== connessioni

const conns = new Set();
const byKey = new Map(); // chiave per riascoltare i vocali -> connessione
let nextId = 1;

function send(conn, obj) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
}
function broadcast(ch, obj, except) {
  const data = JSON.stringify(obj);
  for (const c of ch.clients) if (c !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
}
const publicUser = (c) => ({ id: c.id, uid: c.user.id, nome: c.user.nome, sigla: c.user.sigla, ruolo: roleOf(c.user).id });
const webOf = (user) => [...conns].filter((c) => c.kind === 'web' && c.user && c.user.id === user.id);
const remotesOf = (user) => [...conns].filter((c) => c.kind === 'remote' && c.user && c.user.id === user.id);

function notifyRemote(user, obj) {
  for (const r of remotesOf(user)) send(r, { t: 'remote_state', ...obj });
}
function notifyRemoteSessions(user) {
  const n = webOf(user).filter((c) => c.remoteOk).length;
  for (const r of remotesOf(user)) send(r, { t: 'remote_sessions', n });
}
function notifyPcKey(user, nuovo) {
  const n = remotesOf(user).length;
  for (const w of webOf(user)) send(w, { t: 'pc_key', n, nuovo: !!nuovo });
}

function channelInfo(user, ch) {
  return {
    id: ch.id,
    nome: ch.cfg.nome,
    icona: ch.cfg.icona,
    descrizione: ch.cfg.descrizione,
    protetto: needsPassword(user, ch.cfg),
    utenti: ch.clients.size,
    attivo: !!ch.talker,
    sos: ch.cfg.riceveSos,
    eco: ch.cfg.eco,
  };
}
const channelList = (user) => [...channels.values()].filter((ch) => canSee(user, ch.cfg)).map((ch) => channelInfo(user, ch));

let channelsTimer = null;
function scheduleChannelsUpdate() {
  if (channelsTimer) return;
  channelsTimer = setTimeout(() => {
    channelsTimer = null;
    for (const c of conns) if (c.kind === 'web' && c.user) send(c, { t: 'channels', channels: channelList(c.user) });
  }, 150);
}

function meInfo(user) {
  return { uid: user.id, username: user.username, nome: user.nome, sigla: user.sigla, ruolo: roleOf(user).id, founder: !!user.founder };
}

function sessionPayload(conn) {
  const ch = conn.channel && channels.get(conn.channel);
  return {
    me: meInfo(conn.user),
    perms: permsOf(conn.user),
    roles: publicRoles(),
    channels: channelList(conn.user),
    channel: ch ? channelInfo(conn.user, ch) : null,
    server: settings().nomeServer,
    maxTalk: maxTalkMs() / 1000,
    pcKeys: remotesOf(conn.user).length,
  };
}

function kick(conn, msg) {
  leaveChannel(conn);
  send(conn, { t: 'kicked', msg });
  const user = conn.user;
  conn.user = null;
  conn.kind = null;
  if (conn.key) byKey.delete(conn.key);
  if (user) notifyRemoteSessions(user);
  setTimeout(() => conn.ws.close(), 300);
}

/** Dopo ogni modifica del pannello: aggiorna (o butta fuori) le sessioni interessate */
function refreshAll() {
  for (const c of [...conns]) {
    if (!c.user) continue;
    const u = db.users.find((x) => x.id === c.user.id);
    if (!u) {
      kick(c, 'Il tuo account è stato eliminato.');
      continue;
    }
    if (!u.attivo) {
      kick(c, 'Il tuo account è stato disattivato. Contatta lo staff.');
      continue;
    }
    if (u.tv !== c.tv) {
      kick(c, 'La password è stata cambiata: accedi di nuovo.');
      continue;
    }
    c.user = u;
    if (c.kind !== 'web') continue;
    const ch = c.channel && channels.get(c.channel);
    if (c.channel && (!ch || !canSee(u, ch.cfg))) {
      leaveChannel(c);
      send(c, { t: 'channel_gone', msg: 'Non hai più accesso a questo canale.' });
    }
    send(c, { t: 'session', ...sessionPayload(c) });
  }
  for (const ch of channels.values()) broadcast(ch, { t: 'users', users: [...ch.clients].map(publicUser) });
}

function refreshAdmins() {
  for (const c of conns) if (c.kind === 'web' && c.user && hasAdmin(c.user)) send(c, { t: 'admin_dirty' });
}

function afterChange() {
  persist.schedule();
  syncChannels();
  refreshAll();
  scheduleChannelsUpdate();
  refreshAdmins();
}

// ================================================================== canali e trasmissione

function leaveChannel(conn) {
  const ch = conn.channel && channels.get(conn.channel);
  conn.channel = null;
  stopEcho(conn, true);
  if (!ch) return;
  if (ch.talker === conn) endTalk(ch, 'left');
  ch.clients.delete(conn);
  if (conn.user) broadcast(ch, { t: 'user_leave', user: publicUser(conn) });
  scheduleChannelsUpdate();
}

function endTalk(ch, reason) {
  clearTimeout(ch.talkTimer);
  ch.talkTimer = null;
  const cur = ch.current;
  const talker = ch.talker;
  ch.talker = null;
  ch.current = null;
  if (!cur) return;

  const seconds = cur.bytes / 2 / SAMPLE_RATE;
  let meta = null;
  if (seconds >= MIN_VOICE_SECONDS) {
    const pcm = cur.keep ? Buffer.concat(cur.chunks) : null;
    if (ch.cfg.eco) {
      if (pcm && talker && (reason === 'stop' || reason === 'timeout')) setTimeout(() => startEcho(talker, pcm, ch), 350);
    } else {
      meta = { tipo: 'voce', id: cur.id, from: cur.from, ts: cur.ts, durata: Math.round(seconds * 10) / 10 };
      if (pcm && maxVoice() > 0) {
        ch.voice.push({ meta, pcm });
        ch.voiceBytes += pcm.length;
        while (ch.voice.length > maxVoice() || ch.voiceBytes > MAX_HISTORY_BYTES) {
          const old = ch.voice.shift();
          ch.voiceBytes -= old.pcm.length;
        }
      }
      log(`#${ch.id}  ${cur.from.nome} ha parlato ${meta.durata}s`);
    }
  }
  broadcast(ch, { t: 'talk_end', user: cur.from, id: cur.id, msg: meta, reason });
  if (talker && talker.user) notifyRemote(talker.user, { state: 'idle' });
  scheduleChannelsUpdate();
}

// Canale "eco": dopo che hai parlato il server ti rimanda la tua voce, come in diretta
function startEcho(conn, pcm, ch) {
  if (conn.channel !== ch.id || ch.talker || conn.ws.readyState !== WebSocket.OPEN) return;
  stopEcho(conn, true);
  const echo = { id: rid(), pos: 0, timer: null };
  conn.echo = echo;
  send(conn, { t: 'talk_start', user: ECO_USER, id: echo.id, eco: true });
  echo.timer = setInterval(() => {
    if (conn.echo !== echo) return;
    if (conn.ws.readyState !== WebSocket.OPEN || conn.channel !== ch.id) return stopEcho(conn, true);
    const slice = pcm.subarray(echo.pos, echo.pos + 1280);
    if (!slice.length) return stopEcho(conn);
    conn.ws.send(slice, { binary: true });
    echo.pos += 1280;
  }, 40);
}
function stopEcho(conn, silent) {
  const e = conn.echo;
  if (!e) return;
  clearInterval(e.timer);
  conn.echo = null;
  if (!silent) send(conn, { t: 'talk_end', user: ECO_USER, id: e.id, msg: null, reason: 'eco' });
}

function onAudio(conn, data) {
  const ch = conn.channel && channels.get(conn.channel);
  if (!ch || ch.talker !== conn || !ch.current) return;
  if (data.length === 0 || data.length > MAX_AUDIO_FRAME || data.length % 2 !== 0) return;
  if (ch.current.keep) ch.current.chunks.push(data);
  ch.current.bytes += data.length;
  for (const c of ch.clients) {
    if (c === conn || c.ws.readyState !== WebSocket.OPEN) continue;
    if (c.ws.bufferedAmount > MAX_SEND_BUFFER) continue; // rete lenta: salta il pacchetto
    c.ws.send(data, { binary: true });
  }
}

function channelFeed(ch) {
  return ch.voice
    .map((v) => v.meta)
    .concat(ch.texts)
    .sort((a, b) => a.ts - b.ts)
    .slice(-100);
}
function pushText(ch, m) {
  ch.texts.push(m);
  if (ch.texts.length > MAX_TEXT_HISTORY) ch.texts.shift();
}

// ================================================================== accesso

function authOk(conn, user, msg, extra) {
  conn.kind = 'web';
  conn.user = user;
  conn.tv = user.tv;
  conn.key = rid(16);
  conn.remoteOk = !!(msg && msg.tastoPc);
  byKey.set(conn.key, conn);
  user.ultimoAccesso = Date.now();
  persist.schedule(30000);
  send(conn, { t: 'welcome', id: conn.id, key: conn.key, token: makeToken(user), ...sessionPayload(conn), ...(extra || {}) });
  notifyRemoteSessions(user);
  log(`+ ${displayName(user)} (@${user.username}) connesso — online: ${[...conns].filter((c) => c.kind === 'web').length}`);
}

function notReady(conn) {
  if (dbError) send(conn, { t: 'auth_fail', code: 'archivio', msg: 'La radio non riesce a leggere i suoi dati. Avvisa il Founder.' });
  else if (setupCode) send(conn, { t: 'auth_fail', code: 'setup', msg: 'La radio non è ancora stata configurata dal Founder.' });
  else send(conn, { t: 'auth_fail', code: 'caricamento', msg: 'La radio si sta avviando: riprova tra qualche secondo.' });
}

async function doLogin(conn, msg) {
  if (!db) return notReady(conn);
  if (conn.busy) return;
  const username = String(msg.username || '').trim().toLowerCase();
  const wait = waitSeconds('ip:' + conn.ip) || waitSeconds('u:' + username);
  if (wait) return send(conn, { t: 'auth_fail', code: 'limite', msg: `Troppi tentativi sbagliati. Riprova tra ${wait} secondi.` });
  const user = db.users.find((u) => u.username === username);
  conn.busy = true;
  let ok = false;
  try {
    ok = await verifyPassword(user, String(msg.password || ''));
  } finally {
    conn.busy = false;
  }
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  if (!ok) {
    addFail('ip:' + conn.ip, 10, 5 * 60000);
    addFail('u:' + username, 5, 60000);
    return send(conn, { t: 'auth_fail', code: 'credenziali', msg: 'Nome utente o password sbagliati.' });
  }
  if (!user.attivo) return send(conn, { t: 'auth_fail', code: 'disattivato', msg: 'Il tuo account è disattivato. Contatta lo staff.' });
  fails.delete('u:' + username);
  authOk(conn, user, msg);
}

function doTokenAuth(conn, msg) {
  if (!db) return notReady(conn);
  const user = checkToken(msg.token);
  if (!user) return send(conn, { t: 'auth_fail', code: 'token', msg: 'Sessione scaduta: accedi di nuovo.' });
  authOk(conn, user, msg);
}

async function doSetup(conn, msg) {
  if (db || dbError || !setupCode) return send(conn, { t: 'auth_fail', code: 'setup_done', msg: 'La radio è già configurata: accedi con il tuo account.' });
  if (setupBusy) return;
  const wait = waitSeconds('ip:' + conn.ip);
  if (wait) return send(conn, { t: 'auth_fail', code: 'limite', msg: `Troppi tentativi. Riprova tra ${wait} secondi.` });
  if (String(msg.code || '').trim() !== setupCode) {
    addFail('ip:' + conn.ip, 5, 5 * 60000);
    return send(conn, { t: 'auth_fail', code: 'codice', msg: 'Codice di installazione sbagliato. Lo trovi nella finestra del server (o su Render → Logs).' });
  }
  let username, password, nome, sigla;
  try {
    username = vUsername(msg.username);
    password = vPassword(msg.password);
    nome = vText(msg.nome, 24, 'Nome RP', true);
    sigla = vText(msg.sigla, 16, 'Sigla');
  } catch (e) {
    return send(conn, { t: 'auth_fail', code: 'dati', msg: e.message });
  }
  setupBusy = true;
  try {
    const { salt, hash } = await hashPassword(password);
    const data = seedData();
    const founder = { id: rid(4), username, nome, sigla, ruolo: 'founder', founder: true, attivo: true, tv: 1, salt, hash, creato: Date.now(), creatoDa: 'installazione' };
    data.users.push(founder);
    db = migrate(data);
    persist.dirty = true;
    try {
      await persist.flush();
    } catch (e) {
      db = null;
      return send(conn, { t: 'auth_fail', code: 'archivio', msg: `Impossibile salvare i dati: ${e.message}` });
    }
    setupCode = null;
    syncChannels();
    log(`👑 Founder creato: ${displayName(founder)} (@${username})`);
    authOk(conn, founder, msg);
  } finally {
    setupBusy = false;
  }
}

function doRemoteAuth(conn, msg) {
  const token = String(msg.token || '');
  const user = db && token.length >= 32 ? db.users.find((u) => u.ptt && safeEqual(u.ptt, token)) : null;
  if (!user || !user.attivo) {
    send(conn, { t: 'remote_error', msg: 'Codice del tasto non valido. Scarica di nuovo il file dalla radio (Impostazioni).' });
    setTimeout(() => conn.ws.close(), 300);
    return;
  }
  conn.kind = 'remote';
  conn.user = user;
  conn.tv = user.tv;
  send(conn, { t: 'remote_ok', nome: displayName(user), sessioni: webOf(user).filter((c) => c.remoteOk).length });
  notifyPcKey(user, true);
  log(`⌨️  Tasto PTT collegato per ${displayName(user)}`);
}

// ================================================================== pannello Founder / Staff

function adminState(u) {
  const p = permsOf(u);
  const online = (x) => webOf(x).length;
  return {
    perms: p,
    me: u.id,
    roles: db.roles.map((r) => ({ ...r, assegnabile: canAssignRole(u, r.id), utenti: db.users.filter((x) => x.ruolo === r.id).length })),
    users: p.utenti
      ? db.users.map((x) => ({
          id: x.id,
          username: x.username,
          nome: x.nome,
          sigla: x.sigla,
          ruolo: roleOf(x).id,
          founder: !!x.founder,
          attivo: x.attivo,
          creato: x.creato,
          creatoDa: x.creatoDa,
          ultimoAccesso: x.ultimoAccesso || 0,
          online: online(x),
          gestibile: canManageUser(u, x),
        }))
      : [],
    channels: p.canali ? db.channels.map((c) => ({ ...c, utenti: channels.get(c.id) ? channels.get(c.id).clients.size : 0 })) : [],
    settings: p.founder ? db.settings : null,
    storage: p.founder ? persist.status() : null,
  };
}

async function request(conn, msg) {
  const u = conn.user;
  const p = permsOf(u);
  const findUser = (id) => {
    const t = db.users.find((x) => x.id === id);
    need(t, 'Utente non trovato.');
    return t;
  };

  switch (msg.op) {
    case 'state':
      need(hasAdmin(u), 'Non hai accesso al pannello.');
      return adminState(u);

    // ------------------------------------------------ utenti
    case 'user_create': {
      need(p.utenti, 'Non hai il permesso di creare utenti.');
      const username = vUsername(msg.username);
      const password = vPassword(msg.password);
      const nome = vText(msg.nome, 24, 'Nome RP', true);
      const sigla = vText(msg.sigla, 16, 'Sigla');
      need(canAssignRole(u, msg.ruolo), 'Non puoi assegnare questo ruolo.');
      const { salt, hash } = await hashPassword(password);
      need(!db.users.some((x) => x.username === username), `Il nome utente "${username}" esiste già.`);
      const nu = { id: rid(4), username, nome, sigla, ruolo: msg.ruolo, attivo: true, tv: 1, salt, hash, creato: Date.now(), creatoDa: u.username };
      db.users.push(nu);
      log(`👤 ${u.username} ha creato l'utente @${username}`);
      afterChange();
      return { id: nu.id };
    }
    case 'user_update': {
      need(p.utenti, 'Non hai il permesso di modificare utenti.');
      const t = findUser(msg.id);
      const can = canManageUser(u, t);
      need(can, 'Non puoi modificare questo utente (solo il Founder può gestire lo Staff).');
      if (msg.nome != null) t.nome = vText(msg.nome, 24, 'Nome RP', true);
      if (msg.sigla != null) t.sigla = vText(msg.sigla, 16, 'Sigla');
      if (can !== 'self' && !t.founder) {
        if (msg.ruolo != null && msg.ruolo !== t.ruolo) {
          need(canAssignRole(u, msg.ruolo), 'Non puoi assegnare questo ruolo.');
          t.ruolo = msg.ruolo;
        }
        if (msg.attivo != null) t.attivo = !!msg.attivo;
      }
      afterChange();
      return {};
    }
    case 'user_password': {
      need(p.utenti, 'Non hai il permesso di cambiare password.');
      const t = findUser(msg.id);
      need(canManageUser(u, t) === true, 'Non puoi cambiare la password di questo utente.');
      const { salt, hash } = await hashPassword(vPassword(msg.password));
      t.salt = salt;
      t.hash = hash;
      t.tv++;
      if (t.id === u.id) conn.tv = t.tv;
      afterChange();
      return { token: t.id === u.id ? makeToken(t) : null };
    }
    case 'user_delete': {
      need(p.utenti, 'Non hai il permesso di eliminare utenti.');
      const t = findUser(msg.id);
      need(t.id !== u.id, 'Non puoi eliminare te stesso.');
      need(!t.founder, 'Il Founder non si può eliminare.');
      need(canManageUser(u, t) === true, 'Non puoi eliminare questo utente (solo il Founder può gestire lo Staff).');
      db.users = db.users.filter((x) => x !== t);
      log(`🗑️  ${u.username} ha eliminato l'utente @${t.username}`);
      afterChange();
      return {};
    }

    // ------------------------------------------------ canali
    case 'channel_save': {
      need(p.canali, 'Non hai il permesso di gestire i canali.');
      const roleIds = new Set(db.roles.map((r) => r.id));
      const data = {
        nome: vText(msg.nome, 40, 'Nome del canale', true),
        icona: vIcon(msg.icona, '📻'),
        descrizione: vText(msg.descrizione, 80, 'Descrizione'),
        password: String(msg.password || '').slice(0, 64),
        ruoli: (Array.isArray(msg.ruoli) ? msg.ruoli : []).filter((id) => roleIds.has(id)),
        riceveSos: !!msg.riceveSos,
        eco: !!msg.eco,
      };
      if (msg.id) {
        const c = db.channels.find((x) => x.id === msg.id);
        need(c, 'Canale non trovato.');
        Object.assign(c, data);
      } else {
        need(db.channels.length < 60, 'Troppi canali (massimo 60).');
        let id = slug(data.nome);
        while (db.channels.some((x) => x.id === id)) id = slug(data.nome).slice(0, 18) + '-' + rid(2);
        db.channels.push({ id, ...data });
      }
      afterChange();
      return {};
    }
    case 'channel_delete': {
      need(p.canali, 'Non hai il permesso di gestire i canali.');
      need(db.channels.length > 1, 'Deve restare almeno un canale.');
      need(db.channels.some((x) => x.id === msg.id), 'Canale non trovato.');
      db.channels = db.channels.filter((x) => x.id !== msg.id);
      afterChange();
      return {};
    }
    case 'channel_move': {
      need(p.canali, 'Non hai il permesso di gestire i canali.');
      const i = db.channels.findIndex((x) => x.id === msg.id);
      const j = i + (msg.dir < 0 ? -1 : 1);
      need(i >= 0, 'Canale non trovato.');
      if (j >= 0 && j < db.channels.length) [db.channels[i], db.channels[j]] = [db.channels[j], db.channels[i]];
      afterChange();
      return {};
    }

    // ------------------------------------------------ ruoli (solo Founder)
    case 'role_save': {
      need(p.founder, 'Solo il Founder può gestire i ruoli.');
      const pm = msg.permessi || {};
      const data = {
        nome: vText(msg.nome, 30, 'Nome del ruolo', true),
        icona: vIcon(msg.icona, '👤'),
        colore: vColor(msg.colore),
        permessi: { utenti: !!pm.utenti, canali: !!pm.canali, tuttiCanali: !!pm.tuttiCanali },
      };
      need(!/^founder$/i.test(data.nome), 'Il nome "Founder" è riservato.');
      if (msg.id) {
        const r = db.roles.find((x) => x.id === msg.id);
        need(r, 'Ruolo non trovato.');
        Object.assign(r, data);
      } else {
        need(db.roles.length < 50, 'Troppi ruoli (massimo 50).');
        db.roles.push({ id: 'r' + rid(4), ...data });
      }
      afterChange();
      return {};
    }
    case 'role_delete': {
      need(p.founder, 'Solo il Founder può gestire i ruoli.');
      const r = db.roles.find((x) => x.id === msg.id);
      need(r, 'Ruolo non trovato.');
      const n = db.users.filter((x) => x.ruolo === r.id).length;
      need(n === 0, `Questo ruolo è usato da ${n} ${n === 1 ? 'utente' : 'utenti'}: cambia prima il loro ruolo.`);
      need(db.roles.length > 1, 'Deve restare almeno un ruolo.');
      db.roles = db.roles.filter((x) => x !== r);
      for (const c of db.channels) c.ruoli = c.ruoli.filter((id) => id !== r.id);
      afterChange();
      return {};
    }

    // ------------------------------------------------ impostazioni (solo Founder)
    case 'settings_save': {
      need(p.founder, 'Solo il Founder può cambiare le impostazioni del server.');
      db.settings.nomeServer = vText(msg.nomeServer, 40, 'Nome del server', true);
      db.settings.durataMassimaTrasmissione = clamp(Math.round(Number(msg.durataMassimaTrasmissione) || 60), 5, 300);
      db.settings.messaggiVocaliSalvati = clamp(Math.round(Number(msg.messaggiVocaliSalvati) || 0), 0, 50);
      afterChange();
      return {};
    }
    case 'export': {
      need(p.founder, 'Solo il Founder può scaricare il backup.');
      return { data: db };
    }

    // ------------------------------------------------ per tutti
    case 'my_password': {
      need(await verifyPassword(u, String(msg.old || '')), 'La password attuale è sbagliata.');
      const { salt, hash } = await hashPassword(vPassword(msg.password));
      u.salt = salt;
      u.hash = hash;
      u.tv++;
      conn.tv = u.tv;
      afterChange();
      return { token: makeToken(u) };
    }
    case 'ptt_token': {
      if (!u.ptt) {
        u.ptt = rid(24);
        persist.schedule();
      }
      return { token: u.ptt };
    }
  }
  throw new Fail('Operazione sconosciuta.');
}

// ================================================================== messaggi

function handleWeb(conn, msg) {
  const user = conn.user;
  const ch = conn.channel && channels.get(conn.channel);

  switch (msg.t) {
    case 'join': {
      const target = channels.get(String(msg.channel));
      if (!target || !canSee(user, target.cfg)) return send(conn, { t: 'error', code: 'no_channel', msg: 'Canale inesistente o non accessibile.' });
      if (needsPassword(user, target.cfg) && String(msg.password || '') !== target.cfg.password) {
        return send(conn, { t: 'error', code: 'channel_password', channel: target.id, msg: 'Password del canale errata.' });
      }
      if (conn.channel !== target.id) {
        leaveChannel(conn);
        conn.channel = target.id;
        target.clients.add(conn);
        broadcast(target, { t: 'user_join', user: publicUser(conn) }, conn);
        scheduleChannelsUpdate();
      }
      send(conn, {
        t: 'joined',
        channel: channelInfo(user, target),
        users: [...target.clients].map(publicUser),
        talker: target.talker ? publicUser(target.talker) : null,
        feed: channelFeed(target),
      });
      break;
    }

    case 'leave':
      leaveChannel(conn);
      break;

    case 'ptt_start': {
      if (!ch) return;
      stopEcho(conn, true);
      if (ch.talker && ch.talker !== conn) {
        notifyRemote(user, { state: 'busy', da: displayName(ch.talker.user) });
        return send(conn, { t: 'ptt_busy', by: publicUser(ch.talker) });
      }
      if (ch.talker === conn) return send(conn, { t: 'ptt_ok', maxTalk: maxTalkMs() / 1000 });
      for (const c of ch.clients) stopEcho(c);
      ch.talker = conn;
      ch.current = { id: rid(), from: publicUser(conn), ts: Date.now(), chunks: [], bytes: 0, keep: ch.cfg.eco || maxVoice() > 0 };
      ch.talkTimer = setTimeout(() => {
        if (ch.talker !== conn) return;
        send(conn, { t: 'ptt_timeout' });
        endTalk(ch, 'timeout');
      }, maxTalkMs());
      send(conn, { t: 'ptt_ok', maxTalk: maxTalkMs() / 1000 });
      broadcast(ch, { t: 'talk_start', user: publicUser(conn), id: ch.current.id }, conn);
      notifyRemote(user, { state: 'on', canale: ch.cfg.nome, ascoltatori: ch.clients.size - 1 });
      scheduleChannelsUpdate();
      break;
    }

    case 'ptt_stop':
      if (ch && ch.talker === conn) endTalk(ch, 'stop');
      break;

    case 'text': {
      if (!ch) return;
      const now = Date.now();
      if (now - (conn.lastText || 0) < 600) return;
      const testo = clean(msg.text, 300);
      if (!testo) return;
      conn.lastText = now;
      const m = { tipo: 'testo', id: rid(), from: publicUser(conn), ts: now, testo };
      pushText(ch, m);
      broadcast(ch, { t: 'text', msg: m });
      break;
    }

    case 'alert': {
      if (!ch) return;
      const now = Date.now();
      if (now - (conn.lastAlert || 0) < 15000) {
        return send(conn, { t: 'error', code: 'rate', msg: 'Aspetta qualche secondo prima di inviare un altro SOS.' });
      }
      conn.lastAlert = now;
      const m = {
        tipo: 'allerta',
        id: rid(),
        from: publicUser(conn),
        ts: now,
        testo: clean(msg.text, 120),
        canale: { id: ch.id, nome: ch.cfg.nome, icona: ch.cfg.icona },
      };
      const targets = new Set(ch.clients);
      pushText(ch, m);
      for (const other of channels.values()) {
        if (other === ch || !other.cfg.riceveSos) continue;
        pushText(other, m);
        for (const c of other.clients) targets.add(c);
      }
      const data = JSON.stringify({ t: 'alert', msg: m });
      for (const c of targets) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
      log(`🚨 SOS da ${displayName(user)} su #${ch.id}${m.testo ? ' — ' + m.testo : ''}`);
      break;
    }

    case 'sos_ack': {
      let m = null;
      for (const c of channels.values()) {
        m = c.texts.find((x) => x.tipo === 'allerta' && x.id === msg.id);
        if (m) break;
      }
      if (!m) return;
      m.presoDa = m.presoDa || [];
      if (m.presoDa.some((x) => x.uid === user.id)) return;
      const by = publicUser(conn);
      m.presoDa.push({ uid: user.id, nome: displayName(user) });
      const targets = new Set();
      for (const c of channels.values()) {
        if (c.id === m.canale.id || c.cfg.riceveSos) for (const x of c.clients) targets.add(x);
      }
      const data = JSON.stringify({ t: 'sos_ack', id: m.id, by, alert: { from: m.from, testo: m.testo } });
      for (const c of targets) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
      break;
    }

    case 'set_remote':
      conn.remoteOk = !!msg.on;
      notifyRemoteSessions(user);
      break;

    case 'req': {
      const reply = (obj) => send(conn, { t: 'res', rid: msg.rid, ...obj });
      if (!db) return reply({ ok: false, error: 'Archivio dati non disponibile.' });
      request(conn, msg).then(
        (data) => reply({ ok: true, data }),
        (e) => {
          if (!(e instanceof Fail)) console.error('[ERRORE] richiesta', msg.op, e);
          reply({ ok: false, error: e instanceof Fail ? e.message : 'Errore interno del server.' });
        }
      );
      break;
    }

    case 'ping':
      send(conn, { t: 'pong' });
      break;
  }
}

function handleRemote(conn, msg) {
  switch (msg.t) {
    case 'remote_ptt': {
      const down = !!msg.down;
      conn.remoteDown = down;
      const targets = webOf(conn.user).filter((c) => c.remoteOk);
      if (!targets.length) {
        if (down) send(conn, { t: 'remote_state', state: 'no_session' });
        return;
      }
      for (const t of targets) send(t, { t: 'remote_ptt', down });
      break;
    }
    case 'ping':
      send(conn, { t: 'pong' });
      break;
  }
}

function handle(conn, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  if (!conn.user) {
    switch (msg.t) {
      case 'login':
        return void doLogin(conn, msg).catch((e) => console.error('[ERRORE] login', e));
      case 'auth':
        return doTokenAuth(conn, msg);
      case 'setup':
        return void doSetup(conn, msg).catch((e) => console.error('[ERRORE] setup', e));
      case 'remote_auth':
        return doRemoteAuth(conn, msg);
      case 'ping':
        return send(conn, { t: 'pong' });
    }
    return;
  }
  if (conn.kind === 'web') return handleWeb(conn, msg);
  if (conn.kind === 'remote') return handleRemote(conn, msg);
}

// ================================================================== HTTP

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
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

function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
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
      nome: db ? settings().nomeServer : clean(config.nomeServer, 40) || 'Udine RP ITA',
      setup: !db && !dbError && !!setupCode,
      caricamento: !db && !dbError && !setupCode,
      errore: dbError || null,
      versione: VERSION,
    });
  }

  // Riascolto di un vocale: /api/msg/<canale>/<id>.wav?k=<chiave della sessione>
  const m = url.pathname.match(/^\/api\/msg\/([^/]+)\/([a-f0-9]{16})\.wav$/);
  if (m) {
    const conn = byKey.get(url.searchParams.get('k') || '');
    const ch = channels.get(decodeURIComponent(m[1]));
    if (!conn || !ch || conn.channel !== ch.id) return sendJson(res, 403, { errore: 'Non autorizzato' });
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

// ================================================================== WebSocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const conn = { id: nextId++, ws, ip: fwd || req.socket.remoteAddress || '?', kind: null, user: null, channel: null };
  conns.add(conn);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      if (conn.kind === 'web') onAudio(conn, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    try {
      handle(conn, msg);
    } catch (e) {
      console.error('[ERRORE] messaggio', msg && msg.t, e);
    }
  });

  ws.on('close', () => {
    conns.delete(conn);
    leaveChannel(conn);
    if (conn.key) byKey.delete(conn.key);
    const user = conn.user;
    if (!user) return;
    if (conn.kind === 'web') {
      log(`- ${displayName(user)} disconnesso — online: ${[...conns].filter((c) => c.kind === 'web').length}`);
      notifyRemoteSessions(user);
    } else if (conn.kind === 'remote') {
      // il tasto si è scollegato mentre era premuto: chiudi la trasmissione
      if (conn.remoteDown) for (const t of webOf(user).filter((c) => c.remoteOk)) send(t, { t: 'remote_ptt', down: false });
      notifyPcKey(user, false);
    }
  });

  ws.on('error', () => {});
});

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

// ================================================================== avvio

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}

function printSetup() {
  const line = '*'.repeat(62);
  console.log(`\n${line}`);
  console.log('  👑 PRIMA ACCENSIONE — crea l\'account del FOUNDER');
  console.log(`     Apri la radio nel browser e usa questo codice:  ${setupCode}`);
  console.log(`${line}\n`);
}

async function init() {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await store.load();
      dbError = '';
      if (data) {
        db = migrate(data);
        syncChannels();
        log(`Dati caricati: ${db.users.length} utenti, ${db.roles.length} ruoli, ${db.channels.length} canali — archivio: ${store.descrizione()}`);
      } else {
        setupCode = String(process.env.SETUP_CODE || crypto.randomInt(100000, 1000000)).trim();
        printSetup();
      }
      if (store.temporaneo) {
        console.log('\n  ⚠️  ATTENZIONE: archivio TEMPORANEO. Al riavvio del server account e canali verranno PERSI.');
        console.log('      Imposta la variabile GITHUB_TOKEN (vedi LEGGIMI.md, sezione Render).\n');
      }
      return;
    } catch (e) {
      dbError = `Archivio dati non raggiungibile: ${e.message}`;
      const wait = Math.min(60, attempt * 5);
      console.error(`[ERRORE] ${dbError} — riprovo tra ${wait} s`);
      await sleep(wait * 1000);
    }
  }
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
  console.log(`  📻  RADIO UDINE RP — server acceso (v${VERSION})`);
  console.log(line);
  console.log(`  Su questo PC apri:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Stessa rete Wi-Fi:      http://${ip}:${PORT}   (solo ascolto*)`);
  console.log(`  Archivio dati:          ${store.descrizione()}`);
  console.log('\n  * Per PARLARE da telefono serve un link https:// — vedi LEGGIMI.md');
  console.log('  Per spegnere il server chiudi questa finestra o premi CTRL+C.');
  console.log(`${line}\n`);
  init();
});

// Salva i dati prima di spegnersi (Render manda SIGTERM quando riavvia)
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  if (db && persist.dirty) {
    console.log('Salvo i dati prima di spegnere...');
    await Promise.race([persist.flush().catch(() => {}), sleep(8000)]);
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown); // Windows: chiusura della finestra del server
