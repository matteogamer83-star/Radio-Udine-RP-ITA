/*
 * Radio Udine RP — Pannello Founder / Staff
 * - Utenti: creare account, cambiare password, disattivare, eliminare
 * - Canali: aggiungere/togliere radio, password, chi può entrare, Centrale SOS, eco
 * - Ruoli (solo Founder): ruoli personalizzati e i loro permessi
 * - Server (solo Founder): nome, durata trasmissioni, archivio dati, backup
 */
'use strict';
(function () {
  const R = window.RadioApp;
  if (!R) return;
  const { el, toast, modal } = R;
  const panel = document.getElementById('adminPanel');

  let data = null;
  let tab = null;
  let isOpen = false;
  let loading = false;
  let filter = '';

  const perms = () => R.state.perms || {};
  const CH_ICONS = ['📻', '🚨', '🚓', '🚔', '🛡️', '🚦', '🚑', '🚒', '🔧', '⭐', '🔁', '🏥', '🚁', '🕵️', '💼', '🏛️', '⚖️', '🎖️', '🚛', '🚕', '🏪', '🔒', '📡', '🎮'];
  const ROLE_ICONS = ['👤', '⭐', '🎖️', '👮', '🚓', '🚔', '🛡️', '🚦', '🚑', '🚒', '🔧', '🕵️', '💼', '⚖️', '🏛️', '🚕', '🎩', '🪖', '🧑‍⚕️', '🧑‍🚒'];

  // ---------------------------------------------------------------- piccoli aiuti
  function input(value, placeholder, type) {
    const i = el('input', 'input');
    i.type = type || 'text';
    i.value = value == null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.autocomplete = 'off';
    return i;
  }
  function field(label, control, hint) {
    const f = el('label', 'fld');
    f.append(el('span', 'fld-label', label), control);
    if (hint) f.append(el('small', 'fld-hint', hint));
    return f;
  }
  function checkbox(label, checked, hint) {
    const w = el('label', 'chk');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    const t = el('span');
    t.append(el('b', null, label));
    if (hint) t.append(el('small', null, hint));
    w.append(cb, t);
    w.cb = cb;
    return w;
  }
  function iconPicker(inp, icons) {
    const row = el('div', 'emoji-row');
    for (const ic of icons) {
      const b = el('button', 'emoji', ic);
      b.type = 'button';
      b.onclick = () => {
        inp.value = ic;
      };
      row.append(b);
    }
    return row;
  }
  function btn(label, cls, onClick, title) {
    const b = el('button', 'btn btn-sm ' + (cls || ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.onclick = onClick;
    return b;
  }
  function badge(text, cls) {
    return el('span', 'badge ' + (cls || ''), text);
  }
  function genPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const a = new Uint32Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => chars[x % chars.length]).join('');
  }
  function ago(ts) {
    if (!ts) return 'mai entrato';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'oggi ' + R.fmtTime(ts);
    const days = Math.max(1, Math.round((today - d) / 86400000));
    return days === 1 ? 'ieri' : `${days} giorni fa`;
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = el('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {}
      ta.remove();
      return ok;
    }
  }
  function confirmBox(title, text, okLabel, okCls, fn) {
    modal.open({
      title,
      body: text,
      actions: [{ label: 'Annulla' }, { label: okLabel, cls: okCls || 'btn-danger', primary: true, onClick: fn }],
    });
  }
  const later = (fn) => setTimeout(fn, 60);

  // ---------------------------------------------------------------- struttura
  function tabs() {
    const p = perms();
    const t = [];
    if (p.utenti) t.push(['utenti', '👥 Utenti']);
    if (p.canali) t.push(['canali', '📻 Canali']);
    if (p.founder) t.push(['ruoli', '🎖️ Ruoli']);
    if (p.founder) t.push(['server', '🖥️ Server']);
    return t;
  }

  async function load() {
    loading = true;
    try {
      data = await R.request('state');
    } catch (e) {
      toast('❌ ' + e.message, 5000);
    }
    loading = false;
    render();
  }

  function show() {
    const t = tabs();
    if (!t.length) return toast('Non hai accesso al pannello');
    if (!tab || !t.some((x) => x[0] === tab)) tab = t[0][0];
    isOpen = true;
    panel.hidden = false;
    render();
    load();
  }
  function hide() {
    isOpen = false;
    panel.hidden = true;
  }

  R.onAdminDirty = () => {
    if (isOpen) load();
  };
  R.onSession = () => {
    if (!isOpen) return;
    const t = tabs();
    if (!t.length) return hide();
    if (!t.some((x) => x[0] === tab)) tab = t[0][0];
    render();
  };
  R.admin = { show, hide, isOpen: () => isOpen };

  function render() {
    if (!isOpen) return;
    const oldBody = panel.querySelector('.adm-body');
    const scroll = oldBody ? oldBody.scrollTop : 0;
    const focusedSearch = document.activeElement && document.activeElement.classList.contains('adm-search');
    panel.textContent = '';

    const head = el('div', 'adm-head');
    const title = el('div', 'adm-title');
    title.append(el('b', null, '🛡️ Pannello ' + (perms().founder ? 'Founder' : 'Staff')), el('small', null, R.state.serverName || ''));
    const close = el('button', 'icon-btn', '✕');
    close.type = 'button';
    close.title = 'Chiudi pannello';
    close.onclick = hide;
    head.append(title, close);

    const bar = el('div', 'adm-tabs');
    for (const [id, label] of tabs()) {
      const b = el('button', 'adm-tab' + (id === tab ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = () => {
        tab = id;
        filter = '';
        render();
      };
      bar.append(b);
    }

    const body = el('div', 'adm-body');
    const inner = el('div', 'adm-inner');
    body.append(inner);
    panel.append(head, bar, body);

    if (!data) {
      inner.append(el('p', 'muted', loading ? 'Caricamento…' : 'Impossibile caricare i dati.'));
      return;
    }
    if (data.storage && (data.storage.temporaneo || data.storage.errore)) inner.append(storageWarning(data.storage));
    ({ utenti: renderUsers, canali: renderChannels, ruoli: renderRoles, server: renderServer }[tab] || renderUsers)(inner);
    body.scrollTop = scroll;
    if (focusedSearch) {
      const s = panel.querySelector('.adm-search');
      if (s) {
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }
    }
  }

  function storageWarning(s) {
    const box = el('div', 'adm-warn');
    if (s.temporaneo) {
      box.append(
        el('b', null, '⚠️ ATTENZIONE: i dati sono su un archivio TEMPORANEO.'),
        el('p', null, 'Al prossimo riavvio del server (Render lo fa spesso) utenti, ruoli e canali verranno CANCELLATI. Imposta subito la variabile GITHUB_TOKEN su Render: trovi i passaggi nella scheda 🖥️ Server.')
      );
    }
    if (s.errore) box.append(el('p', null, '❌ Ultimo salvataggio non riuscito: ' + s.errore));
    return box;
  }

  // ---------------------------------------------------------------- UTENTI
  function renderUsers(root) {
    const bar = el('div', 'adm-bar');
    const search = input(filter, '🔎 Cerca per nome, utente o ruolo…');
    search.classList.add('adm-search');
    const list = el('div', 'adm-list');
    search.oninput = () => {
      filter = search.value;
      fill();
    };
    bar.append(search, btn('➕ Nuovo utente', 'btn-primary', () => userForm(null)));
    root.append(
      bar,
      el(
        'p',
        'muted small',
        perms().founder
          ? '👑 Come Founder puoi gestire tutti, anche lo Staff. Solo chi ha un account può entrare nella radio.'
          : 'Puoi gestire gli utenti con ruoli normali. Chi ha permessi di Staff lo gestisce solo il Founder.'
      ),
      list
    );

    function fill() {
      list.textContent = '';
      const q = filter.trim().toLowerCase();
      const users = data.users
        .filter((u) => !q || [u.username, u.nome, u.sigla, R.roleInfo(u.ruolo).nome].join(' ').toLowerCase().includes(q))
        .sort((a, b) => b.founder - a.founder || b.online - a.online || a.nome.localeCompare(b.nome, 'it'));
      if (!users.length) list.append(el('p', 'muted', q ? 'Nessun utente trovato.' : 'Nessun utente: creane uno con «➕ Nuovo utente».'));
      for (const u of users) list.append(userRow(u));
      list.append(el('p', 'muted small', `${data.users.length} account in totale · ${data.users.filter((u) => u.online).length} online adesso`));
    }
    fill();
  }

  function userRow(u) {
    const r = R.roleInfo(u.ruolo);
    const row = el('div', 'adm-row' + (u.attivo ? '' : ' off'));
    const dot = el('i', 'dot');
    dot.style.background = r.colore;
    const main = el('div', 'adm-main');
    main.append(el('b', null, R.displayName(u) + (u.id === data.me ? ' (tu)' : '')), el('small', null, `@${u.username} · ${r.icona} ${r.nome}`));
    const st = !u.attivo ? badge('🚫 disattivato', 'red') : u.online ? badge('🟢 online', 'green') : badge(ago(u.ultimoAccesso));
    main.append(st);
    const actions = el('div', 'adm-actions');
    if (u.gestibile) actions.append(btn('✏️', '', () => userForm(u), 'Modifica'));
    if (u.gestibile === true) actions.append(btn('🔑', '', () => resetPassword(u), 'Nuova password'));
    if (u.gestibile === true && !u.founder && u.id !== data.me) {
      actions.append(btn(u.attivo ? '🚫' : '✅', '', () => toggleUser(u), u.attivo ? 'Disattiva' : 'Riattiva'));
      actions.append(btn('🗑️', 'danger', () => deleteUser(u), 'Elimina'));
    }
    row.append(dot, main, actions);
    return row;
  }

  function roleSelect(current, disabled) {
    const sel = el('select', 'input');
    const roles = data.roles.filter((r) => r.assegnabile || r.id === current);
    if (current === 'founder') {
      const o = el('option', null, '👑 Founder');
      o.value = 'founder';
      sel.append(o);
    }
    for (const r of roles) {
      const p = r.permessi || {};
      const extra = p.utenti || p.canali || p.tuttiCanali || p.diramazione ? ' (con permessi)' : '';
      const o = el('option', null, `${r.icona} ${r.nome}${extra}`);
      o.value = r.id;
      sel.append(o);
    }
    if (current) sel.value = current;
    sel.disabled = !!disabled;
    return sel;
  }

  function userForm(u) {
    const isNew = !u;
    const username = input(isNew ? '' : u.username, 'es. mario.rossi');
    username.autocapitalize = 'none';
    username.spellcheck = false;
    if (!isNew) username.disabled = true;
    const password = input(isNew ? genPassword() : '', 'almeno 6 caratteri');
    const nome = input(isNew ? '' : u.nome, 'es. Mario Rossi');
    nome.maxLength = 24;
    const sigla = input(isNew ? '' : u.sigla, 'es. Volante 12');
    sigla.maxLength = 16;
    const lockRole = !isNew && (u.founder || u.gestibile === 'self');
    const ruolo = roleSelect(isNew ? (data.roles.find((r) => r.assegnabile) || {}).id : u.ruolo, lockRole);

    const f = el('div', 'form-grid');
    f.append(field('Nome utente (per entrare)', username, isNew ? 'Minuscolo, senza spazi. Non si potrà cambiare.' : 'Non modificabile'));
    if (isNew) {
      const pw = el('div', 'inline');
      pw.append(password, btn('🎲', '', () => (password.value = genPassword()), 'Genera password'));
      f.append(field('Password', pw, 'Comunicala all\'utente: potrà cambiarla dalle Impostazioni.'));
    }
    f.append(field('Nome RP', nome), field('Sigla / nominativo (facoltativo)', sigla));
    f.append(field('Ruolo', ruolo, lockRole ? 'Non puoi cambiare il ruolo di questo account.' : perms().founder ? 'I ruoli "(con permessi)" danno poteri speciali (gestione, Centrale…).' : 'Puoi assegnare solo ruoli senza permessi speciali.'));
    if (!ruolo.options.length) f.append(el('p', 'adm-warn', 'Non ci sono ruoli assegnabili: chiedi al Founder di crearne uno.'));

    modal.open({
      title: isNew ? '➕ Nuovo utente' : '✏️ Modifica ' + R.displayName(u),
      body: f,
      actions: [
        { label: 'Annulla' },
        {
          label: isNew ? 'Crea utente' : 'Salva',
          cls: 'btn-primary',
          primary: true,
          onClick: async () => {
            if (isNew) {
              const un = username.value.trim().toLowerCase();
              await R.request('user_create', { username: un, password: password.value, nome: nome.value, sigla: sigla.value, ruolo: ruolo.value });
              later(() => showCredentials(un, password.value, nome.value.trim()));
            } else {
              const payload = { id: u.id, nome: nome.value, sigla: sigla.value };
              if (!ruolo.disabled) payload.ruolo = ruolo.value;
              await R.request('user_update', payload);
              toast('✅ Utente aggiornato');
            }
            load();
          },
        },
      ],
    });
    later(() => (isNew ? username : nome).focus());
  }

  function showCredentials(username, password, nome) {
    const text = `📻 Radio ${R.state.serverName || 'Udine RP'}\nLink: ${location.origin}\nUtente: ${username}\nPassword: ${password}`;
    const box = el('div');
    box.append(el('p', null, `Manda questi dati a ${nome || username} (in privato, es. su Discord):`), el('pre', 'cred', text));
    modal.open({
      title: '✅ Account pronto',
      body: box,
      actions: [
        {
          label: '📋 Copia',
          onClick: async () => {
            toast((await copy(text)) ? '📋 Copiato! Incollalo in un messaggio privato' : 'Copia non riuscita: selezionalo a mano');
            return false;
          },
        },
        { label: 'Fatto', cls: 'btn-primary', primary: true },
      ],
    });
  }

  function resetPassword(u) {
    const pw = input(genPassword(), 'almeno 6 caratteri');
    const box = el('div', 'stack');
    const row = el('div', 'inline');
    row.append(pw, btn('🎲', '', () => (pw.value = genPassword()), 'Genera'));
    box.append(el('p', null, `La vecchia password di ${R.displayName(u)} smetterà di funzionare e verrà disconnesso da tutti i dispositivi.`), row);
    modal.open({
      title: '🔑 Nuova password',
      body: box,
      actions: [
        { label: 'Annulla' },
        {
          label: 'Cambia password',
          cls: 'btn-primary',
          primary: true,
          onClick: async () => {
            const r = await R.request('user_password', { id: u.id, password: pw.value });
            if (r.token) R.setToken(r.token);
            later(() => showCredentials(u.username, pw.value, u.nome));
            load();
          },
        },
      ],
    });
  }

  function toggleUser(u) {
    const go = async () => {
      await R.request('user_update', { id: u.id, attivo: !u.attivo });
      toast(u.attivo ? '🚫 Utente disattivato' : '✅ Utente riattivato');
      load();
    };
    if (u.attivo) confirmBox('🚫 Disattiva utente', `${R.displayName(u)} verrà disconnesso subito e non potrà più entrare finché non lo riattivi.`, 'Disattiva', 'btn-danger', go);
    else go().catch((e) => toast('❌ ' + e.message, 5000));
  }

  function deleteUser(u) {
    confirmBox('🗑️ Elimina utente', `Eliminare per sempre l'account @${u.username} (${R.displayName(u)})? Verrà disconnesso subito.`, 'Elimina', 'btn-danger', async () => {
      await R.request('user_delete', { id: u.id });
      toast('🗑️ Utente eliminato');
      load();
    });
  }

  // ---------------------------------------------------------------- CANALI
  function renderChannels(root) {
    const bar = el('div', 'adm-bar');
    bar.append(el('p', 'muted small grow', "L'ordine qui sotto è lo stesso della lista canali nella radio."), btn('➕ Nuovo canale', 'btn-primary', () => channelForm(null)));
    root.append(bar);
    const list = el('div', 'adm-list');
    data.channels.forEach((c, i) => {
      const row = el('div', 'adm-row');
      const main = el('div', 'adm-main');
      main.append(el('b', null, c.nome), el('small', null, c.descrizione || '—'));
      const badges = el('div', 'badges');
      if (c.password) badges.append(badge('🔒 password: ' + c.password, 'gold'));
      if (c.ruoli.length) badges.append(badge('👥 solo: ' + c.ruoli.map((id) => R.roleInfo(id).nome).join(', '), 'blue'));
      if (c.riceveSos) badges.append(badge('🚨 riceve tutti gli SOS', 'red'));
      if (c.eco) badges.append(badge('🔁 canale eco', 'blue'));
      badges.append(badge(`👤 ${c.utenti} dentro`));
      main.append(badges);
      const actions = el('div', 'adm-actions');
      const up = btn('↑', '', () => move(c, -1), 'Sposta su');
      up.disabled = i === 0;
      const down = btn('↓', '', () => move(c, 1), 'Sposta giù');
      down.disabled = i === data.channels.length - 1;
      actions.append(up, down, btn('✏️', '', () => channelForm(c), 'Modifica'), btn('🗑️', 'danger', () => deleteChannel(c), 'Elimina'));
      row.append(el('span', 'big-ic', c.icona), main, actions);
      list.append(row);
    });
    root.append(list);
  }

  async function move(c, dir) {
    try {
      await R.request('channel_move', { id: c.id, dir });
      load();
    } catch (e) {
      toast('❌ ' + e.message, 5000);
    }
  }

  function channelForm(c) {
    const isNew = !c;
    const nome = input(isNew ? '' : c.nome, 'es. Polizia di Stato');
    nome.maxLength = 40;
    const icona = input(isNew ? '📻' : c.icona, '📻');
    icona.classList.add('icon-input');
    const desc = input(isNew ? '' : c.descrizione, 'es. Questura di Udine');
    desc.maxLength = 80;
    const pass = input(isNew ? '' : c.password, 'vuota = nessuna password');
    const sos = checkbox('🚨 Centrale: riceve gli SOS di TUTTI i canali', isNew ? false : c.riceveSos, 'Chi è in questo canale sente la sirena di ogni SOS, da qualsiasi canale.');
    const eco = checkbox('🔁 Canale eco (prova audio)', isNew ? false : c.eco, 'Chi parla qui si risente subito dopo: serve per provare microfono e casse.');
    const roleBox = el('div', 'role-checks');
    const chosen = new Set(isNew ? [] : c.ruoli);
    for (const r of data.roles) {
      const ck = checkbox(`${r.icona} ${r.nome}`, chosen.has(r.id));
      ck.dataset.id = r.id;
      roleBox.append(ck);
    }

    const f = el('div', 'form-grid');
    const icRow = el('div', 'stack');
    icRow.append(icona, iconPicker(icona, CH_ICONS));
    f.append(
      field('Nome del canale', nome),
      field('Icona', icRow),
      field('Descrizione (facoltativa)', desc),
      field('🔒 Password del canale', pass, 'Chi non ha "accesso a tutti i canali" dovrà scriverla per entrare. Lasciala vuota per un canale libero.'),
      field('👥 Chi può vedere ed entrare', roleBox, 'Nessuno spuntato = tutti. Il Founder e i ruoli con "accesso a tutti i canali" entrano sempre.'),
      sos,
      eco
    );

    modal.open({
      title: isNew ? '➕ Nuovo canale' : '✏️ Modifica ' + c.nome,
      body: f,
      wide: true,
      actions: [
        { label: 'Annulla' },
        {
          label: isNew ? 'Crea canale' : 'Salva',
          cls: 'btn-primary',
          primary: true,
          onClick: async () => {
            const ruoli = [...roleBox.querySelectorAll('.chk')].filter((x) => x.cb.checked).map((x) => x.dataset.id);
            await R.request('channel_save', {
              id: isNew ? undefined : c.id,
              nome: nome.value,
              icona: icona.value,
              descrizione: desc.value,
              password: pass.value,
              ruoli,
              riceveSos: sos.cb.checked,
              eco: eco.cb.checked,
            });
            toast(isNew ? '✅ Canale creato' : '✅ Canale aggiornato');
            load();
          },
        },
      ],
    });
    later(() => nome.focus());
  }

  function deleteChannel(c) {
    confirmBox('🗑️ Elimina canale', `Eliminare il canale ${c.icona} ${c.nome}? Chi è dentro verrà spostato in un altro canale.`, 'Elimina', 'btn-danger', async () => {
      await R.request('channel_delete', { id: c.id });
      toast('🗑️ Canale eliminato');
      load();
    });
  }

  // ---------------------------------------------------------------- RUOLI (solo Founder)
  function permBadges(p) {
    const w = el('div', 'badges');
    if (p.utenti) w.append(badge('👥 gestisce utenti', 'gold'));
    if (p.canali) w.append(badge('📻 gestisce canali', 'gold'));
    if (p.tuttiCanali) w.append(badge('🔓 tutti i canali', 'blue'));
    if (p.diramazione) w.append(badge('📡 Centrale: più canali e comunicati', 'blue'));
    if (!p.utenti && !p.canali && !p.tuttiCanali && !p.diramazione) w.append(badge('nessun permesso speciale'));
    return w;
  }

  function renderRoles(root) {
    const bar = el('div', 'adm-bar');
    bar.append(
      el('p', 'muted small grow', 'Solo tu, Founder, puoi creare ruoli (es. Comandante, Vice, Staff, Operatore Centrale) e decidere cosa possono fare. I ruoli con permessi speciali li puoi assegnare solo tu.'),
      btn('➕ Nuovo ruolo', 'btn-primary', () => roleForm(null))
    );
    root.append(bar);
    const list = el('div', 'adm-list');

    const fr = el('div', 'adm-row fixed');
    const fmain = el('div', 'adm-main');
    fmain.append(el('b', null, '👑 Founder'), el('small', null, 'Tu. Può fare tutto. Non modificabile.'));
    fmain.append(permBadges({ utenti: true, canali: true, tuttiCanali: true, diramazione: true }));
    fr.append(el('span', 'big-ic', '👑'), fmain);
    list.append(fr);

    for (const r of data.roles) {
      const row = el('div', 'adm-row');
      const ic = el('span', 'big-ic role-ic', r.icona);
      ic.style.borderColor = r.colore;
      const main = el('div', 'adm-main');
      const name = el('b', null, r.nome);
      name.style.color = r.colore;
      main.append(name, el('small', null, `${r.utenti} ${r.utenti === 1 ? 'utente' : 'utenti'}`), permBadges(r.permessi));
      const actions = el('div', 'adm-actions');
      actions.append(btn('✏️', '', () => roleForm(r), 'Modifica'), btn('🗑️', 'danger', () => deleteRole(r), 'Elimina'));
      row.append(ic, main, actions);
      list.append(row);
    }
    root.append(list);
  }

  function roleForm(r) {
    const isNew = !r;
    const nome = input(isNew ? '' : r.nome, 'es. Comandante');
    nome.maxLength = 30;
    const icona = input(isNew ? '🎖️' : r.icona, '🎖️');
    icona.classList.add('icon-input');
    const colore = input(isNew ? '#f59e0b' : r.colore, '', 'color');
    colore.classList.add('color-input');
    const p = (r && r.permessi) || {};
    const pu = checkbox('👥 Gestire gli utenti', p.utenti, 'Creare account, dare nuove password, disattivare ed eliminare utenti (solo quelli senza permessi di Staff).');
    const pc = checkbox('📻 Gestire i canali', p.canali, 'Aggiungere e togliere radio, cambiare le password dei canali e chi può entrare.');
    const pt = checkbox('🔓 Accesso a tutti i canali', p.tuttiCanali, 'Vede ed entra in ogni canale, anche protetti, senza password.');
    const pd = checkbox(
      '📡 Centrale operativa',
      p.diramazione,
      'Per chi gestisce emergenze e notizie: parla a più canali insieme (con priorità su chi sta parlando), sente le loro risposte e manda comunicati / allerte / emergenze. Funziona su tutti i canali che il ruolo può vedere.'
    );

    const f = el('div', 'form-grid');
    const icRow = el('div', 'stack');
    icRow.append(icona, iconPicker(icona, ROLE_ICONS));
    const permBox = el('div', 'stack');
    permBox.append(pd, pu, pc, pt);
    f.append(field('Nome del ruolo', nome), field('Icona', icRow), field('Colore', colore), field('Permessi', permBox, 'Senza permessi = utente normale della radio.'));

    modal.open({
      title: isNew ? '➕ Nuovo ruolo' : '✏️ Modifica ruolo ' + r.nome,
      body: f,
      wide: true,
      actions: [
        { label: 'Annulla' },
        {
          label: isNew ? 'Crea ruolo' : 'Salva',
          cls: 'btn-primary',
          primary: true,
          onClick: async () => {
            await R.request('role_save', {
              id: isNew ? undefined : r.id,
              nome: nome.value,
              icona: icona.value,
              colore: colore.value,
              permessi: { utenti: pu.cb.checked, canali: pc.cb.checked, tuttiCanali: pt.cb.checked, diramazione: pd.cb.checked },
            });
            toast(isNew ? '✅ Ruolo creato' : '✅ Ruolo aggiornato');
            load();
          },
        },
      ],
    });
    later(() => nome.focus());
  }

  function deleteRole(r) {
    confirmBox('🗑️ Elimina ruolo', `Eliminare il ruolo ${r.icona} ${r.nome}?`, 'Elimina', 'btn-danger', async () => {
      await R.request('role_delete', { id: r.id });
      toast('🗑️ Ruolo eliminato');
      load();
    });
  }

  // ---------------------------------------------------------------- SERVER (solo Founder)
  function renderServer(root) {
    const s = data.settings || {};
    const nome = input(s.nomeServer, 'Udine RP ITA');
    nome.maxLength = 40;
    const durata = input(s.durataMassimaTrasmissione, '60', 'number');
    durata.min = '5';
    durata.max = '300';
    const vocali = input(s.messaggiVocaliSalvati, '20', 'number');
    vocali.min = '0';
    vocali.max = '50';

    const card = el('div', 'adm-card');
    card.append(el('h3', null, '⚙️ Impostazioni'));
    const f = el('div', 'form-grid');
    f.append(
      field('Nome del server', nome),
      field('Durata massima di una trasmissione (secondi)', durata, 'Da 5 a 300. Dopo questo tempo la trasmissione si chiude da sola.'),
      field('Vocali salvati per canale', vocali, 'Quanti messaggi vocali si possono riascoltare (0 = nessuno). Si cancellano al riavvio del server.')
    );
    const save = btn('💾 Salva impostazioni', 'btn-primary', async () => {
      save.disabled = true;
      try {
        await R.request('settings_save', { nomeServer: nome.value, durataMassimaTrasmissione: durata.value, messaggiVocaliSalvati: vocali.value });
        toast('✅ Impostazioni salvate');
        load();
      } catch (e) {
        toast('❌ ' + e.message, 5000);
      } finally {
        save.disabled = false;
      }
    });
    card.append(f, save);
    root.append(card);

    const st = data.storage || {};
    const arch = el('div', 'adm-card');
    arch.append(el('h3', null, '💾 Archivio dati (account, ruoli, canali)'));
    arch.append(
      el('p', null, (st.temporaneo ? '⚠️ ' : '✅ ') + (st.descrizione || '—')),
      el('p', 'muted small', st.ultimoSalvataggio ? 'Ultimo salvataggio: ' + new Date(st.ultimoSalvataggio).toLocaleString('it-IT') : 'Nessun salvataggio ancora.')
    );
    if (st.errore) arch.append(el('p', 'adm-warn', '❌ ' + st.errore));
    if (st.temporaneo) {
      const steps = el('ol', 'steps');
      for (const t of [
        'Su github.com clicca sulla tua foto → Settings → Developer settings → Personal access tokens → Tokens (classic).',
        'Clicca «Generate new token (classic)». Nota: radio. Scadenza: No expiration. Spunta SOLO la casella «gist». Poi «Generate token».',
        'Copia il codice che inizia con ghp_ (si vede una volta sola!).',
        'Su render.com apri il servizio della radio → Environment → Add Environment Variable: chiave GITHUB_TOKEN, valore = il codice copiato → Save Changes.',
        'Render riavvia la radio. Se ti chiede di nuovo il Founder, rifallo: da quel momento i dati restano salvati per sempre.',
      ]) steps.append(el('li', null, t));
      arch.append(el('p', null, 'Per salvare i dati in modo permanente (gratis):'), steps);
    }
    const backup = btn('⬇️ Scarica backup', '', async () => {
      try {
        const r = await R.request('export');
        const blob = new Blob([JSON.stringify(r.data, null, 1)], { type: 'application/json' });
        const a = el('a');
        a.href = URL.createObjectURL(blob);
        a.download = `backup-radio-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) {
        toast('❌ ' + e.message, 5000);
      }
    });
    arch.append(backup, el('p', 'muted small', 'Il backup contiene tutti i dati (le password sono cifrate). Tienilo al sicuro e non condividerlo.'));
    root.append(arch);
  }
})();
