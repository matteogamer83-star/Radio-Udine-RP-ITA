'use strict';
/*
 * Test automatico: accende il server su una porta di prova (con un archivio dati vuoto)
 * e simula Founder, Staff e utenti che si collegano, parlano, usano il tasto PC, mandano SOS...
 * Uso:  npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const SETUP_CODE = '424242';
const DATA_FILE = path.join(os.tmpdir(), `radio-test-${process.pid}-${Date.now()}.json`);

let passed = 0;
function ok(cond, what) {
  if (!cond) throw new Error('FALLITO: ' + what);
  passed++;
  console.log('  ✅ ' + what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ server
let srv = null;
let srvOut = '';
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), DATA_FILE, SETUP_CODE };
  delete env.GITHUB_TOKEN;
  delete env.RENDER;
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'pipe' });
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${PORT}/api/info`)).json();
      if (!info.caricamento) return info;
    } catch (e) {}
    await sleep(100);
  }
  throw new Error('il server non si accende');
}
async function stopServer() {
  if (!srv) return;
  const p = new Promise((r) => srv.once('exit', r));
  srv.kill();
  await p;
  srv = null;
}

// ------------------------------------------------------------------ radio simulate
function radio(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const r = { ws, name, msgs: [], bins: [], binTimes: [], waiters: [], rid: 0 };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        r.bins.push(data);
        r.binTimes.push(Date.now());
        return;
      }
      const m = JSON.parse(data.toString());
      const w = r.waiters.find((x) => x.pred(m));
      if (w) {
        r.waiters.splice(r.waiters.indexOf(w), 1);
        w.resolve(m);
      } else r.msgs.push(m);
    });
    ws.on('open', () => resolve(r));
    ws.on('error', reject);
  });
}
function waitFor(r, t, pred, ms) {
  const match = (m) => m.t === t && (!pred || pred(m));
  const i = r.msgs.findIndex(match);
  if (i >= 0) return Promise.resolve(r.msgs.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred: match, resolve: (m) => (clearTimeout(timer), resolve(m)) };
    const timer = setTimeout(() => {
      r.waiters.splice(r.waiters.indexOf(w), 1);
      reject(new Error(`${r.name}: nessun messaggio "${t}" ricevuto`));
    }, ms || 4000);
    r.waiters.push(w);
  });
}
async function noMsg(r, t, ms) {
  try {
    await waitFor(r, t, null, ms || 500);
    return false;
  } catch (e) {
    return true;
  }
}
const send = (r, obj) => r.ws.send(JSON.stringify(obj));
async function req(r, op, data) {
  const rid = ++r.rid;
  send(r, { ...(data || {}), t: 'req', rid, op });
  const m = await waitFor(r, 'res', (x) => x.rid === rid, 8000);
  if (!m.ok) throw new Error(m.error);
  return m.data;
}
async function reqFails(r, op, data) {
  try {
    await req(r, op, data);
    return null;
  } catch (e) {
    return e.message;
  }
}
async function login(name, username, password, extra) {
  const r = await radio(name);
  send(r, { t: 'login', username, password, tastoPc: true, ...(extra || {}) });
  const w = await waitFor(r, 'welcome');
  r.welcome = w;
  return r;
}
async function joinCh(r, channel, password) {
  send(r, { t: 'join', channel, password });
  return waitFor(r, 'joined', (m) => m.channel.id === channel);
}
function tone(ms, freq) {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 16000) * 8000), i * 2);
  return b;
}

// ------------------------------------------------------------------ test
async function main() {
  console.log(`\nAvvio server di prova sulla porta ${PORT} (archivio vuoto)…`);
  const all = [];
  try {
    let info = await startServer();
    ok(info.setup === true, 'primo avvio: la radio chiede di creare il Founder');
    ok((await fetch(`http://127.0.0.1:${PORT}/admin.js`)).ok && (await fetch(`http://127.0.0.1:${PORT}/ptt-helper.txt`)).ok, 'pagine dell\'app, pannello e tasto PC vengono serviti');
    const trav = await fetch(`http://127.0.0.1:${PORT}/..%2fserver.js`);
    ok(trav.status === 403 || trav.status === 404, 'impossibile leggere file fuori da /public');

    // ---------------------------------------------------- creazione Founder
    const x = await radio('Sconosciuto');
    all.push(x);
    send(x, { t: 'login', username: 'chiunque', password: 'qualcosa' });
    ok((await waitFor(x, 'auth_fail')).code === 'setup', 'nessuno entra prima che esista il Founder');
    send(x, { t: 'setup', code: '000000', username: 'boss', password: 'segreta1', nome: 'Matteo' });
    ok((await waitFor(x, 'auth_fail')).code === 'codice', 'creazione Founder rifiutata con codice sbagliato');

    const F = await radio('Founder');
    all.push(F);
    send(F, { t: 'setup', code: SETUP_CODE, username: 'Boss', password: 'segreta1', nome: 'Matteo', sigla: 'Centrale 1', tastoPc: false });
    const fw = await waitFor(F, 'welcome');
    ok(fw.perms.founder && fw.me.username === 'boss' && fw.token, 'Founder creato con il codice di installazione');
    ok(fs.existsSync(DATA_FILE), 'i dati vengono salvati su disco');

    let st = await req(F, 'state');
    const roleBy = (n) => st.roles.find((r) => r.nome === n);
    const STAFF = roleBy('Staff');
    const POL = roleBy('Polizia di Stato');
    const SOC = roleBy('118 / Soccorso');
    const CIV = roleBy('Civile');
    ok(STAFF && STAFF.permessi.utenti && STAFF.permessi.canali && POL && !POL.permessi.utenti, 'ruoli iniziali creati (Staff con permessi, reparti senza)');

    // ---------------------------------------------------- ruoli personalizzati (solo Founder)
    await req(F, 'role_save', { nome: 'Comandante', icona: '🎖️', colore: '#ff8800', permessi: { tuttiCanali: true } });
    st = await req(F, 'state');
    const COM = roleBy('Comandante');
    ok(COM && COM.permessi.tuttiCanali && !COM.permessi.utenti, 'il Founder crea il ruolo personalizzato "Comandante"');

    // ---------------------------------------------------- utenti creati dal Founder
    await req(F, 'user_create', { username: 'staff1', password: 'staffpass', nome: 'Anna Neri', ruolo: STAFF.id });
    await req(F, 'user_create', { username: 'staff2', password: 'staffpass', nome: 'Paolo Blu', ruolo: STAFF.id });
    await req(F, 'user_create', { username: 'mario', password: 'mariopass', nome: 'Mario Rossi', sigla: 'Volante 12', ruolo: POL.id });
    await req(F, 'user_create', { username: 'luca', password: 'lucapass', nome: 'Luca Bianchi', ruolo: SOC.id });
    ok((await reqFails(F, 'user_create', { username: 'mario', password: 'xxxxxx', nome: 'Doppio', ruolo: CIV.id })) !== null, 'non si possono creare due utenti con lo stesso nome');

    const bad = await radio('Intruso');
    all.push(bad);
    send(bad, { t: 'login', username: 'mario', password: 'sbagliata' });
    ok((await waitFor(bad, 'auth_fail')).code === 'credenziali', 'password sbagliata: accesso negato');

    const M = await login('Mario', 'mario', 'mariopass');
    const L = await login('Luca', 'luca', 'lucapass');
    const S = await login('Staff1', 'staff1', 'staffpass');
    all.push(M, L, S);
    ok(!M.welcome.perms.utenti && !M.welcome.perms.founder, 'Mario entra con il suo account (senza permessi)');
    ok(!M.welcome.channels.some((c) => c.id === 'staff') && S.welcome.channels.some((c) => c.id === 'staff'), 'il canale Staff è visibile solo allo Staff');
    ok(!!(await reqFails(M, 'state')), 'un utente normale non può aprire il pannello');

    // ---------------------------------------------------- permessi dello Staff
    await req(S, 'user_create', { username: 'giulia', password: 'giuliapass', nome: 'Giulia Verdi', ruolo: CIV.id });
    ok(true, 'lo Staff crea un utente normale');
    ok(/assegnare/.test(await reqFails(S, 'user_create', { username: 'furbo', password: 'xxxxxx', nome: 'Furbo', ruolo: STAFF.id })), 'lo Staff NON può creare altri Staff');
    ok(/assegnare/.test(await reqFails(S, 'user_create', { username: 'furbo2', password: 'xxxxxx', nome: 'Furbo', ruolo: COM.id })), 'lo Staff NON può dare ruoli con permessi speciali');
    st = await req(F, 'state');
    const staff2 = st.users.find((u) => u.username === 'staff2');
    const mario = st.users.find((u) => u.username === 'mario');
    ok(!!(await reqFails(S, 'user_update', { id: staff2.id, attivo: false })), 'lo Staff NON può modificare un altro membro dello Staff');
    ok(/Founder/.test(await reqFails(S, 'role_save', { nome: 'Hacker', permessi: { utenti: true } })), 'solo il Founder può creare ruoli');
    await req(S, 'user_update', { id: mario.id, sigla: 'Volante 7' });
    ok((await waitFor(M, 'session', (m) => m.me.sigla === 'Volante 7')).me.sigla === 'Volante 7', 'lo Staff modifica un utente e la modifica arriva subito');

    // ---------------------------------------------------- canali e password Staff
    const sch = (await req(S, 'state')).channels.find((c) => c.id === 'staff');
    await req(S, 'channel_save', { ...sch, password: 'nuova-pass' });
    ok((await req(F, 'state')).channels.find((c) => c.id === 'staff').password === 'nuova-pass', 'lo Staff cambia la password del canale Staff');
    await joinCh(S, 'staff');
    ok(true, 'lo Staff entra nel canale protetto senza password (accesso a tutti i canali)');
    send(M, { t: 'join', channel: 'staff', password: 'nuova-pass' });
    ok((await waitFor(M, 'error')).code === 'no_channel', 'un utente normale non entra nel canale Staff nemmeno con la password');
    M.msgs = [];
    L.msgs = [];
    await req(F, 'channel_save', { nome: 'Pattuglia Notte', icona: '🌙', password: 'notte', ruoli: [POL.id] });
    const pn = (await req(F, 'state')).channels.find((c) => c.nome === 'Pattuglia Notte');
    const mSees = (await waitFor(M, 'session')).channels.some((c) => c.id === pn.id);
    const lSees = (await waitFor(L, 'session')).channels.some((c) => c.id === pn.id);
    ok(pn && mSees && !lSees, 'nuovo canale solo per Polizia: lo vede Mario, non Luca');

    // ---------------------------------------------------- diretta
    await joinCh(M, 'generale');
    await joinCh(L, 'generale');
    send(M, { t: 'ptt_start' });
    await waitFor(M, 'ptt_ok');
    const ts = await waitFor(L, 'talk_start');
    ok(ts.user.nome === 'Mario Rossi' && ts.user.ruolo === POL.id, 'Luca vede che Mario sta parlando');
    send(L, { t: 'ptt_start' });
    ok((await waitFor(L, 'ptt_busy')).by.nome === 'Mario Rossi', 'Luca non può parlare sopra Mario (canale occupato)');
    const audio = tone(1000, 440);
    L.bins = [];
    L.binTimes = [];
    const t0 = Date.now();
    for (let i = 0; i < audio.length; i += 1280) {
      M.ws.send(audio.subarray(i, i + 1280));
      await sleep(40);
    }
    const tStop = Date.now();
    send(M, { t: 'ptt_stop' });
    const eb = await waitFor(L, 'talk_end', (m) => m.user.nome === 'Mario Rossi');
    const got = Buffer.concat(L.bins);
    const during = L.binTimes.filter((x) => x < tStop).length;
    ok(got.equals(audio), `Luca riceve l'audio di Mario intatto (${got.length} byte)`);
    ok(during >= L.bins.length - 2 && L.binTimes[0] - t0 < 200, `IN DIRETTA: ${during}/${L.bins.length} pacchetti arrivati mentre Mario parlava (primo dopo ${L.binTimes[0] - t0} ms)`);
    ok(M.bins.length === 0, 'Mario non riceve il proprio audio (niente eco)');
    ok(eb.msg && Math.abs(eb.msg.durata - 1) < 0.05, `vocale salvato in cronologia (${eb.msg.durata}s)`);
    const wavUrl = `http://127.0.0.1:${PORT}/api/msg/generale/${eb.msg.id}.wav`;
    const wav = await fetch(`${wavUrl}?k=${L.welcome.key}`);
    ok(wav.ok && Buffer.from(await wav.arrayBuffer()).length === 44 + audio.length, 'riascolto del vocale (file WAV corretto)');
    ok((await fetch(`${wavUrl}?k=sbagliata`)).status === 403, 'riascolto negato senza chiave valida');

    // ---------------------------------------------------- tasto PC (anche in gioco)
    const { token: pttTok } = await req(M, 'ptt_token');
    const K = await radio('TastoPC');
    all.push(K);
    send(K, { t: 'remote_auth', token: pttTok });
    const kok = await waitFor(K, 'remote_ok');
    ok(kok.sessioni === 1, 'il tasto PC di Mario si collega e trova la sua radio nel browser');
    ok((await waitFor(M, 'pc_key')).n === 1, 'la radio nel browser vede il tasto PC collegato');
    send(K, { t: 'remote_ptt', down: true });
    ok((await waitFor(M, 'remote_ptt')).down === true, 'tasto PC premuto → la radio di Mario riceve il comando');
    send(M, { t: 'ptt_start' });
    await waitFor(M, 'ptt_ok');
    const kon = await waitFor(K, 'remote_state', (m) => m.state === 'on');
    ok(kon.canale === 'Generale' && kon.ascoltatori === 1, 'il tasto PC mostra "IN ONDA" e quante persone ascoltano');
    send(K, { t: 'remote_ptt', down: false });
    ok((await waitFor(M, 'remote_ptt')).down === false, 'tasto PC rilasciato → la radio chiude la trasmissione');
    send(K, { t: 'remote_ptt', down: true, centrale: true });
    ok((await waitFor(M, 'remote_ptt')).centrale === true, 'secondo tasto PC: chiama la Centrale');
    send(K, { t: 'remote_ptt', down: false, centrale: true });
    await waitFor(M, 'remote_ptt', (m) => !m.down);
    send(M, { t: 'ptt_stop' });
    await waitFor(K, 'remote_state', (m) => m.state === 'idle');
    send(K, { t: 'remote_ptt', down: true });
    await waitFor(M, 'remote_ptt', (m) => m.down);
    K.ws.terminate();
    ok((await waitFor(M, 'remote_ptt', (m) => !m.down)).down === false, 'se il tasto PC si scollega mentre è premuto, la trasmissione si chiude');
    const K2 = await radio('TastoFalso');
    all.push(K2);
    send(K2, { t: 'remote_auth', token: 'x'.repeat(48) });
    ok(!!(await waitFor(K2, 'remote_error')), 'un tasto PC con codice falso viene rifiutato');

    // ---------------------------------------------------- SOS
    const G = await login('Giulia', 'giulia', 'giuliapass');
    all.push(G);
    await joinCh(G, 'centrale');
    const P = await login('Staff2', 'staff2', 'staffpass');
    all.push(P);
    await joinCh(P, 'polizia');
    send(L, { t: 'alert', text: 'Piazza Libertà, ferito grave' });
    const am = await waitFor(M, 'alert');
    ok(am.msg.testo === 'Piazza Libertà, ferito grave' && am.msg.from.nome === 'Luca Bianchi', 'SOS con posizione arriva a chi è nel canale');
    const ag = await waitFor(G, 'alert');
    ok(ag.msg.canale.id === 'generale', 'SOS arriva anche alla Centrale Operativa (da un altro canale)');
    ok(await noMsg(P, 'alert'), 'SOS NON arriva ai canali non coinvolti');
    send(G, { t: 'sos_ack', id: ag.msg.id });
    ok((await waitFor(L, 'sos_ack')).by.nome === 'Giulia Verdi', 'chi ha mandato l\'SOS vede "Giulia ha risposto"');
    send(L, { t: 'alert' });
    ok((await waitFor(L, 'error')).code === 'rate', 'anti-spam SOS attivo');

    // ---------------------------------------------------- CENTRALE: più canali insieme, ascolto, comunicati
    st = await req(F, 'state');
    const OPC = roleBy('Operatore Centrale');
    ok(OPC && OPC.permessi.diramazione && !OPC.permessi.utenti, 'esiste il ruolo "Operatore Centrale" con il permesso Centrale');
    ok(/assegnare/.test(await reqFails(S, 'user_create', { username: 'furbo3', password: 'xxxxxx', nome: 'Furbo', ruolo: OPC.id })), 'solo il Founder può dare il permesso Centrale');
    await req(F, 'user_create', { username: 'centrale1', password: 'centralepass', nome: 'Sara Gialli', sigla: 'Centrale 2', ruolo: OPC.id });
    await req(F, 'user_create', { username: 'carlo', password: 'carlopass', nome: 'Carlo Viola', ruolo: CIV.id });
    const D = await login('Centrale', 'centrale1', 'centralepass', { proto: 3 });
    const C = await login('Carlo', 'carlo', 'carlopass');
    all.push(D, C);
    ok(D.welcome.perms.diramazione && !M.welcome.perms.diramazione, "l'operatore ha il permesso Centrale, gli utenti normali no");
    await joinCh(D, 'centrale');
    await joinCh(L, '118');
    await joinCh(C, 'carabinieri');
    for (const r of [M, L, G, P, C, D]) {
      r.msgs = [];
      r.bins = [];
    }

    // ascolto: la Centrale sente anche Polizia e 118 senza entrarci
    send(L, { t: 'monitor', canali: ['polizia'] }); // utente normale: ignorato
    send(D, { t: 'monitor', canali: ['polizia', '118'] });
    await sleep(100);
    send(P, { t: 'ptt_start' });
    await waitFor(P, 'ptt_ok');
    const dts = await waitFor(D, 'talk_start', (m) => m.user.nome === 'Paolo Blu');
    ok(dts.via && dts.via.id === 'polizia', 'la Centrale sente in diretta chi parla in Polizia (senza entrare nel canale)');
    const pAudio = tone(400, 500);
    for (let i = 0; i < pAudio.length; i += 1280) P.ws.send(pAudio.subarray(i, i + 1280));
    send(P, { t: 'ptt_stop' });
    const dte = await waitFor(D, 'talk_end', (m) => m.user.nome === 'Paolo Blu');
    const dPcm = Buffer.concat(D.bins.filter((b) => b.readUInt16LE(0) === dts.n).map((b) => b.subarray(2)));
    ok(dPcm.equals(pAudio), 'la voce della Polizia arriva intatta alla Centrale');
    ok((await fetch(`http://127.0.0.1:${PORT}/api/msg/polizia/${dte.msg.id}.wav?k=${D.welcome.key}`)).ok, 'la Centrale può riascoltare i vocali dei canali che ascolta');
    ok(L.bins.length === 0 && (await noMsg(L, 'talk_start', 200)), 'un utente normale NON può ascoltare altri canali');

    // parlare a più canali insieme
    for (const r of [M, L, G, P, C]) {
      r.msgs = [];
      r.bins = [];
    }
    send(D, { t: 'ptt_start', diramazione: true, canali: ['polizia', '118'] });
    const dok = await waitFor(D, 'ptt_ok');
    ok(dok.canali === 3 && dok.ascoltatori === 3, `la Centrale parla a 3 canali insieme (${dok.ascoltatori} persone in ascolto)`);
    const [tsP, tsL, tsG] = await Promise.all([waitFor(P, 'talk_start'), waitFor(L, 'talk_start'), waitFor(G, 'talk_start')]);
    ok(tsP.prio && tsP.canali === 3 && tsL.prio && tsG.prio, 'Polizia, 118 e Centrale ricevono la diramazione');
    ok(tsP.user.nome === 'Centrale Operativa 112' && tsP.user.uid === 'centrale' && !JSON.stringify(tsP).includes('Sara'), 'chi riceve vede "Centrale Operativa 112", NON il nome della persona');
    const dAudio = tone(500, 700);
    for (let i = 0; i < dAudio.length; i += 1280) D.ws.send(dAudio.subarray(i, i + 1280));
    send(D, { t: 'ptt_stop' });
    const [teP] = await Promise.all([
      waitFor(P, 'talk_end', (m) => m.user.uid === 'centrale'),
      waitFor(L, 'talk_end', (m) => m.user.uid === 'centrale'),
    ]);
    ok(Buffer.concat(P.bins).equals(dAudio) && Buffer.concat(L.bins).equals(dAudio), 'Polizia e 118 sentono la Centrale in diretta, audio intatto');
    ok((await noMsg(C, 'talk_start', 200)) && C.bins.length === 0 && M.bins.length === 0, 'i canali non scelti (Carabinieri, Generale) non sentono niente');
    const wavP = await fetch(`http://127.0.0.1:${PORT}/api/msg/polizia/${teP.msg.id}.wav?k=${P.welcome.key}`);
    ok(teP.msg.canali === 3 && wavP.ok, 'il messaggio della Centrale resta nella cronologia di ogni canale');

    // priorità: la Centrale interrompe chi sta parlando
    send(M, { t: 'ptt_start' });
    await waitFor(M, 'ptt_ok');
    send(D, { t: 'ptt_start', diramazione: true, canali: ['generale'] });
    const cut = await waitFor(M, 'ptt_cut');
    ok(cut.by.nome === 'Centrale Operativa 112' && (await waitFor(D, 'ptt_ok')).canali === 2, 'PRIORITÀ: la Centrale interrompe chi sta parlando e prende la linea');
    send(M, { t: 'ptt_start' });
    const busy = await waitFor(M, 'ptt_busy');
    ok(busy.prio && busy.by.nome === 'Centrale Operativa 112', 'mentre parla la Centrale nessuno può interromperla');
    send(D, { t: 'ptt_stop' });
    await waitFor(M, 'talk_end', (m) => m.user.uid === 'centrale');
    P.msgs = [];
    send(M, { t: 'ptt_start', diramazione: true, canali: ['polizia'] });
    ok((await waitFor(M, 'ptt_ok')).canali === 1 && (await noMsg(P, 'talk_start', 300)), 'un utente normale NON può parlare su più canali');
    send(M, { t: 'ptt_stop' });

    // messaggi scritti e comunicati
    send(D, { t: 'text', text: 'Tutte le unità: posto di blocco in via Roma', diramazione: true, canali: ['polizia', '118'] });
    const [txP, txL] = await Promise.all([waitFor(P, 'text'), waitFor(L, 'text')]);
    ok(txP.msg.testo === txL.msg.testo && txP.msg.canali === 3 && txP.msg.from.nome === 'Centrale Operativa 112', 'la Centrale scrive a più canali insieme (firmato "Centrale")');
    send(M, { t: 'annuncio', livello: 'info', text: 'ciao', canali: ['polizia'] });
    ok((await waitFor(M, 'error')).code === 'perm', 'un utente normale NON può mandare comunicati');
    G.msgs = [];
    send(D, { t: 'annuncio', livello: 'emergenza', text: 'Rapina in corso alla banca', luogo: 'Piazza Libertà', canali: ['polizia', '118'] });
    const [anP, anL, anD] = await Promise.all([waitFor(P, 'annuncio'), waitFor(L, 'annuncio'), waitFor(D, 'annuncio')]);
    ok(anP.msg.livello === 'emergenza' && anP.msg.luogo === 'Piazza Libertà' && anL.msg.testo === 'Rapina in corso alla banca', 'COMUNICATO di emergenza con luogo arriva ai canali scelti');
    ok(anD.mio && anD.persone === 2 && (await noMsg(G, 'annuncio', 300)) && (await noMsg(C, 'annuncio', 50)), 'chi lo manda sa a quante persone è arrivato; gli altri canali non lo ricevono');
    ok(anP.msg.from.nome === 'Centrale Operativa 112' && !JSON.stringify(anP).includes('Sara'), 'il comunicato compare come "Centrale Operativa 112", senza il nome di chi lo manda');
    send(P, { t: 'annuncio_ack', id: anP.msg.id });
    const ack = await waitFor(D, 'annuncio_ack');
    ok(ack.by.nome === 'Paolo Blu' && ack.mio, 'la Centrale vede chi ha risposto "Ricevuto"');

    // i canali creati dopo compaiono subito e si possono usare
    await req(F, 'channel_save', { nome: 'Rapina Banca', icona: '🏦' });
    const rbs = await waitFor(D, 'session', (m) => m.channels.some((c) => c.nome === 'Rapina Banca'));
    const rb = rbs.channels.find((c) => c.nome === 'Rapina Banca');
    ok(!!rb, 'un canale appena creato compare subito alla Centrale');
    await joinCh(C, rb.id);
    send(D, { t: 'ptt_start', diramazione: true, canali: [rb.id, 'polizia'] });
    await waitFor(D, 'ptt_ok');
    ok((await waitFor(C, 'talk_start')).prio, 'la Centrale parla anche nel canale appena creato');
    send(D, { t: 'ptt_stop' });
    await sleep(1600); // anti-spam dei comunicati
    send(D, { t: 'annuncio', livello: 'allerta', text: 'Allerta meteo: grandine in arrivo', tutti: true });
    const anC = await waitFor(C, 'annuncio');
    ok(anC.msg.tutti && anC.msg.livello === 'allerta' && !!(await waitFor(M, 'annuncio')), 'comunicato a TUTTI i canali: arriva ovunque, anche nel canale nuovo');

    // ---------------------------------------------------- tutti i canali parlano con la Centrale
    ok(M.welcome.centrale && M.welcome.centrale.nome === 'Centrale Operativa 112', 'ogni radio sa qual è la Centrale');
    for (const r of [M, L, G, P, C, D, F]) {
      r.msgs = [];
      r.bins = [];
    }
    send(F, { t: 'join', channel: 'generale' });
    await waitFor(F, 'joined');
    send(F, { t: 'monitor', canali: [], attivo: true }); // il Founder è "in servizio" come Centrale da un altro canale
    await sleep(100);
    send(P, { t: 'ptt_start', centrale: true });
    const cok = await waitFor(P, 'ptt_ok');
    const [cG, cD, cF] = await Promise.all([waitFor(G, 'talk_start'), waitFor(D, 'talk_start'), waitFor(F, 'talk_start')]);
    ok(cok.chiamata && cG.chiamata.id === 'polizia' && cD.user.nome === 'Paolo Blu', 'dalla Polizia si chiama la Centrale senza cambiare canale');
    ok(cF.chiamata && cok.ascoltatori === 3, `la chiamata arriva anche a chi è in servizio come Centrale da un altro canale (${cok.ascoltatori} persone)`);
    const cAudio = tone(400, 600);
    for (let i = 0; i < cAudio.length; i += 1280) P.ws.send(cAudio.subarray(i, i + 1280));
    send(M, { t: 'ptt_start', centrale: true });
    const cbusy = await waitFor(M, 'ptt_busy');
    ok(cbusy.centrale && cbusy.by.nome === 'Paolo Blu', "se la Centrale è già occupata da un'altra chiamata: «Centrale occupata»");
    send(P, { t: 'ptt_stop' });
    const cEnd = await waitFor(G, 'talk_end', (m) => m.user.nome === 'Paolo Blu');
    const pEnd = await waitFor(P, 'talk_end', (m) => m.user.nome === 'Paolo Blu');
    ok(Buffer.concat(G.bins).equals(cAudio) && (await noMsg(C, 'talk_start', 100)) && M.bins.length === 0, 'la Centrale sente la chiamata; gli altri canali no');
    const myCall = await fetch(`http://127.0.0.1:${PORT}/api/msg/${pEnd.msg.centrale.id}/${pEnd.msg.id}.wav?k=${P.welcome.key}`);
    ok(cEnd.msg.chiamata.id === 'polizia' && myCall.ok, 'la chiamata resta registrata in Centrale e chi ha chiamato può riascoltarla');
    send(C, { t: 'ptt_start', centrale: true });
    await waitFor(C, 'ptt_ok');
    ok((await waitFor(G, 'talk_start', (m) => m.chiamata)).chiamata.id === rb.id, 'anche dal canale appena creato si chiama la Centrale');
    send(C, { t: 'ptt_stop' });
    await waitFor(G, 'talk_end', (m) => m.user.nome === 'Carlo Viola');

    // richiesta scritta
    send(C, { t: 'richiesta', text: "Serve un'ambulanza", luogo: 'Banca di Piazza Libertà' });
    const [rG, rF, rC] = await Promise.all([waitFor(G, 'richiesta'), waitFor(F, 'richiesta'), waitFor(C, 'richiesta')]);
    ok(rG.msg.testo === "Serve un'ambulanza" && rG.msg.canale.id === rb.id && !!rF && rC.mio && rC.persone === 3, 'RICHIESTA scritta alla Centrale (es. ambulanza) con il luogo');
    ok(await noMsg(M, 'richiesta', 200), 'le richieste arrivano solo alla Centrale');
    send(M, { t: 'richiesta_ack', id: rG.msg.id });
    send(D, { t: 'richiesta_ack', id: rG.msg.id });
    const rAck = await waitFor(C, 'richiesta_ack');
    ok(rAck.mio && rAck.by.nome === 'Centrale Operativa 112' && (await waitFor(G, 'richiesta_ack')).by.nome === 'Sara Gialli', "la Centrale prende in carico: chi ha chiesto vede «Centrale», in Centrale si vede l'operatore");
    send(F, { t: 'monitor', canali: [], attivo: false });

    // ---------------------------------------------------- canale eco (prova audio da soli)
    await joinCh(M, 'prova-audio');
    M.bins = [];
    send(M, { t: 'ptt_start' });
    await waitFor(M, 'ptt_ok');
    const ecoAudio = tone(600, 300);
    for (let i = 0; i < ecoAudio.length; i += 1280) M.ws.send(ecoAudio.subarray(i, i + 1280));
    send(M, { t: 'ptt_stop' });
    const es = await waitFor(M, 'talk_start', (m) => m.eco, 3000);
    await waitFor(M, 'talk_end', (m) => m.reason === 'eco', 4000);
    ok(es.user.ruolo === 'eco' && Buffer.concat(M.bins).equals(ecoAudio), 'canale eco: parli da solo e ti risenti subito dopo, in diretta');

    // ---------------------------------------------------- sessione salvata e cambio password
    const M2 = await radio('Mario-telefono');
    all.push(M2);
    send(M2, { t: 'auth', token: M.welcome.token });
    ok((await waitFor(M2, 'welcome')).me.username === 'mario', 'si rientra senza password grazie alla sessione salvata');
    await req(F, 'user_password', { id: mario.id, password: 'nuovapass' });
    await waitFor(M, 'kicked');
    await waitFor(M2, 'kicked');
    ok(true, 'cambio password dal pannello: Mario viene disconnesso da tutti i dispositivi');
    const M3 = await radio('Mario-vecchio');
    all.push(M3);
    send(M3, { t: 'auth', token: M.welcome.token });
    ok((await waitFor(M3, 'auth_fail')).code === 'token', 'la vecchia sessione non vale più');
    const M4 = await login('Mario-nuovo', 'mario', 'nuovapass');
    all.push(M4);
    await req(M4, 'my_password', { old: 'nuovapass', password: 'scelta-da-me' });
    ok(true, 'l\'utente cambia da solo la sua password');

    // ---------------------------------------------------- disattivazione e canali eliminati
    const luca = (await req(F, 'state')).users.find((u) => u.username === 'luca');
    await req(S, 'user_update', { id: luca.id, attivo: false });
    ok(/disattivato/.test((await waitFor(L, 'kicked')).msg), 'utente disattivato: viene buttato fuori subito');
    const L2 = await radio('Luca-di-nuovo');
    all.push(L2);
    send(L2, { t: 'login', username: 'luca', password: 'lucapass' });
    ok((await waitFor(L2, 'auth_fail')).code === 'disattivato', 'utente disattivato: non può più entrare');
    await joinCh(G, 'meccanici');
    await req(F, 'channel_delete', { id: 'meccanici' });
    ok(!!(await waitFor(G, 'channel_gone')), 'canale eliminato: chi era dentro viene avvisato e spostato');
    ok(/usato/.test(await reqFails(F, 'role_delete', { id: POL.id })), 'non si può eliminare un ruolo ancora usato');

    // ---------------------------------------------------- riavvio: i dati restano
    for (const c of all) c.ws.terminate();
    await sleep(1500); // lascia finire il salvataggio automatico
    await stopServer();
    info = await startServer();
    ok(info.setup === false, 'dopo il riavvio la radio NON chiede di nuovo il Founder');
    const F2 = await login('Founder-dopo', 'boss', 'segreta1');
    all.push(F2);
    st = await req(F2, 'state');
    ok(st.users.length === 8 && st.roles.some((r) => r.nome === 'Comandante') && !st.channels.some((c) => c.id === 'meccanici'), 'dopo il riavvio utenti, ruoli e canali sono ancora lì');
    const M5 = await login('Mario-dopo', 'mario', 'scelta-da-me');
    all.push(M5);
    ok(M5.welcome.me.sigla === 'Volante 7', 'Mario entra con la password che si era scelto');

    // ---------------------------------------------------- aggiornamento di dati vecchi (v2)
    for (const c of all) c.ws.terminate();
    await sleep(300);
    await stopServer();
    const old = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    old.version = 2;
    old.roles = old.roles.filter((r) => r.nome !== 'Operatore Centrale');
    for (const r of old.roles) delete r.permessi.diramazione;
    old.users = old.users.filter((u) => u.username !== 'centrale1');
    fs.writeFileSync(DATA_FILE, JSON.stringify(old));
    await startServer();
    const F3 = await login('Founder-v2', 'boss', 'segreta1');
    all.push(F3);
    st = await req(F3, 'state');
    const upg = st.roles.find((r) => r.nome === 'Operatore Centrale');
    ok(upg && upg.permessi.diramazione && F3.welcome.perms.diramazione, 'dati della versione precedente: compare il ruolo "Operatore Centrale" e il Founder ha il permesso');

    for (const c of all) c.ws.terminate();
    console.log(`\n🎉 Tutti i ${passed} controlli superati: la radio funziona!\n`);
  } catch (e) {
    console.error('\n❌ ' + e.message);
    console.error('\n--- output del server ---\n' + srvOut);
    process.exitCode = 1;
  } finally {
    for (const c of all) {
      try {
        c.ws.terminate();
      } catch (e) {}
    }
    await stopServer();
    for (const f of [DATA_FILE, DATA_FILE + '.bak', DATA_FILE + '.tmp']) {
      try {
        fs.unlinkSync(f);
      } catch (e) {}
    }
  }
}

main();
