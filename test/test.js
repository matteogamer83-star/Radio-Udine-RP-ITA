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
    ok(st.users.length === 6 && st.roles.some((r) => r.nome === 'Comandante') && !st.channels.some((c) => c.id === 'meccanici'), 'dopo il riavvio utenti, ruoli e canali sono ancora lì');
    const M5 = await login('Mario-dopo', 'mario', 'scelta-da-me');
    all.push(M5);
    ok(M5.welcome.me.sigla === 'Volante 7', 'Mario entra con la password che si era scelto');

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
