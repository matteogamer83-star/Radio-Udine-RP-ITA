'use strict';
/**
 * Archivio dati permanente della radio (account, ruoli, canali, impostazioni).
 *
 * - Sul PC: file  data/radio-data.json
 * - Su Render (o altro hosting): GitHub Gist privato, se è impostata la variabile GITHUB_TOKEN.
 *   Senza GITHUB_TOKEN su Render i dati andrebbero persi ad ogni riavvio.
 */
const fs = require('fs');
const path = require('path');

const GIST_FILE = 'radio-udine-rp-data.json';
const GIST_DESC = 'Radio Udine RP - dati della radio (NON cancellare)';

class FileStore {
  constructor(file, temporaneo) {
    this.file = file;
    this.tipo = 'file';
    this.temporaneo = !!temporaneo;
  }
  descrizione() {
    return this.temporaneo
      ? 'File temporaneo: si CANCELLA a ogni riavvio del server! Configura GITHUB_TOKEN.'
      : `File sul computer del server (${path.basename(path.dirname(this.file))}/${path.basename(this.file)})`;
  }
  async load() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`impossibile leggere ${this.file}: ${e.message}`);
    }
    try {
      return JSON.parse(raw.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`il file ${this.file} è danneggiato (${e.message}). Ripristina la copia ${path.basename(this.file)}.bak`);
    }
  }
  async save(data) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(data, null, 1);
    const tmp = this.file + '.tmp';
    await fs.promises.writeFile(tmp, json);
    try {
      await fs.promises.copyFile(this.file, this.file + '.bak');
    } catch (e) {}
    await fs.promises.rename(tmp, this.file);
  }
}

class GistStore {
  constructor(token, gistId) {
    this.token = token;
    this.gistId = gistId || null;
    this.tipo = 'gist';
    this.temporaneo = false;
  }
  descrizione() {
    return 'GitHub Gist privato (permanente)';
  }
  async api(method, url, body) {
    const res = await fetch('https://api.github.com' + url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'radio-udine-rp',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('GITHUB_TOKEN non valido o scaduto (GitHub ha risposto 401)');
      if (res.status === 403 || res.status === 404) {
        throw new Error(`GitHub ha rifiutato l'accesso (${res.status}): il token deve avere il permesso "gist". ${text.slice(0, 120)}`);
      }
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 160)}`);
    }
    return res.status === 204 ? null : res.json();
  }
  async load() {
    if (!this.gistId) {
      for (let page = 1; page <= 20 && !this.gistId; page++) {
        const list = await this.api('GET', `/gists?per_page=100&page=${page}`);
        const found = list.find((g) => g.files && g.files[GIST_FILE]);
        if (found) this.gistId = found.id;
        if (list.length < 100) break;
      }
      if (!this.gistId) return null; // primo avvio: nessun dato ancora
    }
    const g = await this.api('GET', `/gists/${this.gistId}`);
    const f = g.files && g.files[GIST_FILE];
    if (!f) return null;
    let content = f.content;
    if (f.truncated) {
      const r = await fetch(f.raw_url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20000) });
      content = await r.text();
    }
    return JSON.parse(content);
  }
  async save(data) {
    const files = { [GIST_FILE]: { content: JSON.stringify(data) } };
    if (!this.gistId) {
      const g = await this.api('POST', '/gists', { description: GIST_DESC, public: false, files });
      this.gistId = g.id;
    } else {
      await this.api('PATCH', `/gists/${this.gistId}`, { files });
    }
  }
}

function createStore(root) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (token) return new GistStore(token, (process.env.GIST_ID || '').trim());
  const file = process.env.DATA_FILE || path.join(root, 'data', 'radio-data.json');
  // Su Render il disco è temporaneo: i dati sparirebbero al riavvio
  return new FileStore(file, !!process.env.RENDER);
}

/** Salvataggi raggruppati (un salvataggio ogni ~1 s al massimo) con nuovi tentativi in caso di errore. */
class Persist {
  constructor(store, getData) {
    this.store = store;
    this.getData = getData;
    this.timer = null;
    this.chain = Promise.resolve();
    this.dirty = false;
    this.lastOk = 0;
    this.lastError = '';
  }
  schedule(delay) {
    this.dirty = true;
    const ms = delay == null ? 800 : delay;
    const due = Date.now() + ms;
    if (this.timer && this.due <= due) return; // c'è già un salvataggio previsto prima
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, ms);
  }
  /** Salva subito (in coda agli eventuali salvataggi in corso). Rifiuta se il salvataggio fallisce. */
  flush() {
    this.chain = this.chain.catch(() => {}).then(() => this.saveNow());
    return this.chain;
  }
  async saveNow() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = this.getData();
    if (!data) return; // niente da salvare (radio non ancora configurata)
    try {
      await this.store.save(data);
      this.lastOk = Date.now();
      this.lastError = '';
    } catch (e) {
      this.dirty = true;
      this.lastError = e.message;
      console.error(`[ERRORE] Salvataggio dati non riuscito: ${e.message} (riprovo tra 15 s)`);
      setTimeout(() => this.schedule(0), 15000);
      throw e;
    }
  }
  status() {
    return {
      tipo: this.store.tipo,
      descrizione: this.store.descrizione(),
      temporaneo: this.store.temporaneo,
      ultimoSalvataggio: this.lastOk,
      errore: this.lastError,
      inAttesa: this.dirty,
    };
  }
}

module.exports = { createStore, Persist, FileStore, GistStore };
