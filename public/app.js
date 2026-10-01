/*
 * Radio Udine RP — app web push-to-talk (stile walkie-talkie)
 * Microfono -> AudioWorklet (PCM 16 bit, 16 kHz) -> WebSocket -> server -> radio degli altri
 */
'use strict';
(function () {
  const SR = 16000; // frequenza dell'audio trasmesso
  const APP_NAME = 'Radio Udine RP';
  const APP_VERSION = '2.1.0'; // uguale a package.json: se il server è più nuovo la pagina si ricarica da sola
  const PROTO = 3; // audio con il numero della trasmissione (per sentire più canali insieme)

  // ================================================================ utilità
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('radio-urp:' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem('radio-urp:' + k);
        else localStorage.setItem('radio-urp:' + k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  const finePointer = !!(window.matchMedia && matchMedia('(pointer: fine)').matches);
  const DEFAULTS = {
    volume: 1,
    muted: false,
    radioFx: true,
    pttMode: 'hold', // hold = tieni premuto, toggle = premi una volta
    pttKey: 'Space',
    beeps: true,
    vibrate: true,
    wakeLock: true,
    tastoPc: finePointer, // risponde al tasto PTT per Windows
    notifiche: false,
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  const state = {
    info: null,
    token: store.get('token', null),
    pendingAuth: null,
    ws: null,
    online: false,
    loggedIn: false,
    loggedOut: true,
    myId: null,
    key: null,
    me: null,
    perms: {},
    roles: new Map(),
    serverName: '',
    maxTalk: 60,
    channels: [],
    channel: null,
    users: new Map(),
    chPwd: store.get('chpwd', {}),
    pendingJoin: null,
    pcKeys: 0,
    tx: 'idle', // idle | pending | on | stopping
    txInfo: {}, // risposta del server: canali, ascoltatori, saltati
    pttHeld: false,
    pttSource: null,
    preBuffer: [],
    txStart: 0,
    pendingTimer: null,
    stopTimer: null,
    reconnectDelay: 1000,
    reconnectTimer: null,
    pingTimer: null,
    busyUntil: 0,
    busyBy: null,
    busyPrio: false,
  };

  function roleInfo(id) {
    return state.roles.get(id) || { id, nome: '—', icona: '👤', colore: '#9ca3af' };
  }
  function displayName(u) {
    if (!u) return '';
    return u.sigla ? `${u.sigla} · ${u.nome}` : u.nome;
  }
  const isMine = (u) => !!u && !!state.me && u.uid === state.me.uid;
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function vibrate(p) {
    if (settings.vibrate && navigator.vibrate) {
      try {
        navigator.vibrate(p);
      } catch (e) {}
    }
  }
  function isTyping(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function keyName(code) {
    const map = {
      Space: 'Spazio', ControlLeft: 'Ctrl sinistro', ControlRight: 'Ctrl destro', ShiftLeft: 'Maiusc sinistro',
      ShiftRight: 'Maiusc destro', AltLeft: 'Alt', AltRight: 'Alt Gr', CapsLock: 'Bloc Maiusc', Tab: 'Tab',
      Backquote: '\\', Enter: 'Invio', Backspace: 'Backspace', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←',
      ArrowRight: '→', Insert: 'Ins', Delete: 'Canc', Home: 'Home', End: 'Fine', PageUp: 'Pag ↑', PageDown: 'Pag ↓',
    };
    if (map[code]) return map[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
    return code;
  }
  function barHeight(id, i) {
    const c = String(id).charCodeAt(i % String(id).length) || 0;
    return 18 + ((c * 37 + i * 53) % 82);
  }

  // ================================================================ sintesi vocale (per gli SOS)
  let itVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    itVoice =
      vs.find((v) => /^it[-_]IT/i.test(v.lang) && /google|natural|online/i.test(v.name)) ||
      vs.find((v) => /^it/i.test(v.lang)) ||
      null;
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) return false;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'it-IT';
      if (itVoice) u.voice = itVoice;
      u.rate = 0.95;
      u.volume = 1;
      speechSynthesis.speak(u);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ================================================================ audio
  function softClip(k) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }
  const LINEAR = new Float32Array([-1, 1]);

  // Versione di riserva della cattura (browser senza AudioWorklet)
  class Downsampler {
    constructor(inRate, outRate, emit) {
      this.target = outRate;
      this.ratio = inRate / outRate;
      this.frame = Math.round(outRate * 0.04);
      this.emit = emit;
      this.active = false;
      this.sid = 0;
      this.stopIn = 0;
      this.reset();
    }
    reset() {
      this.out = new Int16Array(this.frame);
      this.n = 0;
      this.acc = 0;
      this.accN = 0;
      this.pos = 0;
      this.sumSq = 0;
    }
    command(msg) {
      if (msg.cmd === 'start') {
        this.reset();
        this.sid = msg.sid;
        this.stopIn = 0;
        this.active = true;
      } else if (msg.cmd === 'stop') {
        if (this.active && msg.sid === this.sid) {
          const tail = Math.round((this.target * (msg.tail || 0)) / 1000);
          if (tail > 0) this.stopIn = tail;
          else {
            this.flush(true);
            this.active = false;
          }
        } else {
          this.emit({ sid: msg.sid, final: true });
        }
      }
    }
    flush(final) {
      if (this.n > 0) {
        const pcm = this.out.slice(0, this.n).buffer;
        this.emit({ sid: this.sid, pcm, level: Math.sqrt(this.sumSq / this.n), final: !!final });
      } else if (final) {
        this.emit({ sid: this.sid, final: true });
      }
      this.n = 0;
      this.sumSq = 0;
    }
    process(ch) {
      if (!this.active) return;
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i];
        this.accN++;
        this.pos += 1;
        if (this.pos >= this.ratio) {
          this.pos -= this.ratio;
          let s = this.acc / this.accN;
          this.acc = 0;
          this.accN = 0;
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          this.sumSq += s * s;
          this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          if (this.stopIn > 0 && --this.stopIn === 0) {
            this.flush(true);
            this.active = false;
            return;
          }
          if (this.n === this.frame) this.flush(false);
        }
      }
    }
  }

  const audio = {
    ctx: null,
    streams: new Map(), // numero trasmissione -> fine dell'audio già in coda (ogni voce ha la sua)
    sources: new Set(),
    stream: null,
    micOk: false,
    micError: '',
    micPromise: null,
    capCmd: null,
    handlers: null,
    capSid: 0,
    replaySrc: null,
    noiseBuf: null,
    sirenNodes: [],

    ensureCtx() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('noaudio');
      let c;
      try {
        c = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        c = new AC();
      }
      this.ctx = c;
      // catena di riproduzione: ingresso -> filtri "radio" -> compressore -> volume -> casse
      this.input = c.createGain();
      this.hp = c.createBiquadFilter();
      this.hp.type = 'highpass';
      this.lp = c.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.shaper = c.createWaveShaper();
      this.comp = c.createDynamicsCompressor();
      this.vol = c.createGain();
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = 512;
      this.input.connect(this.hp);
      this.hp.connect(this.lp);
      this.lp.connect(this.shaper);
      this.shaper.connect(this.comp);
      this.comp.connect(this.vol);
      this.comp.connect(this.analyser);
      this.vol.connect(c.destination);
      // uscita separata per la sirena SOS: suona anche se l'audio è su "muto"
      this.alarmOut = c.createGain();
      this.alarmOut.gain.value = 1;
      this.alarmOut.connect(c.destination);
      this.applyFx();
      this.setVolume();
      c.onstatechange = () => ui.audioBanner();
      return c;
    },

    resume() {
      if (this.ctx && this.ctx.state !== 'running') {
        return this.ctx.resume().then(() => ui.audioBanner(), () => {});
      }
      return Promise.resolve();
    },

    // Da chiamare dentro un tocco/click: sblocca l'audio su iPhone e Android
    unlock() {
      const c = this.ensureCtx();
      this.resume();
      const b = c.createBuffer(1, 1, c.sampleRate);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
      if ('speechSynthesis' in window) {
        try {
          speechSynthesis.getVoices();
        } catch (e) {}
      }
    },

    applyFx() {
      if (!this.ctx) return;
      const nyq = this.ctx.sampleRate / 2;
      if (settings.radioFx) {
        this.hp.frequency.value = 380;
        this.lp.frequency.value = 3000;
        this.shaper.curve = softClip(4);
        this.input.gain.value = 0.6;
        this.comp.threshold.value = -26;
        this.comp.ratio.value = 10;
      } else {
        this.hp.frequency.value = 70;
        this.lp.frequency.value = Math.min(9000, nyq - 100);
        this.shaper.curve = LINEAR;
        this.input.gain.value = 1;
        this.comp.threshold.value = -18;
        this.comp.ratio.value = 3;
      }
    },

    setVolume() {
      if (this.vol) this.vol.gain.value = settings.muted ? 0 : settings.volume;
    },

    initMic() {
      if (this.micOk) return Promise.resolve(true);
      if (!this.micPromise) this.micPromise = this._initMic().finally(() => (this.micPromise = null));
      return this.micPromise;
    },

    async _initMic() {
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.micError = 'insecure';
        return false;
      }
      const c = this.ensureCtx();
      try {
        if (!this.stream) {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false,
          });
        }
      } catch (e) {
        const n = e && e.name;
        this.micError =
          n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'notfound' : 'error';
        return false;
      }
      try {
        const src = c.createMediaStreamSource(this.stream);
        const sink = c.createGain();
        sink.gain.value = 0; // nessun ritorno del microfono nelle casse
        sink.connect(c.destination);
        let node = null;
        if (c.audioWorklet && window.AudioWorkletNode) {
          try {
            await c.audioWorklet.addModule('mic-worklet.js?v=2');
            node = new AudioWorkletNode(c, 'mic-capture', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
              processorOptions: { targetRate: SR },
            });
            node.port.onmessage = (e) => this.onCapture(e.data);
            this.capCmd = (msg) => node.port.postMessage(msg);
          } catch (e) {
            node = null;
          }
        }
        if (!node) {
          const ds = new Downsampler(c.sampleRate, SR, (d) => this.onCapture(d));
          node = c.createScriptProcessor(2048, 1, 1);
          node.onaudioprocess = (e) => ds.process(e.inputBuffer.getChannelData(0));
          this.capCmd = (msg) => ds.command(msg);
        }
        src.connect(node);
        node.connect(sink);
        this.capNode = node; // tiene vivo il nodo
        this.micSrc = src;
        this.stream.getAudioTracks().forEach((t) =>
          t.addEventListener('ended', () => {
            this.micOk = false;
            this.micError = 'error';
            this.stream = null;
            ptt.abort();
            ui.ptt();
            toast('🎙️ Il microfono si è scollegato');
          })
        );
        this.micOk = true;
        this.micError = '';
        return true;
      } catch (e) {
        this.micError = 'error';
        return false;
      }
    },

    startCapture(sid, handlers) {
      this.capSid = sid;
      this.handlers = handlers;
      if (this.capCmd) this.capCmd({ cmd: 'start', sid });
    },
    stopCapture(sid, tailMs) {
      if (this.capCmd) this.capCmd({ cmd: 'stop', sid, tail: tailMs || 0 });
    },
    onCapture(d) {
      if (!d || d.sid !== this.capSid || !this.handlers) return;
      if (d.level != null) ui.meter(d.level);
      if (d.pcm) this.handlers.pcm(d.pcm);
      if (d.final) this.handlers.final();
    },

    // Riproduce un pacchetto audio ricevuto in diretta (PCM 16 bit, 16 kHz).
    // "stream" = numero della trasmissione: voci diverse (es. Centrale che ascolta più canali) si sovrappongono
    playPcm(i16, stream) {
      const c = this.ctx;
      if (!c) return;
      const n = i16.length;
      if (!n) return;
      const rate = c.sampleRate;
      const outLen = Math.max(1, Math.round((n * rate) / SR));
      const buf = c.createBuffer(1, outLen, rate);
      const out = buf.getChannelData(0);
      const step = SR / rate;
      for (let j = 0; j < outLen; j++) {
        const pos = j * step;
        const i = Math.floor(pos);
        const f = pos - i;
        const a = i16[Math.min(i, n - 1)] / 32768;
        const b = i16[Math.min(i + 1, n - 1)] / 32768;
        out[j] = a + (b - a) * f;
      }
      const now = c.currentTime;
      let at = this.streams.get(stream) || 0;
      if (at < now + 0.02) at = now + 0.15; // piccolo buffer anti-scatti
      else if (at > now + 3) return; // troppo ritardo accumulato: scarta
      const s = c.createBufferSource();
      s.buffer = buf;
      s.connect(this.input);
      s.start(at);
      this.streams.set(stream, at + outLen / rate);
      this.sources.add(s);
      s.onended = () => this.sources.delete(s);
      if (c.state !== 'running') this.resume().then(() => ui.audioBanner());
    },

    stopAll() {
      for (const s of this.sources) {
        try {
          s.stop();
        } catch (e) {}
      }
      this.sources.clear();
      this.streams.clear();
    },
    /** Quando finisce l'audio già in coda di una trasmissione (in secondi del contesto audio) */
    endOf(stream) {
      return this.streams.get(stream) || 0;
    },

    tone(freq, start, dur, opts) {
      const c = this.ctx;
      if (!c) return null;
      opts = opts || {};
      const o = c.createOscillator();
      const g = c.createGain();
      const v = opts.vol != null ? opts.vol : 0.18;
      o.type = opts.type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(v, start + 0.006);
      g.gain.setValueAtTime(v, start + Math.max(0.007, dur - 0.012));
      g.gain.linearRampToValueAtTime(0, start + dur);
      o.connect(g);
      g.connect(opts.out || this.vol);
      o.start(start);
      o.stop(start + dur + 0.02);
      return o;
    },

    noise(start, dur, vol) {
      const c = this.ctx;
      if (!c) return;
      if (!this.noiseBuf) {
        const len = c.sampleRate;
        const b = c.createBuffer(1, len, c.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = b;
      }
      const s = c.createBufferSource();
      const g = c.createGain();
      s.buffer = this.noiseBuf;
      g.gain.setValueAtTime(vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      s.connect(g);
      g.connect(this.input);
      s.start(start, Math.random() * 0.5);
      s.stop(start + dur + 0.02);
    },

    sfx(name, at) {
      if (!settings.beeps || !this.ctx) return;
      const t = Math.max(at || 0, this.ctx.currentTime + 0.01);
      switch (name) {
        case 'permit':
          this.tone(880, t, 0.07);
          this.tone(1320, t + 0.08, 0.09);
          break;
        case 'busy':
          for (let i = 0; i < 3; i++) this.tone(440, t + i * 0.18, 0.12, { type: 'square', vol: 0.07 });
          break;
        case 'rxStart':
          if (settings.radioFx) this.noise(t, 0.12, 0.35);
          else this.tone(1500, t, 0.04, { vol: 0.08 });
          break;
        case 'roger':
          this.tone(1250, t, 0.09, { vol: 0.13 });
          if (settings.radioFx) this.noise(t + 0.1, 0.2, 0.4);
          break;
        case 'end':
          this.tone(660, t, 0.06, { vol: 0.1 });
          break;
        case 'text':
          this.tone(1046, t, 0.05, { vol: 0.07 });
          this.tone(1568, t + 0.06, 0.07, { vol: 0.07 });
          break;
        case 'error':
          this.tone(300, t, 0.2, { type: 'square', vol: 0.07 });
          break;
        case 'prio': // parla la Centrale: tre note in salita
          this.tone(988, t, 0.07, { vol: 0.12 });
          this.tone(1319, t + 0.08, 0.07, { vol: 0.12 });
          this.tone(1760, t + 0.16, 0.1, { vol: 0.12 });
          break;
      }
    },

    // Avvisi dei comunicati (suonano anche con l'audio su "muto"). Ritornano la durata in secondi.
    alertTone() {
      const c = this.ctx;
      if (!c) return 0;
      this.stopSiren();
      const t = c.currentTime + 0.05;
      for (let i = 0; i < 4; i++) {
        this.sirenNodes.push(this.tone(1047, t + i * 0.5, 0.18, { type: 'square', vol: 0.09, out: this.alarmOut }));
        this.sirenNodes.push(this.tone(1397, t + i * 0.5 + 0.2, 0.18, { type: 'square', vol: 0.09, out: this.alarmOut }));
      }
      return 2.1;
    },
    chime() {
      const c = this.ctx;
      if (!c) return 0;
      this.stopSiren();
      const t = c.currentTime + 0.05;
      [523, 659, 784, 1047].forEach((f, i) => this.sirenNodes.push(this.tone(f, t + i * 0.13, 0.22, { vol: 0.13, out: this.alarmOut })));
      return 0.75;
    },

    // Sirena bitonale dell'SOS (suona anche con l'audio su muto). Ritorna la durata in secondi.
    siren(seconds) {
      const c = this.ctx;
      if (!c) return 0;
      this.stopSiren();
      const t0 = c.currentTime + 0.05;
      const step = 0.45;
      const n = Math.max(2, Math.round(seconds / step));
      const end = t0 + n * step;
      const o = c.createOscillator();
      const lp = c.createBiquadFilter();
      const g = c.createGain();
      o.type = 'square';
      for (let i = 0; i < n; i++) o.frequency.setValueAtTime(i % 2 ? 660 : 880, t0 + i * step);
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.17, t0 + 0.03);
      g.gain.setValueAtTime(0.17, end - 0.05);
      g.gain.linearRampToValueAtTime(0, end);
      o.connect(lp);
      lp.connect(g);
      g.connect(this.alarmOut);
      o.start(t0);
      o.stop(end + 0.05);
      this.sirenNodes = [o];
      return n * step;
    },
    stopSiren() {
      for (const o of this.sirenNodes) {
        try {
          o.stop();
        } catch (e) {}
      }
      this.sirenNodes = [];
    },

    async replay(url) {
      this.stopReplay();
      const c = this.ensureCtx();
      await this.resume();
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 404 ? 'gone' : 'http');
      const ab = await res.arrayBuffer();
      const buf = await new Promise((ok, ko) => {
        const p = c.decodeAudioData(ab, ok, ko);
        if (p && p.catch) p.catch(ko);
      });
      const s = c.createBufferSource();
      s.buffer = buf;
      s.connect(this.input);
      this.replaySrc = s;
      return new Promise((resolve) => {
        s.onended = () => {
          if (this.replaySrc === s) this.replaySrc = null;
          resolve();
        };
        s.start();
      });
    },

    stopReplay() {
      if (this.replaySrc) {
        const s = this.replaySrc;
        this.replaySrc = null;
        try {
          s.stop();
        } catch (e) {}
      }
    },
  };

  // ================================================================ rete
  const pending = new Map();
  let reqSeq = 0;

  const net = {
    connect() {
      clearTimeout(state.reconnectTimer);
      if (state.ws) return;
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.binaryType = 'arraybuffer';
      state.ws = ws;
      ui.status('connecting');
      ws.onopen = () => {
        const msg = state.pendingAuth || { t: 'auth', token: state.token };
        ws.send(JSON.stringify(Object.assign({}, msg, { tastoPc: !!settings.tastoPc, proto: PROTO })));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          // 2 byte con il numero della trasmissione + audio PCM 16 bit
          const ab = e.data;
          if (ab.byteLength < 4 || ab.byteLength % 2) return;
          const n = new DataView(ab).getUint16(0, true);
          audio.playPcm(new Int16Array(ab, 2), n);
          rx.touch(n);
          return;
        }
        let m;
        try {
          m = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        try {
          onMessage(m);
        } catch (err) {
          console.error('Errore messaggio', m && m.t, err);
        }
      };
      ws.onclose = () => {
        if (state.ws !== ws) return;
        state.ws = null;
        const wasOnline = state.online;
        state.online = false;
        clearInterval(state.pingTimer);
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connessione persa'));
        }
        pending.clear();
        ptt.abort();
        rx.reset();
        ui.status('off');
        ui.lcd();
        ui.ptt();
        if (state.loggedOut) return;
        if (!state.loggedIn) {
          state.loggedOut = true;
          loginFail('Server non raggiungibile. Controlla la connessione e riprova.');
          return;
        }
        if (wasOnline) toast('📡 Connessione persa, mi ricollego…');
        state.reconnectTimer = setTimeout(() => net.connect(), state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 8000);
      };
      ws.onerror = () => {};
    },
    send(obj) {
      const ws = state.ws;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    },
    sendBinary(buf) {
      const ws = state.ws;
      if (ws && ws.readyState === 1 && ws.bufferedAmount < 256 * 1024) ws.send(buf);
    },
    request(op, data) {
      return new Promise((resolve, reject) => {
        if (!state.online) return reject(new Error('Non sei collegato alla radio.'));
        const rid = ++reqSeq;
        const timer = setTimeout(() => {
          pending.delete(rid);
          reject(new Error('Il server non risponde, riprova.'));
        }, 20000);
        pending.set(rid, { resolve, reject, timer });
        net.send(Object.assign({}, data || {}, { t: 'req', rid, op }));
      });
    },
    close() {
      state.loggedOut = true;
      clearTimeout(state.reconnectTimer);
      clearInterval(state.pingTimer);
      const ws = state.ws;
      state.ws = null;
      state.online = false;
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
    },
    reconnectNow() {
      if (state.ws || !state.loggedIn || state.loggedOut) return;
      state.reconnectDelay = 1000;
      net.connect();
    },
  };

  function applySession(m) {
    if (!state.me || !m.me || state.me.uid !== m.me.uid) disp.load(m.me && m.me.uid);
    state.me = m.me;
    state.perms = m.perms || {};
    state.roles = new Map((m.roles || []).map((r) => [r.id, r]));
    state.channels = m.channels || [];
    state.maxTalk = m.maxTalk || 60;
    state.serverName = m.server || state.serverName;
    state.pcKeys = m.pcKeys || 0;
    if (m.channel) state.channel = m.channel;
    $('#sideServer').textContent = state.serverName;
    ui.channels();
    ui.me();
    ui.header();
    ui.users();
    ui.adminButtons();
    disp.render();
    disp.syncMonitor();
    ui.ptt();
    ui.lcd();
    if (RadioApp.onSession) RadioApp.onSession();
  }

  // Il server è stato aggiornato: ricarica la pagina (una volta sola) per avere la radio nuova
  function checkVersion(v) {
    if (!v || v === APP_VERSION) return false;
    let done = '';
    try {
      done = sessionStorage.getItem('radio-urp:reload') || '';
      sessionStorage.setItem('radio-urp:reload', v);
    } catch (e) {}
    if (done === v) return false;
    toast('🔄 Radio aggiornata, ricarico…');
    setTimeout(() => location.reload(), 600);
    return true;
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        if (checkVersion(m.versione)) return;
        state.myId = m.id;
        state.key = m.key;
        if (m.token) {
          state.token = m.token;
          store.set('token', m.token);
        }
        state.pendingAuth = null;
        applySession(m);
        store.set('lastName', displayName(m.me));
        state.online = true;
        state.reconnectDelay = 1000;
        disp.lastMon = ''; // connessione nuova: il server non sa ancora cosa ascoltiamo
        disp.syncMonitor();
        clearInterval(state.pingTimer);
        state.pingTimer = setInterval(() => net.send({ t: 'ping' }), 20000);
        if (!state.loggedIn) {
          state.loggedIn = true;
          ui.showApp();
          if (!audio.micOk && audio.micError !== 'insecure') setTimeout(() => state.loggedIn && showMicHelp(), 800);
        }
        ui.status('on');
        const last = (state.channel && state.channel.id) || store.get('lastChannel', null);
        if (last && state.channels.some((c) => c.id === last)) join(last, true);
        else joinFallback();
        break;
      }
      case 'auth_fail':
        onAuthFail(m);
        break;
      case 'kicked':
        logoutNow(m.msg || 'Sei stato disconnesso.');
        break;
      case 'session':
        applySession(m);
        break;
      case 'error':
        handleError(m);
        break;
      case 'channels':
        state.channels = m.channels || [];
        if (state.channel) {
          const c = state.channels.find((x) => x.id === state.channel.id);
          if (c) state.channel = c;
        }
        ui.channels();
        ui.header();
        disp.render();
        disp.syncMonitor();
        ui.ptt();
        break;
      case 'channel_gone':
        toast(m.msg || 'Il canale non è più disponibile');
        rx.reset();
        state.channel = null;
        state.users.clear();
        ui.users();
        ui.feedReset([]);
        joinFallback();
        break;
      case 'joined': {
        rx.reset();
        audio.stopReplay();
        const pj = state.pendingJoin;
        if (pj && pj.id === m.channel.id && pj.password) {
          state.chPwd[m.channel.id] = pj.password;
          store.set('chpwd', state.chPwd);
        }
        state.pendingJoin = null;
        state.channel = m.channel;
        state.users = new Map((m.users || []).map((u) => [u.id, u]));
        store.set('lastChannel', m.channel.id);
        ui.header();
        ui.channels();
        ui.users();
        ui.feedReset(m.feed || []);
        disp.render();
        disp.syncMonitor();
        ui.ptt();
        if (m.talker) rx.start(m.talker, true);
        else ui.lcd();
        break;
      }
      case 'users':
        state.users = new Map((m.users || []).map((u) => [u.id, u]));
        ui.users();
        break;
      case 'user_join':
        state.users.set(m.user.id, m.user);
        ui.users();
        ui.system(`${displayName(m.user)} è entrato nel canale`);
        break;
      case 'user_leave':
        if (state.users.delete(m.user.id)) {
          ui.users();
          ui.system(`${displayName(m.user)} ha lasciato il canale`);
        }
        break;
      case 'talk_start':
        rx.start(m);
        break;
      case 'talk_end':
        rx.end(m);
        break;
      case 'text':
        ui.feedAdd(Object.assign({}, m.msg, { via: m.via || null }));
        if (!isMine(m.msg.from)) {
          audio.sfx('text');
          vibrate(20);
        }
        break;
      case 'alert':
        onAlert(m.msg);
        break;
      case 'sos_ack':
        onSosAck(m);
        break;
      case 'annuncio':
        onAnnuncio(m);
        break;
      case 'annuncio_ack':
        onAnnuncioAck(m);
        break;
      case 'ptt_ok':
        ptt.onOk(m);
        break;
      case 'ptt_busy':
        ptt.onBusy(m.by, m.prio);
        break;
      case 'ptt_timeout':
        ptt.onTimeout();
        break;
      case 'ptt_cut':
        ptt.onCut(m.by);
        break;
      case 'remote_ptt':
        onRemotePtt(!!m.down);
        break;
      case 'pc_key':
        state.pcKeys = m.n || 0;
        ui.ptt();
        if (m.n > 0 && m.nuovo) toast('⌨️ Tasto PTT per PC collegato!');
        break;
      case 'res': {
        const p = pending.get(m.rid);
        if (!p) return;
        pending.delete(m.rid);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data || {});
        else p.reject(new Error(m.error || 'Errore'));
        break;
      }
      case 'admin_dirty':
        if (RadioApp.onAdminDirty) RadioApp.onAdminDirty();
        break;
    }
  }

  function onAuthFail(m) {
    if (m.code === 'token' || m.code === 'disattivato') {
      state.token = null;
      store.set('token', null);
    }
    if (state.loggedIn) {
      logoutNow(m.msg);
      return;
    }
    net.close();
    if (m.code === 'token') showView('login');
    if (m.code === 'setup_done') {
      boot(true);
      return;
    }
    loginFail(m.msg || 'Accesso non riuscito');
  }

  function handleError(m) {
    switch (m.code) {
      case 'channel_password': {
        const pj = state.pendingJoin;
        state.pendingJoin = null;
        const ch = state.channels.find((c) => c.id === m.channel);
        if (ch) {
          delete state.chPwd[ch.id];
          store.set('chpwd', state.chPwd);
        }
        if (!state.channel) joinFallback();
        if (ch && pj && !pj.auto) askChannelPassword(ch, !!pj.password);
        break;
      }
      case 'no_channel':
        state.pendingJoin = null;
        if (!state.channel) joinFallback();
        else toast(m.msg);
        break;
      default:
        toast(m.msg || 'Errore');
    }
  }

  // ================================================================ canali
  function join(id, auto) {
    const ch = state.channels.find((c) => c.id === id);
    if (!ch) return;
    ui.closeDrawer();
    if (!auto && state.channel && state.channel.id === id) return;
    const pwd = state.chPwd[id] || '';
    if (ch.protetto && !pwd) {
      if (auto) joinFallback();
      else askChannelPassword(ch, false);
      return;
    }
    sendJoin(id, pwd, auto);
  }

  function sendJoin(id, password, auto) {
    ptt.abort();
    audio.stopReplay();
    state.pendingJoin = { id, password, auto: !!auto };
    net.send({ t: 'join', channel: id, password });
  }

  function joinFallback() {
    const c = state.channels.find((x) => !x.protetto && !x.eco) || state.channels.find((x) => !x.protetto);
    if (c) sendJoin(c.id, '', true);
  }

  function askChannelPassword(ch, wrong) {
    const input = el('input', 'input');
    input.type = 'password';
    input.placeholder = 'Password del canale';
    input.autocomplete = 'off';
    const body = el('div');
    body.append(
      el('p', wrong ? '' : 'muted', wrong ? '❌ Password errata, riprova.' : `Il canale ${ch.icona} ${ch.nome} è protetto da password.`),
      input
    );
    modal.open({
      title: '🔒 ' + ch.nome,
      body,
      actions: [
        { label: 'Annulla' },
        {
          label: 'Entra',
          cls: 'btn-primary',
          primary: true,
          onClick: () => {
            if (!input.value) return false;
            sendJoin(ch.id, input.value, false);
          },
        },
      ],
    });
    setTimeout(() => input.focus(), 60);
  }

  // ================================================================ ricezione (in diretta)
  // Ogni trasmissione ha un numero (n). Di solito ce n'è una sola, ma la Centrale che ascolta
  // più canali può sentirne diverse nello stesso momento.
  const rx = {
    talks: new Map(), // n -> { user, id, n, via, canali, prio, eco, origine, start, last }
    timers: new Map(),
    watchTimer: 0,

    start(t, silent) {
      if (!t || !t.user || t.n == null) return;
      const old = this.talks.get(t.n);
      clearTimeout(this.timers.get(t.n));
      this.timers.delete(t.n);
      this.talks.set(t.n, Object.assign({}, t, { start: old ? old.start : Date.now(), last: Date.now() }));
      this.watch();
      if (old) return ui.lcd();
      if (!t.via) audio.stopReplay();
      audio.resume();
      if (!silent) audio.sfx(t.prio ? 'prio' : 'rxStart');
      vibrate(t.prio ? [50, 40, 50] : 25);
      ui.lcd();
      ui.users();
      ui.title();
      ui.audioBanner();
    },

    touch(n) {
      const t = this.talks.get(n);
      if (t) t.last = Date.now();
    },

    end(m) {
      if (m.msg) ui.feedAdd(Object.assign({}, m.msg, { via: m.via || null }));
      const t = this.talks.get(m.n);
      if (!t || this.timers.has(m.n)) return;
      const c = audio.ctx;
      const endAt = c ? Math.max(audio.endOf(m.n), c.currentTime) : 0;
      audio.sfx('roger', endAt);
      const delay = c ? Math.max(0, (endAt - c.currentTime) * 1000) + 300 : 0;
      this.timers.set(m.n, setTimeout(() => this.remove(m.n), delay));
    },

    remove(n) {
      clearTimeout(this.timers.get(n));
      this.timers.delete(n);
      if (!this.talks.delete(n)) return;
      audio.streams.delete(n);
      ui.lcd();
      ui.users();
      ui.title();
    },

    // rete persa a metà: se una voce non manda più audio da 4 secondi la tolgo dal display
    watch() {
      if (this.watchTimer) return;
      this.watchTimer = setInterval(() => {
        const now = Date.now();
        for (const t of [...this.talks.values()]) if (now - t.last > 4000 && !this.timers.has(t.n)) this.remove(t.n);
        if (!this.talks.size) {
          clearInterval(this.watchTimer);
          this.watchTimer = 0;
        }
      }, 1000);
    },

    latest() {
      let best = null;
      for (const t of this.talks.values()) if (!best || t.start >= best.start) best = t;
      return best;
    },
    /** Qualcuno sta parlando nel MIO canale */
    busyHere() {
      for (const t of this.talks.values()) if (!t.via) return true;
      return false;
    },
    talkingIds() {
      const s = new Set();
      for (const t of this.talks.values()) s.add(t.user.id);
      return s;
    },

    reset() {
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
      this.talks.clear();
      audio.stopAll();
      ui.title();
    },
  };

  // ================================================================ trasmissione (PTT)
  const ptt = {
    sid: 0,

    down() {
      if (state.tx !== 'idle' || micTest.running) return;
      if (!state.online || !state.channel) {
        toast('Non sei collegato a nessun canale');
        audio.sfx('error');
        return;
      }
      if (!audio.micOk) {
        showMicHelp();
        return;
      }
      audio.resume();
      audio.stopReplay();
      state.tx = 'pending';
      state.pttHeld = true;
      state.preBuffer = [];
      state.txInfo = {};
      const sid = ++this.sid;
      audio.startCapture(sid, { pcm: (b) => this.onPcm(b, sid), final: () => this.onFinal(sid) });
      // Centrale con "più canali" attivo: parla anche ai canali collegati, con priorità
      net.send(disp.active() ? { t: 'ptt_start', diramazione: true, canali: disp.targetIds() } : { t: 'ptt_start' });
      clearTimeout(state.pendingTimer);
      state.pendingTimer = setTimeout(() => {
        if (state.tx === 'pending') {
          this.abort();
          toast('Il server non risponde, riprova');
        }
      }, 4000);
      ui.ptt();
      ui.lcd();
    },

    up() {
      state.pttHeld = false;
      if (state.tx === 'on') this.finish();
      // se è ancora "pending" chiuderà appena arriva l'ok del server
    },

    toggle() {
      if (state.tx === 'idle') this.down();
      else this.up();
    },

    onPcm(buf, sid) {
      if (sid !== this.sid) return;
      if (state.tx === 'pending') {
        state.preBuffer.push(buf);
        if (state.preBuffer.length > 60) state.preBuffer.shift();
      } else if (state.tx === 'on' || state.tx === 'stopping') {
        net.sendBinary(buf);
      }
    },

    onOk(m) {
      if (state.tx !== 'pending') return;
      clearTimeout(state.pendingTimer);
      state.tx = 'on';
      state.txStart = Date.now();
      state.txInfo = m || {};
      for (const b of state.preBuffer) net.sendBinary(b);
      state.preBuffer = [];
      audio.sfx('permit');
      vibrate(40);
      if (m && m.saltati && m.saltati.length) toast(`⚠️ Non ti sentono in: ${m.saltati.join(', ')} (lì sta già parlando un'altra Centrale)`, 6000);
      ui.lcd();
      ui.users();
      ui.ptt();
      if (!state.pttHeld) this.finish();
    },

    finish() {
      if (state.tx !== 'on') return;
      state.tx = 'stopping';
      const sid = this.sid;
      // la coda (per non tagliare l'ultima parola) la gestisce il thread audio: funziona anche in secondo piano
      audio.stopCapture(sid, 160);
      clearTimeout(state.stopTimer);
      state.stopTimer = setTimeout(() => this.onFinal(sid), 1500); // riserva
    },

    onFinal(sid) {
      if (sid !== this.sid || state.tx !== 'stopping') return;
      clearTimeout(state.stopTimer);
      net.send({ t: 'ptt_stop' });
      this.reset();
      audio.sfx('end');
    },

    onBusy(by, prio) {
      if (state.tx !== 'pending') return;
      audio.stopCapture(this.sid);
      this.sid++;
      this.reset();
      audio.sfx('busy');
      vibrate([60, 60, 60]);
      ui.busy(by, prio);
    },

    // la Centrale ha preso la linea mentre parlavi
    onCut(by) {
      if (state.tx !== 'on' && state.tx !== 'stopping') return;
      audio.stopCapture(this.sid);
      this.sid++;
      this.reset();
      audio.sfx('busy');
      vibrate([80, 60, 80]);
      toast(`📡 ${displayName(by)} (Centrale) ha preso la linea: la tua trasmissione è stata interrotta`, 6000);
    },

    onTimeout() {
      if (state.tx !== 'on' && state.tx !== 'stopping') return;
      audio.stopCapture(this.sid);
      this.sid++;
      this.reset();
      audio.sfx('end');
      toast(`⏱️ Tempo massimo di trasmissione (${state.maxTalk}s) raggiunto`);
    },

    abort() {
      if (state.tx === 'idle') return;
      audio.stopCapture(this.sid);
      this.sid++;
      net.send({ t: 'ptt_stop' });
      this.reset();
    },

    reset() {
      clearTimeout(state.pendingTimer);
      clearTimeout(state.stopTimer);
      state.tx = 'idle';
      state.preBuffer = [];
      ui.lcd();
      ui.users();
      ui.ptt();
      ui.meter(0);
    },
  };

  // Tasto PTT per Windows (programmino che funziona anche col gioco in primo piano)
  function onRemotePtt(down) {
    if (!settings.tastoPc || !state.loggedIn) return;
    if (down) {
      if (settings.pttMode === 'toggle') ptt.toggle();
      else if (state.tx === 'idle') {
        state.pttSource = 'remote';
        ptt.down();
      }
    } else if (settings.pttMode === 'hold' && state.pttSource === 'remote') {
      state.pttSource = null;
      ptt.up();
    }
  }

  // Registra 3 secondi e li fa riascoltare (solo in locale, niente viene inviato)
  const micTest = {
    running: false,
    async run(btn) {
      if (this.running || state.tx !== 'idle') return;
      if (!audio.micOk) {
        const ok = await audio.initMic();
        ui.ptt();
        if (!ok) {
          showMicHelp();
          return;
        }
      }
      this.running = true;
      audio.resume();
      audio.stopReplay();
      const chunks = [];
      const sid = ++ptt.sid;
      btn.disabled = true;
      btn.textContent = '🔴 Parla ora… (3 s)';
      audio.startCapture(sid, { pcm: (b) => chunks.push(b), final: () => {} });
      await sleep(3000);
      audio.stopCapture(sid);
      await sleep(250);
      ui.meter(0);
      btn.textContent = '🔊 Riascolto…';
      audio.streams.delete(0);
      for (const b of chunks) audio.playPcm(new Int16Array(b), 0);
      const wait = audio.ctx ? Math.max(0, audio.endOf(0) - audio.ctx.currentTime) : 0;
      await sleep(wait * 1000 + 250);
      audio.streams.delete(0);
      btn.textContent = '🎙️ Prova microfono';
      btn.disabled = false;
      this.running = false;
      if (!chunks.length) toast('Nessun audio registrato: controlla il microfono');
    },
  };

  // ================================================================ allarmi: SOS e comunicati della Centrale
  const KINDS = {
    sos: { title: '🚨 SOS 🚨', ack: '✅ Ricevuto, intervengo', done: "✅ Hai risposto all'SOS", sev: 3, where: '📍 POSIZIONE' },
    emergenza: { title: '🚨 EMERGENZA 🚨', ack: '✅ Ricevuto, intervengo', done: '✅ Hai risposto: stai intervenendo', sev: 3, where: '📍 LUOGO' },
    allerta: { title: '⚠️ ALLERTA', ack: '✅ Ricevuto', done: '✅ Hai confermato', sev: 2, where: '📍 LUOGO' },
    info: { title: '📢 COMUNICATO', ack: '👍 Ricevuto', done: '👍 Hai confermato', sev: 1, where: '📍 LUOGO' },
  };
  const LIVELLI = [
    ['info', '📢 Notizia', 'Notizia: suona un avviso e una voce legge il messaggio. Per aggiornamenti e informazioni.'],
    ['allerta', '⚠️ Allerta', 'Allerta: schermata arancione, suono di allarme e una voce che legge il messaggio due volte.'],
    ['emergenza', '🚨 Emergenza', "Emergenza: schermata rossa e SIRENA (anche con l'audio su muto), poi una voce legge messaggio e luogo."],
  ];

  function canaliText(m) {
    if (m.tutti) return '📡 A tutti i canali';
    const list = m.canali || [];
    const names = list
      .slice(0, 4)
      .map((c) => `${c.icona} ${c.nome}`)
      .join(', ');
    return `📡 A: ${names}${list.length > 4 ? ` e altri ${list.length - 4}` : ''}`;
  }

  const alarm = {
    current: null,
    kind: null,
    timer: 0,
    show(kind, m) {
      const K = KINDS[kind];
      if (this.current && this.current.id !== m.id && KINDS[this.kind].sev > K.sev) {
        toast(`${K.title}: ${m.testo}`, 6000); // è già aperto un allarme più grave: questo resta in cronologia
        return;
      }
      this.current = m;
      this.kind = kind;
      const r = roleInfo(m.from.ruolo);
      const isSos = kind === 'sos';
      const where = isSos ? m.testo : m.luogo;
      $('#sosOverlay').dataset.kind = kind;
      $('#sosTitle').textContent = K.title;
      $('#sosWho').textContent = displayName(m.from);
      $('#sosRole').textContent = `${r.icona} ${r.nome}`;
      $('#sosText').hidden = isSos;
      $('#sosText').textContent = isSos ? '' : m.testo;
      $('#sosWhereBox').hidden = !isSos && !where;
      $('#sosWhereLbl').textContent = K.where;
      $('#sosWhere').textContent = where || 'Posizione non indicata';
      $('#sosWhere').classList.toggle('missing', !where);
      $('#sosChan').textContent = isSos ? `Canale: ${m.canale.icona} ${m.canale.nome}` : canaliText(m);
      $('#sosAcks').textContent = '';
      const b = $('#sosAck');
      b.disabled = false;
      b.textContent = K.ack;
      $('#sosOverlay').hidden = false;
      audio.resume();
      this.stopSound();
      const quiet = kind === 'info' && settings.muted; // le notizie rispettano il "muto", gli allarmi no
      if (!quiet) {
        const dur = isSos || kind === 'emergenza' ? audio.siren(4) : kind === 'allerta' ? audio.alertTone() : audio.chime();
        this.timer = setTimeout(() => this.speak(), dur * 1000 + 300);
      }
      vibrate(kind === 'info' ? [120, 80, 120] : [400, 150, 400, 150, 800]);
      notifyAlarm(kind, m);
    },
    speak() {
      const m = this.current;
      if (!m) return;
      const r = roleInfo(m.from.ruolo);
      const chi = (m.from.sigla ? m.from.sigla + ', ' : '') + m.from.nome;
      if (this.kind === 'sos') {
        const dove = m.testo ? `Posizione: ${m.testo}. Ripeto: ${m.testo}.` : 'Posizione non indicata.';
        speak(`Attenzione! S O S da ${chi}, ${r.nome}. ${dove} Canale ${m.canale.nome}.`);
      } else if (this.kind === 'emergenza') {
        speak(`Emergenza! ${chi} comunica: ${m.testo}.` + (m.luogo ? ` Luogo: ${m.luogo}. Ripeto: ${m.luogo}.` : ` Ripeto: ${m.testo}.`));
      } else if (this.kind === 'allerta') {
        speak(`Attenzione, allerta da ${chi}: ${m.testo}.` + (m.luogo ? ` Luogo: ${m.luogo}.` : '') + ` Ripeto: ${m.testo}.`);
      } else {
        speak(`Comunicato da ${chi}: ${m.testo}.` + (m.luogo ? ` Luogo: ${m.luogo}.` : ''));
      }
    },
    ack() {
      if (!this.current) return;
      net.send(this.kind === 'sos' ? { t: 'sos_ack', id: this.current.id } : { t: 'annuncio_ack', id: this.current.id });
      const b = $('#sosAck');
      b.disabled = true;
      b.textContent = KINDS[this.kind].done;
    },
    addAck(text) {
      $('#sosAcks').append(el('div', null, '✅ ' + text));
    },
    stopSound() {
      clearTimeout(this.timer);
      audio.stopSiren();
      if ('speechSynthesis' in window) {
        try {
          speechSynthesis.cancel();
        } catch (e) {}
      }
    },
    close() {
      this.stopSound();
      $('#sosOverlay').hidden = true;
      this.current = null;
      this.kind = null;
    },
  };

  function notifyAlarm(kind, m) {
    if (!settings.notifiche || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const isSos = kind === 'sos';
    const title = `${isSos ? '🚨 SOS' : KINDS[kind].title} — ${displayName(m.from)}`;
    const body = isSos ? `📍 ${m.testo || 'Posizione non indicata'} · ${m.canale.nome}` : m.testo + (m.luogo ? ` · 📍 ${m.luogo}` : '');
    const opts = { body, tag: m.id, requireInteraction: kind !== 'info', icon: 'icons/icon-192.png' };
    const fallback = () => {
      try {
        new Notification(title, opts);
      } catch (e) {}
    };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(fallback);
    } else fallback();
  }

  function flashApp() {
    const app = $('#app');
    app.classList.remove('sos-flash');
    void app.offsetWidth;
    app.classList.add('sos-flash');
    setTimeout(() => app.classList.remove('sos-flash'), 3200);
  }

  function onAlert(m) {
    ui.feedAdd(m);
    flashApp();
    if (isMine(m.from)) {
      audio.sfx('permit');
      toast('🚨 SOS inviato: sirena e posizione arrivano a tutto il canale e alla Centrale', 5000);
      return;
    }
    alarm.show('sos', m);
  }

  function onSosAck(m) {
    const mineAck = isMine(m.by);
    const name = displayName(m.by);
    ui.addAck(m.id, name);
    ui.system(`✅ ${name} ha risposto all'SOS di ${displayName(m.alert.from)}`);
    if (alarm.current && alarm.current.id === m.id) alarm.addAck(name + (mineAck ? ' (tu)' : ''));
    if (isMine(m.alert.from) && !mineAck) {
      toast(`✅ ${name} ha ricevuto il tuo SOS e sta intervenendo`, 7000);
      audio.sfx('permit');
      speak(`${m.by.nome} ha ricevuto il tuo S O S.`);
    }
  }

  function onAnnuncio(m) {
    const a = m.msg;
    ui.feedAdd(a);
    if (m.mio || isMine(a.from)) {
      if (m.mio) {
        audio.sfx('permit');
        const dove = a.tutti ? 'tutti i canali' : a.canali.length === 1 ? '1 canale' : `${a.canali.length} canali`;
        toast(`📢 Comunicato inviato a ${dove}: lo ricevono ${m.persone} ${m.persone === 1 ? 'persona collegata' : 'persone collegate'}`, 6000);
      }
      return;
    }
    if (a.livello !== 'info') flashApp();
    alarm.show(KINDS[a.livello] ? a.livello : 'info', a);
  }

  function onAnnuncioAck(m) {
    const name = displayName(m.by);
    ui.addAck(m.id, name);
    if (alarm.current && alarm.current.id === m.id) alarm.addAck(name + (isMine(m.by) ? ' (tu)' : ''));
    if (isMine(m.annuncio.from) && !isMine(m.by)) {
      toast(`✅ ${name} ha ricevuto il comunicato`, 5000);
      audio.sfx('permit');
      if (m.annuncio.livello === 'emergenza') speak(`${m.by.nome} interviene.`);
    }
  }

  function openSos() {
    if (!state.channel || !state.online) return toast('Non sei collegato a nessun canale');
    const input = el('input', 'input');
    input.maxLength = 120;
    input.placeholder = 'es. Piazza Libertà, vicino alla stazione';
    const body = el('div');
    body.append(
      el('p', null, `Tutti in ${state.channel.icona} ${state.channel.nome} (e la Centrale) sentiranno la sirena e una voce che legge la tua posizione.`),
      el('label', 'mini-label', '📍 Dove ti trovi?'),
      input
    );
    modal.open({
      title: '🚨 Allerta SOS',
      body,
      actions: [
        { label: 'Annulla' },
        { label: '🚨 INVIA SOS', cls: 'btn-danger', primary: true, onClick: () => net.send({ t: 'alert', text: input.value }) },
      ],
    });
    setTimeout(() => input.focus(), 60);
  }

  // ================================================================ Centrale operativa
  // Chi ha il permesso "Centrale" collega più canali: parla a tutti insieme (con priorità),
  // sente le loro risposte e manda comunicati (notizia, allerta, emergenza).
  const DISP_DEFAULT = { on: false, tutti: false, canali: [], ascolta: true };
  const disp = {
    cfg: Object.assign({}, DISP_DEFAULT),
    uid: null,
    lastMon: '',
    scroll: 0,

    load(uid) {
      this.uid = uid || null;
      this.cfg = Object.assign({}, DISP_DEFAULT, (uid && store.get('disp:' + uid, null)) || {});
      if (!Array.isArray(this.cfg.canali)) this.cfg.canali = [];
    },
    save() {
      if (this.uid) store.set('disp:' + this.uid, this.cfg);
    },
    allowed() {
      return !!(state.perms && state.perms.diramazione);
    },
    /** Tutti i canali che posso collegare: quelli che vedo, tranne l'eco. I canali nuovi compaiono da soli */
    eligible() {
      return state.channels.filter((c) => !c.eco);
    },
    linked(id) {
      return this.cfg.tutti || this.cfg.canali.includes(id);
    },
    /** "Più canali" acceso adesso (nel canale eco no) */
    active() {
      return this.allowed() && this.cfg.on && !!state.channel && !state.channel.eco;
    },
    /** Canali collegati oltre a quello in cui sei */
    targets() {
      if (!this.active()) return [];
      const cur = state.channel.id;
      return this.eligible().filter((c) => c.id !== cur && this.linked(c.id));
    },
    targetIds() {
      return this.targets().map((c) => c.id);
    },
    /** Dice al server quali canali ascoltare oltre al mio */
    syncMonitor() {
      if (!state.online) return;
      const cur = state.channel && state.channel.id;
      const ids =
        this.allowed() && this.cfg.on && this.cfg.ascolta ? this.eligible().filter((c) => c.id !== cur && this.linked(c.id)).map((c) => c.id) : [];
      const key = ids.join(',');
      if (key === this.lastMon) return;
      this.lastMon = key;
      net.send({ t: 'monitor', canali: ids });
    },
    changed() {
      this.save();
      this.render();
      this.syncMonitor();
      ui.channels();
      ui.ptt();
      ui.lcd();
    },
    toggle() {
      this.cfg.on = !this.cfg.on;
      this.changed();
      if (!this.cfg.on) return toast('📡 Più canali SPENTO: parli solo nel tuo canale');
      const n = this.targets().length;
      toast(n ? `📡 Più canali ACCESO: parli a ${n + 1} canali insieme` : '📡 Più canali ACCESO: tocca i canali qui sotto (o «Tutti») per collegarli', 4500);
    },
    toggleAll() {
      this.cfg.tutti = !this.cfg.tutti;
      if (!this.cfg.tutti) this.cfg.canali = [];
      this.changed();
    },
    toggleCh(id) {
      if (this.cfg.tutti) {
        this.cfg.tutti = false;
        this.cfg.canali = this.eligible()
          .map((c) => c.id)
          .filter((x) => x !== id);
      } else if (this.cfg.canali.includes(id)) this.cfg.canali = this.cfg.canali.filter((x) => x !== id);
      else this.cfg.canali.push(id);
      this.changed();
    },
    toggleListen() {
      this.cfg.ascolta = !this.cfg.ascolta;
      this.changed();
      toast(this.cfg.ascolta ? '👂 Senti anche le risposte dei canali collegati' : '🔇 Non senti più i canali collegati (solo il tuo)');
    },

    render() {
      const bar = $('#dispBar');
      const show = this.allowed() && state.loggedIn;
      bar.hidden = !show;
      ui.composer();
      if (!show) return;
      bar.textContent = '';
      bar.classList.toggle('on', this.cfg.on);

      const head = el('div', 'disp-head');
      const sw = el('button', 'disp-sw' + (this.cfg.on ? ' on' : ''));
      sw.type = 'button';
      sw.title = 'Parla e ascolta su più canali insieme';
      sw.setAttribute('aria-pressed', String(this.cfg.on));
      sw.append(el('i'), el('span', null, 'Più canali'));
      sw.onclick = () => this.toggle();
      head.append(el('b', 'disp-title', '📡 CENTRALE'), sw);
      if (this.cfg.on) {
        const eco = state.channel && state.channel.eco;
        const n = this.targets().length + 1;
        head.append(el('span', 'disp-count', eco ? 'spento nel canale eco' : `${n} ${n === 1 ? 'canale' : 'canali'}`));
        const lis = el('button', 'disp-btn' + (this.cfg.ascolta ? ' on' : ''), this.cfg.ascolta ? '👂' : '🔇');
        lis.type = 'button';
        lis.title = this.cfg.ascolta ? 'Senti le risposte dei canali collegati (tocca per spegnere)' : 'NON senti i canali collegati (tocca per accendere)';
        lis.onclick = () => this.toggleListen();
        head.append(lis);
      }
      const news = el('button', 'disp-btn news', '📢 Comunicato');
      news.type = 'button';
      news.title = 'Manda una notizia, un\'allerta o un\'emergenza ai canali che scegli';
      news.onclick = () => openNews();
      head.append(news);
      bar.append(head);
      if (!this.cfg.on) return;

      const row = el('div', 'disp-chips');
      const all = el('button', 'dchip all' + (this.cfg.tutti ? ' on' : ''));
      all.type = 'button';
      all.title = 'Tutti i canali, anche quelli che verranno creati dopo';
      all.append(el('span', null, this.cfg.tutti ? '✅' : '📡'), el('span', 'dchip-name', 'Tutti'));
      all.onclick = () => this.toggleAll();
      row.append(all);
      for (const c of this.eligible()) {
        const here = !!state.channel && c.id === state.channel.id;
        const b = el('button', 'dchip' + (here || this.linked(c.id) ? ' on' : '') + (here ? ' here' : '') + (c.attivo ? ' live' : ''));
        b.type = 'button';
        b.append(el('span', null, c.icona), el('span', 'dchip-name', c.nome), el('small', null, here ? 'sei qui' : String(c.utenti)));
        b.title = here
          ? 'Il canale in cui sei: è sempre incluso'
          : `${c.nome}: ${c.utenti} ${c.utenti === 1 ? 'persona' : 'persone'}${c.attivo ? ' · qualcuno sta parlando' : ''}`;
        if (here) b.disabled = true;
        else b.onclick = () => this.toggleCh(c.id);
        row.append(b);
      }
      bar.append(row);
      row.scrollLeft = this.scroll; // i numeri si aggiornano spesso: non perdere lo scorrimento
      row.onscroll = () => (this.scroll = row.scrollLeft);
    },
  };

  function formCheck(label, checked, hint) {
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
  function formField(label, control, hint) {
    const f = el('div', 'fld');
    f.append(el('span', 'fld-label', label), control);
    if (hint) f.append(hint instanceof Node ? hint : el('small', 'fld-hint', hint));
    return f;
  }

  // Comunicato della Centrale: notizia / allerta / emergenza a uno, alcuni o tutti i canali
  function openNews() {
    if (!state.online || !disp.allowed()) return toast('Non sei collegato');
    let livello = 'info';
    const hint = el('small', 'fld-hint', LIVELLI[0][2]);
    const seg = el('div', 'seg seg-lv');
    for (const [v, label, h] of LIVELLI) {
      const b = el('button', 'lv-' + v + (v === livello ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = () => {
        livello = v;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        hint.textContent = h;
      };
      seg.append(b);
    }
    const testo = el('textarea', 'input');
    testo.rows = 3;
    testo.maxLength = 300;
    testo.placeholder = 'Cosa sta succedendo? es. Rapina in corso alla banca, servono pattuglie';
    const luogo = el('input', 'input');
    luogo.maxLength = 80;
    luogo.placeholder = 'es. Piazza Libertà (facoltativo)';

    const allCk = formCheck('📡 TUTTI i canali', disp.cfg.on && disp.cfg.tutti, 'Anche quelli creati dopo');
    const list = el('div', 'role-checks compact');
    const pre = new Set([state.channel && state.channel.id, ...disp.targetIds()]);
    for (const c of disp.eligible()) {
      const k = formCheck(`${c.icona} ${c.nome}`, pre.has(c.id), `${c.utenti} ${c.utenti === 1 ? 'persona collegata' : 'persone collegate'}`);
      k.dataset.id = c.id;
      list.append(k);
    }
    const syncAll = () => {
      list.classList.toggle('dim', allCk.cb.checked);
      list.querySelectorAll('input').forEach((i) => (i.disabled = allCk.cb.checked));
    };
    allCk.cb.onchange = syncAll;
    syncAll();
    const who = el('div', 'stack');
    who.append(allCk, list);

    const body = el('div', 'form-grid');
    body.append(formField('Tipo', seg, hint), formField('Messaggio', testo), formField('📍 Luogo', luogo), formField('A chi lo mandi', who));
    modal.open({
      title: '📢 Comunicato della Centrale',
      body,
      wide: true,
      actions: [
        { label: 'Annulla' },
        {
          label: '📢 Invia',
          cls: 'btn-primary',
          primary: true,
          onClick: () => {
            const text = testo.value.trim();
            if (!text) {
              toast('Scrivi il messaggio del comunicato');
              testo.focus();
              return false;
            }
            const tutti = allCk.cb.checked;
            const canali = [...list.querySelectorAll('.chk')].filter((x) => x.cb.checked).map((x) => x.dataset.id);
            if (!tutti && !canali.length) {
              toast('Scegli almeno un canale');
              return false;
            }
            net.send({ t: 'annuncio', livello, text, luogo: luogo.value.trim(), tutti, canali });
          },
        },
      ],
    });
    setTimeout(() => testo.focus(), 60);
  }

  // ================================================================ interfaccia
  const ui = {
    rxRaf: 0,

    showApp() {
      $('#login').hidden = true;
      $('#app').hidden = false;
      this.ptt();
      this.lcd();
    },

    status(s) {
      const n = $('#netStatus');
      n.dataset.s = s;
      n.lastElementChild.textContent = s === 'on' ? 'Online' : s === 'connecting' ? 'Connessione…' : 'Offline';
    },

    header() {
      const ch = state.channel;
      $('#chIcon').textContent = ch ? ch.icona : '📻';
      $('#chName').textContent = ch ? ch.nome : 'Nessun canale';
      this.title();
    },

    title() {
      const ch = state.channel;
      const t = rx.latest();
      if (t) document.title = `🔴 ${displayName(t.user)} — ${APP_NAME}`;
      else document.title = ch ? `${ch.nome} — ${APP_NAME}` : APP_NAME;
    },

    me() {
      const box = $('#meBox');
      box.textContent = '';
      if (!state.me) return;
      const r = roleInfo(state.me.ruolo);
      const dot = el('i');
      dot.style.background = r.colore;
      const txt = el('div');
      txt.append(el('b', null, displayName(state.me)), el('small', null, `${r.icona} ${r.nome} · @${state.me.username}`));
      box.append(dot, txt);
    },

    adminButtons() {
      const p = state.perms || {};
      const show = !!(p.founder || p.utenti || p.canali);
      $('#btnAdmin').hidden = !show;
      $('#btnAdminSide').hidden = !show;
    },

    channels() {
      const list = $('#channelList');
      list.textContent = '';
      for (const c of state.channels) {
        const active = state.channel && state.channel.id === c.id;
        const b = el('button', 'ch' + (active ? ' active' : '') + (c.attivo ? ' live' : ''));
        b.type = 'button';
        const body = el('span', 'ch-body');
        body.append(el('span', 'ch-name', c.nome), el('span', 'ch-desc', c.descrizione || ''));
        b.append(el('span', 'ch-ic', c.icona), body);
        if (!active && disp.active() && !c.eco && disp.linked(c.id)) {
          b.classList.add('linked');
          const l = el('span', 'ch-lock', '📡');
          l.title = 'Collegato: la Centrale parla e ascolta anche qui';
          b.append(l);
        }
        if (c.sos) b.append(el('span', 'ch-lock', '🚨'));
        if (c.protetto) b.append(el('span', 'ch-lock', '🔒'));
        const count = el('span', 'ch-count', String(c.utenti));
        count.title = c.attivo ? 'Qualcuno sta parlando' : 'Utenti nel canale';
        b.append(count);
        b.onclick = () => join(c.id);
        list.append(b);
      }
    },

    // Una persona collegata da più dispositivi (es. PC e telefono) compare una volta sola
    people() {
      const groups = new Map();
      for (const u of state.users.values()) {
        const key = u.uid || 'c' + u.id;
        const g = groups.get(key) || { u, n: 0, ids: [] };
        g.n++;
        g.ids.push(u.id);
        groups.set(key, g);
      }
      return [...groups.values()];
    },

    users() {
      const bar = $('#userBar');
      bar.textContent = '';
      const talking = rx.talkingIds();
      if (state.tx === 'on' || state.tx === 'stopping') talking.add(state.myId);
      const list = this.people().map((g) => ({
        u: g.u,
        n: g.n,
        talk: g.ids.some((id) => talking.has(id)),
        mine: isMine(g.u) || g.ids.includes(state.myId),
      }));
      list.sort((a, b) => b.talk - a.talk || b.mine - a.mine || String(a.u.nome).localeCompare(String(b.u.nome), 'it'));
      for (const p of list) {
        const r = roleInfo(p.u.ruolo);
        const chip = el('span', 'chip' + (p.talk ? ' talking' : '') + (p.mine ? ' me' : ''));
        chip.title = `${displayName(p.u)} — ${r.icona} ${r.nome}` + (p.n > 1 ? ` (collegato da ${p.n} dispositivi)` : '');
        const dot = el('i');
        dot.style.background = r.colore;
        chip.append(dot, el('span', null, displayName(p.u) + (p.mine ? ' (tu)' : '')));
        if (p.n > 1) chip.append(el('small', 'chip-n', '×' + p.n));
        if (p.talk) chip.append(el('span', null, '🎙️'));
        bar.append(chip);
      }
      const n = list.length;
      $('#chMeta').textContent = state.channel ? `${n} ${n === 1 ? 'persona' : 'persone'} in canale` : '';
    },

    lcd() {
      const ch = state.channel;
      let mode, top, name, sub;
      if (!state.online) {
        mode = 'off';
        top = 'SENZA SEGNALE';
        name = 'Riconnessione…';
        sub = 'Controlla la connessione internet';
      } else if (state.tx === 'pending') {
        mode = 'tx';
        const n = disp.targets().length + 1;
        top = n > 1 ? '● CENTRALE: RICHIESTA LINEA' : '● RICHIESTA CANALE';
        name = 'Attendi…';
        sub = n > 1 ? `📡 ${n} canali` : ch ? `${ch.icona} ${ch.nome}` : '';
      } else if (state.tx === 'on' || state.tx === 'stopping') {
        mode = 'tx';
        const info = state.txInfo || {};
        const people = (k) => `👂 ti ${k === 1 ? 'ascolta 1 persona' : `ascoltano ${k} persone`} in diretta`;
        if (info.canali > 1) {
          top = '● CENTRALE IN ONDA';
          name = `📡 Parli a ${info.canali} canali`;
          sub = info.ascoltatori ? people(info.ascoltatori) : '⚠️ in questi canali non c\'è nessuno';
        } else {
          top = '● IN TRASMISSIONE';
          name = 'Stai parlando';
          const others = this.people().filter((g) => !isMine(g.u)).length;
          if (ch && ch.eco) sub = '🔁 rilascia e ti risentirai';
          else if (others === 0) sub = '⚠️ nessuno nel canale ti sta ascoltando';
          else sub = people(others);
        }
      } else if (Date.now() < state.busyUntil && state.busyBy) {
        mode = 'busy';
        top = state.busyPrio ? '✖ PARLA LA CENTRALE' : '✖ CANALE OCCUPATO';
        name = displayName(state.busyBy);
        sub = state.busyPrio ? '📡 comunicazione prioritaria — aspetta che finisca' : 'sta già parlando — aspetta il tuo turno';
      } else if (rx.latest()) {
        const t = rx.latest();
        const r = roleInfo(t.user.ruolo);
        const more = rx.talks.size > 1 ? ` · +${rx.talks.size - 1}` : '';
        mode = t.prio ? 'prio' : 'rx';
        if (t.prio) top = (t.canali > 1 ? `📡 CENTRALE · ${t.canali} CANALI` : '📡 CENTRALE') + more;
        else if (t.via) top = `👂 ${t.via.icona} ${t.via.nome}` + more;
        else top = '▶ IN DIRETTA' + more;
        name = displayName(t.user);
        sub = `${r.icona} ${r.nome}` + (t.prio && t.origine && !t.eco ? ` · da ${t.origine.icona} ${t.origine.nome}` : '');
      } else if (disp.active()) {
        const n = disp.targets().length + 1;
        mode = 'idle';
        top = n > 1 ? `📡 COLLEGATO A ${n} CANALI` : '📡 CENTRALE';
        name = ch ? `${ch.icona} ${ch.nome}` : '—';
        sub = n === 1 ? 'tocca i canali qui sotto per collegarli' : disp.cfg.ascolta ? '👂 senti anche le risposte dei canali collegati' : '🔇 senti solo questo canale';
      } else {
        mode = 'idle';
        top = 'IN ASCOLTO';
        name = ch ? `${ch.icona} ${ch.nome}` : '—';
        sub = ch ? ch.descrizione || 'Canale libero' : '';
      }
      $('#lcd').dataset.mode = mode;
      $('#lcdMode').textContent = top;
      $('#lcdName').textContent = name;
      $('#lcdSub').textContent = sub;
      this.lcdTime();
      if (mode === 'rx' || mode === 'prio') this.rxMeter();
      else if (mode !== 'tx') this.meter(0);
    },

    lcdTime() {
      let t = '';
      const r = rx.latest();
      if (state.tx === 'on' || state.tx === 'stopping') {
        t = fmtDur((Date.now() - state.txStart) / 1000) + ' / ' + fmtDur(state.maxTalk);
      } else if (r && state.tx === 'idle' && state.online) {
        t = fmtDur((Date.now() - r.start) / 1000);
      } else if (state.online) {
        t = fmtTime(Date.now());
      }
      $('#lcdTime').textContent = t;
    },

    rxMeter() {
      if (this.rxRaf || !audio.analyser) return;
      const data = new Uint8Array(audio.analyser.fftSize);
      const loop = () => {
        if (!rx.talks.size || state.tx !== 'idle') {
          this.rxRaf = 0;
          return;
        }
        audio.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        this.meter(Math.sqrt(sum / data.length));
        this.rxRaf = requestAnimationFrame(loop);
      };
      this.rxRaf = requestAnimationFrame(loop);
    },

    meter(level) {
      $('#meter').style.width = Math.min(100, level * 350).toFixed(1) + '%';
    },

    busy(by, prio) {
      state.busyBy = by;
      state.busyPrio = !!prio;
      state.busyUntil = Date.now() + 2000;
      $('#ptt').dataset.state = 'busy';
      this.lcd();
      setTimeout(() => {
        this.ptt();
        this.lcd();
      }, 2050);
    },

    ptt() {
      const b = $('#ptt');
      const hold = settings.pttMode === 'hold';
      let st, label;
      if (!audio.micOk) {
        st = 'nomic';
        label = 'SOLO ASCOLTO<br>tocca per info';
      } else if (state.tx === 'pending') {
        st = 'pending';
        label = 'ATTENDI…';
      } else if (state.tx === 'on' || state.tx === 'stopping') {
        st = 'on';
        label = hold ? 'IN ONDA<br>rilascia per chiudere' : 'IN ONDA<br>premi per chiudere';
      } else {
        st = 'idle';
        const n = disp.targets().length + 1;
        const what = n > 1 ? `PARLA A ${n} CANALI` : 'PER PARLARE';
        label = (hold ? 'TIENI PREMUTO<br>' : 'PREMI<br>') + what;
      }
      if (!(b.dataset.state === 'busy' && st === 'idle' && Date.now() < state.busyUntil)) b.dataset.state = st;
      b.dataset.multi = disp.targets().length ? '1' : '';
      $('#pttLabel').innerHTML = label;
      const hint = $('#pttHint');
      hint.textContent = '';
      $('#pcKey').hidden = !(state.pcKeys > 0 && settings.tastoPc);
      if (audio.micOk && finePointer) {
        hint.append(hold ? 'Da tastiera: tieni premuto ' : 'Da tastiera: premi ', el('kbd', null, keyName(settings.pttKey)));
        if (state.pcKeys > 0 && settings.tastoPc) hint.append(' · ⌨️ tasto PC collegato (funziona anche in gioco)');
      }
    },

    speaker() {
      $('#spkIc').textContent = settings.muted ? '🔇' : '🔊';
      $('#spkLbl').textContent = settings.muted ? 'MUTO' : 'AUDIO';
      $('#btnSpeaker').classList.toggle('off', settings.muted);
    },

    audioBanner() {
      const blocked = !!audio.ctx && audio.ctx.state !== 'running' && state.loggedIn;
      $('#audioBanner').hidden = !blocked;
    },

    feedItem(m) {
      if (m.tipo === 'sistema') return el('div', 'msg msg-sistema', `${fmtTime(m.ts)} · ${m.testo}`);
      const mine = isMine(m.from);
      const lv = m.tipo === 'annuncio' ? ' lv-' + (KINDS[m.livello] ? m.livello : 'info') : '';
      const item = el('div', `msg msg-${m.tipo}${lv}` + (mine ? ' mine' : '') + (m.prio ? ' prio' : '') + (m.via ? ' via' : ''));
      if (m.id) item.dataset.id = m.id;
      const r = roleInfo(m.from.ruolo);
      const head = el('div', 'msg-head');
      const dot = el('span', 'dot');
      dot.style.background = r.colore;
      head.append(dot, el('b', null, displayName(m.from)), el('span', 'rep', `${r.icona} ${r.nome}`));
      // da dove arriva: un canale ascoltato dalla Centrale, o un messaggio mandato a più canali
      if (m.via) head.append(el('span', 'tag', `👂 dal canale ${m.via.icona} ${m.via.nome}`));
      if (m.canali > 1) head.append(el('span', 'tag prio', `📡 a ${m.canali} canali`));
      head.append(el('time', null, fmtTime(m.ts)));
      item.append(head);
      if (m.tipo === 'voce') {
        const row = el('div', 'voice');
        const btn = el('button', 'play', '▶');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Riascolta messaggio vocale');
        const wave = el('div', 'wave');
        for (let i = 0; i < 36; i++) {
          const bar = el('i');
          bar.style.height = barHeight(m.id, i) + '%';
          wave.append(bar);
        }
        row.append(btn, wave, el('span', 'dur', fmtDur(Math.max(1, m.durata))));
        btn.onclick = () => replayMsg(m, btn);
        item.append(row);
      } else if (m.tipo === 'testo') {
        item.append(el('div', 'text', m.testo));
      } else if (m.tipo === 'allerta') {
        const fromOther = state.channel && m.canale && m.canale.id !== state.channel.id;
        item.append(el('div', 'text', '🚨 ALLERTA SOS' + (fromOther ? ` (da ${m.canale.nome})` : '')));
        item.append(el('div', 'sos-pos', '📍 ' + (m.testo || 'posizione non indicata')));
      } else if (m.tipo === 'annuncio') {
        const K = KINDS[m.livello] || KINDS.info;
        item.append(el('div', 'ann-title', K.title.replace(/ 🚨$/, '') + ' · ' + canaliText(m).replace('📡 ', '')));
        item.append(el('div', 'text', m.testo));
        if (m.luogo) item.append(el('div', 'sos-pos', '📍 ' + m.luogo));
      }
      if (m.tipo === 'allerta' || m.tipo === 'annuncio') {
        item._acks = (m.presoDa || []).map((p) => p.nome);
        const taken = el('div', 'sos-taken');
        taken.hidden = !item._acks.length;
        taken.textContent = '✅ ' + item._acks.join(', ');
        item.append(taken);
      }
      return item;
    },

    /** Qualcuno ha risposto «Ricevuto» a un SOS o a un comunicato: aggiorna il messaggio in cronologia */
    addAck(id, name) {
      const item = [...$('#feed').children].find((x) => x.dataset.id === id);
      if (!item || !item._acks || item._acks.includes(name)) return;
      item._acks.push(name);
      const taken = item.querySelector('.sos-taken');
      taken.hidden = false;
      taken.textContent = '✅ ' + item._acks.join(', ');
    },

    composer() {
      const n = disp.targets().length + 1;
      $('#inText').placeholder = n > 1 ? `Scrivi a ${n} canali (Centrale)…` : 'Scrivi un messaggio al canale…';
    },

    feedReset(items) {
      const f = $('#feed');
      f.textContent = '';
      if (!items.length) f.append(el('div', 'feed-empty', '📭 Nessun messaggio recente in questo canale.\nTieni premuto il pulsante per parlare: gli altri ti sentono in diretta.'));
      for (const m of items) f.append(this.feedItem(m));
      f.scrollTop = f.scrollHeight;
    },

    feedAdd(m) {
      const f = $('#feed');
      const nearBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 90;
      const empty = f.querySelector('.feed-empty');
      if (empty) empty.remove();
      f.append(this.feedItem(m));
      while (f.children.length > 200) f.firstChild.remove();
      if (nearBottom || isMine(m.from)) f.scrollTop = f.scrollHeight;
    },

    system(text) {
      this.feedAdd({ tipo: 'sistema', testo: text, ts: Date.now() });
    },

    openDrawer() {
      $('#sidebar').classList.add('open');
      $('#scrim').classList.add('show');
    },
    closeDrawer() {
      $('#sidebar').classList.remove('open');
      $('#scrim').classList.remove('show');
    },
  };

  const modal = {
    actions: [],
    onClose: null,
    open(opts) {
      $('#modalTitle').textContent = opts.title || '';
      const body = $('#modalBody');
      body.textContent = '';
      if (typeof opts.body === 'string') body.append(el('p', null, opts.body));
      else if (opts.body) body.append(opts.body);
      const box = $('#modalActions');
      box.textContent = '';
      this.actions = opts.actions || [{ label: 'Chiudi', cls: 'btn-primary' }];
      for (const a of this.actions) {
        const b = el('button', 'btn ' + (a.cls || ''), a.label);
        b.type = 'button';
        b.onclick = () => this.run(a, b);
        box.append(b);
      }
      this.onClose = opts.onClose || null;
      $('#modal').classList.toggle('wide', !!opts.wide);
      $('#modal').hidden = false;
      $('#modalForm').scrollTop = 0; // ogni finestra parte dall'inizio
    },
    async run(a, btn) {
      if (a.onClick) {
        let r;
        try {
          if (btn) btn.disabled = true;
          r = await a.onClick();
        } catch (e) {
          toast('❌ ' + (e && e.message ? e.message : 'Errore'), 5000);
          r = false;
        } finally {
          if (btn) btn.disabled = false;
        }
        if (r === false) return;
      }
      this.close();
    },
    submit() {
      const a = this.actions.find((x) => x.primary);
      if (a) this.run(a);
    },
    close() {
      if ($('#modal').hidden) return;
      $('#modal').hidden = true;
      const f = this.onClose;
      this.onClose = null;
      if (f) f();
    },
    isOpen() {
      return !$('#modal').hidden;
    },
  };

  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = true;
    void t.offsetWidth;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 2800);
  }

  let replayBtn = null;
  async function replayMsg(m, btn) {
    if (replayBtn === btn) {
      audio.stopReplay();
      return;
    }
    if (state.tx !== 'idle' || !state.channel) return;
    if (rx.busyHere()) {
      toast('Aspetta la fine della trasmissione');
      return;
    }
    audio.stopReplay();
    replayBtn = btn;
    btn.textContent = '■';
    btn.classList.add('on');
    const chId = (m.via && m.via.id) || state.channel.id; // vocale di un canale ascoltato dalla Centrale
    try {
      await audio.replay(`/api/msg/${encodeURIComponent(chId)}/${m.id}.wav?k=${encodeURIComponent(state.key)}`);
    } catch (e) {
      toast(e && e.message === 'gone' ? 'Messaggio non più disponibile' : 'Impossibile riprodurre il messaggio');
    } finally {
      if (replayBtn === btn) replayBtn = null;
      btn.textContent = '▶';
      btn.classList.remove('on');
    }
  }

  function showMicHelp() {
    const msgs = {
      insecure:
        'Il microfono funziona solo con un indirizzo sicuro che inizia con https:// (oppure aprendo la radio sul PC del server da http://localhost). Intanto puoi ascoltare.',
      denied:
        "Il permesso del microfono è bloccato. Tocca il lucchetto 🔒 accanto all'indirizzo, metti Microfono su «Consenti» e poi premi Riprova.",
      notfound: 'Non trovo nessun microfono. Collega un microfono o delle cuffie con microfono e premi Riprova.',
      error: 'Non riesco ad attivare il microfono. Chiudi le altre app che lo stanno usando e premi Riprova.',
    };
    const actions = [{ label: 'Solo ascolto' }];
    if (audio.micError !== 'insecure') actions.push({ label: 'Riprova', cls: 'btn-primary', primary: true, onClick: () => void retryMic() });
    modal.open({ title: '🎙️ Microfono non attivo', body: msgs[audio.micError] || msgs.error, actions });
  }

  async function retryMic() {
    audio.unlock();
    const ok = await audio.initMic();
    ui.ptt();
    if (ok) toast('🎙️ Microfono attivato!');
    else setTimeout(showMicHelp, 300);
  }

  // ---------------------------------------------------------------- tasto PTT per Windows
  async function downloadPcKey() {
    const { token } = await net.request('ptt_token');
    const res = await fetch('ptt-helper.txt', { cache: 'no-store' });
    if (!res.ok) throw new Error('File del tasto non trovato sul server');
    const tpl = await res.text();
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const ascii = (s) =>
      String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/['"`$%^&|<>]/g, '');
    const text = tpl
      .split('__SERVER__').join(ascii(wsUrl))
      .split('__TOKEN__').join(ascii(token))
      .split('__NOME__').join(ascii(displayName(state.me)) || 'utente')
      .replace(/\r?\n/g, '\r\n');
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Radio-Udine-RP-Tasto.bat';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if (!settings.tastoPc) {
      settings.tastoPc = true;
      saveSettings();
      net.send({ t: 'set_remote', on: true });
    }
    const steps = el('ol', 'steps');
    for (const s of [
      'Apri il file scaricato «Radio-Udine-RP-Tasto.bat».',
      'Se Windows mostra «PC protetto da Windows», clicca «Ulteriori informazioni» e poi «Esegui comunque».',
      'Nella finestra nera premi il tasto che vuoi usare per parlare (consigliato: un tasto laterale del mouse o un tasto che il gioco non usa).',
      'Lascia aperte la finestra nera e questa radio nel browser (anche ridotta a icona).',
      'Ora tieni premuto quel tasto anche dentro al gioco: parli in radio!',
    ]) steps.append(el('li', null, s));
    const body = el('div');
    body.append(steps, el('p', 'muted small', 'Il file contiene il tuo codice personale: non condividerlo. Funziona su Windows 10 e 11.'));
    modal.open({ title: '⌨️ Tasto PTT per PC scaricato', body, actions: [{ label: 'Ho capito', cls: 'btn-primary', primary: true }] });
  }

  function changePassword() {
    const mk = (ph, ac) => {
      const i = el('input', 'input');
      i.type = 'password';
      i.placeholder = ph;
      i.autocomplete = ac;
      return i;
    };
    const old = mk('Password attuale', 'current-password');
    const nw = mk('Nuova password (almeno 6 caratteri)', 'new-password');
    const nw2 = mk('Ripeti la nuova password', 'new-password');
    const body = el('div', 'stack');
    body.append(old, nw, nw2);
    modal.open({
      title: '🔑 Cambia password',
      body,
      actions: [
        { label: 'Annulla' },
        {
          label: 'Salva',
          cls: 'btn-primary',
          primary: true,
          onClick: async () => {
            if (nw.value !== nw2.value) throw new Error('Le due password nuove non sono uguali');
            const r = await net.request('my_password', { old: old.value, password: nw.value });
            if (r.token) {
              state.token = r.token;
              store.set('token', r.token);
            }
            toast('🔑 Password cambiata');
          },
        },
      ],
    });
    setTimeout(() => old.focus(), 60);
  }

  function openSettings() {
    const wrap = el('div');
    const row = (label, control, hint) => {
      const r = el('div', 'set-row');
      const l = typeof label === 'string' ? el('span', null, label) : label;
      if (hint) l.append(el('small', null, hint));
      r.append(l, control);
      return r;
    };
    const check = (key, after) => {
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!settings[key];
      cb.onchange = () => {
        settings[key] = cb.checked;
        saveSettings();
        if (after) after(cb);
      };
      return cb;
    };
    const section = (t) => wrap.append(el('div', 'set-section', t));

    section('Audio');
    const vol = el('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1.5';
    vol.step = '0.05';
    vol.value = String(settings.volume);
    vol.oninput = () => {
      settings.volume = Number(vol.value);
      settings.muted = false;
      audio.setVolume();
      ui.speaker();
      saveSettings();
    };
    wrap.append(row('🔊 Volume', vol));
    wrap.append(row('📻 Effetto radio', check('radioFx', () => audio.applyFx()), 'Filtro e fruscio da walkie-talkie'));
    wrap.append(row('🔔 Suoni di sistema', check('beeps'), 'Beep di inizio/fine trasmissione'));
    const testBtn = el('button', 'btn', '🎙️ Prova microfono');
    testBtn.type = 'button';
    testBtn.onclick = () => micTest.run(testBtn);
    wrap.append(row('Microfono', testBtn, audio.micOk ? '✅ attivo — per la prova completa usa il canale «Prova audio»' : '❌ non attivo'));

    section('Pulsante per parlare');
    const seg = el('div', 'seg');
    for (const [v, label] of [['hold', 'Tieni premuto'], ['toggle', 'Premi 1 volta']]) {
      const b = el('button', settings.pttMode === v ? 'on' : '', label);
      b.type = 'button';
      b.onclick = () => {
        settings.pttMode = v;
        saveSettings();
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        ui.ptt();
      };
      seg.append(b);
    }
    wrap.append(row('🎙️ Modalità', seg));
    const keyBtn = el('button', 'btn', keyName(settings.pttKey));
    keyBtn.type = 'button';
    keyBtn.onclick = () => {
      keyBtn.textContent = 'Premi un tasto…';
      keyCapture = (code) => {
        if (code) {
          settings.pttKey = code;
          saveSettings();
          ui.ptt();
        }
        keyBtn.textContent = keyName(settings.pttKey);
      };
    };
    wrap.append(row('⌨️ Tasto nel browser', keyBtn, 'Funziona solo con questa finestra in primo piano'));

    const dl = el('button', 'btn btn-primary', '⬇️ Scarica');
    dl.type = 'button';
    dl.onclick = async () => {
      dl.disabled = true;
      try {
        await downloadPcKey();
      } catch (e) {
        toast('❌ ' + e.message, 5000);
      } finally {
        dl.disabled = false;
      }
    };
    wrap.append(row('🎮 Tasto PTT anche in gioco (Windows)', dl, 'Programmino per parlare tenendo premuto un tasto anche quando sei dentro al gioco'));
    wrap.append(
      row('Questo browser risponde al tasto PC', check('tastoPc', () => {
        net.send({ t: 'set_remote', on: !!settings.tastoPc });
        ui.ptt();
      }), state.pcKeys > 0 ? '⌨️ tasto collegato adesso' : 'Disattivalo sul telefono se usi il tasto sul PC')
    );

    section('Telefono e avvisi');
    if (installEvt) {
      const ib = el('button', 'btn btn-primary', '📲 Installa');
      ib.type = 'button';
      ib.onclick = () => {
        modal.close();
        installApp();
      };
      wrap.append(row('Installa la radio come app', ib, 'Icona nella schermata Home, si apre a schermo intero'));
    }
    wrap.append(row('📳 Vibrazione', check('vibrate')));
    wrap.append(
      row('💡 Schermo sempre acceso', check('wakeLock', () => (settings.wakeLock ? wake.on() : wake.off())), 'Evita che il telefono si blocchi e smetta di ricevere')
    );
    wrap.append(
      row('🚨 Notifiche SOS', check('notifiche', async (cb) => {
        if (!cb.checked) return;
        if (!('Notification' in window)) {
          toast('Questo browser non supporta le notifiche');
          cb.checked = settings.notifiche = false;
          saveSettings();
          return;
        }
        const p = await Notification.requestPermission().catch(() => 'denied');
        if (p !== 'granted') {
          toast('Notifiche bloccate dal browser');
          cb.checked = settings.notifiche = false;
          saveSettings();
        }
      }), 'Avviso sul desktop se arriva un SOS mentre la radio è in secondo piano')
    );

    section('Account');
    const u = state.me || {};
    const r = roleInfo(u.ruolo);
    const pw = el('button', 'btn', '🔑 Cambia password');
    pw.type = 'button';
    pw.onclick = () => changePassword();
    wrap.append(row(`👤 ${displayName(u)}`, pw, `@${u.username} · ${r.icona} ${r.nome}`));
    const logout = el('button', 'btn btn-danger', 'Esci');
    logout.type = 'button';
    logout.onclick = () => {
      modal.close();
      logoutNow('');
    };
    wrap.append(row('Esci dalla radio su questo dispositivo', logout));

    modal.open({
      title: '⚙️ Impostazioni',
      body: wrap,
      actions: [{ label: 'Chiudi', cls: 'btn-primary' }],
      onClose: () => (keyCapture = null),
    });
  }

  // ================================================================ schermo sempre acceso
  const wake = {
    lock: null,
    async on() {
      if (!settings.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || this.lock) return;
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => (this.lock = null));
      } catch (e) {}
    },
    off() {
      if (this.lock) {
        this.lock.release().catch(() => {});
        this.lock = null;
      }
    },
  };

  // ================================================================ accesso
  function showView(v) {
    $('#loadingBox').hidden = v !== 'loading';
    $('#loginForm').hidden = v !== 'login';
    $('#resumeForm').hidden = v !== 'resume';
    $('#setupForm').hidden = v !== 'setup';
    $('#btnRetry').hidden = v !== 'error';
    if (v === 'resume') $('#resumeName').textContent = store.get('lastName', '') || 'operatore';
    if (v === 'login') setTimeout(() => (($('#inUser').value ? $('#inPass') : $('#inUser')).focus()), 50);
  }

  function setBusy(text) {
    document.querySelectorAll('.btn-go').forEach((b) => {
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.disabled = true;
      b.textContent = text;
    });
  }

  function loginFail(msg) {
    $('#loginErr').textContent = msg || '';
    document.querySelectorAll('.btn-go').forEach((b) => {
      b.disabled = false;
      if (b.dataset.label) b.textContent = b.dataset.label;
    });
  }

  async function start(authMsg) {
    loginFail('');
    try {
      audio.unlock(); // deve avvenire subito, dentro il click
    } catch (err) {
      return loginFail('Il tuo browser non supporta l\'audio. Usa Chrome, Edge, Firefox o Safari aggiornati.');
    }
    setBusy('🎙️ Attivo il microfono…');
    await audio.initMic();
    setBusy('📡 Connessione…');
    state.pendingAuth = authMsg;
    state.loggedOut = false;
    if (state.ws) {
      const old = state.ws;
      state.ws = null;
      try {
        old.close();
      } catch (e) {}
    }
    net.connect();
    wake.on();
    ui.speaker();
  }

  function logoutNow(msg) {
    ptt.abort();
    net.close();
    rx.reset();
    audio.stopReplay();
    alarm.close();
    disp.lastMon = '';
    wake.off();
    modal.close();
    if (RadioApp.admin) RadioApp.admin.hide();
    state.loggedIn = false;
    state.channel = null;
    state.users.clear();
    state.token = null;
    store.set('token', null);
    $('#app').hidden = true;
    $('#login').hidden = false;
    ui.status('off');
    showView(state.info && state.info.setup ? 'setup' : 'login');
    loginFail(msg || '');
  }

  // ================================================================ eventi
  let keyCapture = null;
  let installEvt = null;

  async function installApp() {
    if (!installEvt) return;
    installEvt.prompt();
    try {
      await installEvt.userChoice;
    } catch (err) {}
    installEvt = null;
    $('#btnInstall').hidden = true;
  }

  function bindEvents() {
    $('#loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const username = $('#inUser').value.trim().toLowerCase();
      const password = $('#inPass').value;
      if (!username || !password) return loginFail('Scrivi nome utente e password');
      start({ t: 'login', username, password });
      $('#inPass').value = '';
    });
    $('#resumeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!state.token) return showView('login');
      start({ t: 'auth', token: state.token });
    });
    $('#btnSwitch').onclick = () => {
      state.token = null;
      store.set('token', null);
      showView('login');
    };
    $('#setupForm').addEventListener('submit', (e) => {
      e.preventDefault();
      start({
        t: 'setup',
        code: $('#suCode').value.trim(),
        username: $('#suUser').value.trim().toLowerCase(),
        password: $('#suPass').value,
        nome: $('#suNome').value.trim(),
        sigla: $('#suSigla').value.trim(),
      });
    });
    $('#btnRetry').onclick = () => boot(true);

    // Pulsante PTT (mouse e touch)
    const b = $('#ptt');
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      audio.resume();
      if (!audio.micOk) return showMicHelp();
      if (settings.pttMode === 'toggle') return ptt.toggle();
      try {
        b.setPointerCapture(e.pointerId);
      } catch (err) {}
      state.pttSource = 'pointer';
      ptt.down();
    });
    const release = () => {
      if (settings.pttMode === 'hold' && state.pttSource === 'pointer') {
        state.pttSource = null;
        ptt.up();
      }
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('lostpointercapture', release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());

    // Tastiera (solo con la finestra in primo piano: per il gioco c'è il tasto PTT per Windows)
    document.addEventListener('keydown', (e) => {
      if (keyCapture) {
        e.preventDefault();
        const f = keyCapture;
        keyCapture = null;
        f(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (modal.isOpen()) {
        if (e.key === 'Escape') modal.close();
        return;
      }
      if (!$('#sosOverlay').hidden && e.key === 'Escape') return alarm.close();
      if (RadioApp.admin && RadioApp.admin.isOpen()) {
        if (e.key === 'Escape') RadioApp.admin.hide();
        return;
      }
      if (e.key === 'Escape' && isTyping(e.target)) e.target.blur();
      if (!state.loggedIn || e.code !== settings.pttKey || isTyping(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      audio.resume();
      if (!audio.micOk) return showMicHelp();
      if (settings.pttMode === 'toggle') return ptt.toggle();
      state.pttSource = 'key';
      ptt.down();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== settings.pttKey || state.pttSource !== 'key') return;
      e.preventDefault();
      state.pttSource = null;
      ptt.up();
    });
    window.addEventListener('blur', () => {
      if (state.pttSource === 'key') {
        state.pttSource = null;
        ptt.up();
      }
    });

    // Altri pulsanti
    $('#btnMenu').onclick = () => ui.openDrawer();
    $('#chTitle').onclick = () => {
      if (window.matchMedia('(max-width: 899px)').matches) ui.openDrawer();
    };
    $('#scrim').onclick = () => ui.closeDrawer();
    $('#btnSettings').onclick = openSettings;
    const openAdmin = () => {
      ui.closeDrawer();
      if (RadioApp.admin) RadioApp.admin.show();
    };
    $('#btnAdmin').onclick = openAdmin;
    $('#btnAdminSide').onclick = openAdmin;
    $('#btnSos').onclick = openSos;
    $('#btnSpeaker').onclick = () => {
      settings.muted = !settings.muted;
      saveSettings();
      audio.resume();
      audio.setVolume();
      ui.speaker();
      toast(settings.muted ? '🔇 Audio disattivato (gli SOS suonano comunque)' : '🔊 Audio attivo');
    };
    $('#audioBanner').onclick = () => {
      audio.unlock();
      ui.audioBanner();
    };
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#inText');
      const text = input.value.trim();
      if (!text) return;
      if (!state.online || !state.channel) return toast('Non sei collegato');
      const ids = disp.targetIds(); // Centrale con "più canali": il messaggio va a tutti i canali collegati
      net.send(ids.length ? { t: 'text', text, diramazione: true, canali: ids } : { t: 'text', text });
      input.value = '';
    });

    // SOS
    $('#sosAck').onclick = () => alarm.ack();
    $('#sosRepeat').onclick = () => alarm.speak();
    $('#sosClose').onclick = () => alarm.close();

    // Finestre
    $('#modalForm').addEventListener('submit', (e) => {
      e.preventDefault();
      modal.submit();
    });
    $('#modal').addEventListener('pointerdown', (e) => {
      if (e.target === $('#modal')) modal.close();
    });

    // Qualsiasi tocco riattiva l'audio se il browser l'ha messo in pausa
    document.addEventListener('pointerdown', () => audio.resume(), true);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        wake.on();
        audio.resume();
        net.reconnectNow();
      }
    });
    window.addEventListener('online', () => net.reconnectNow());

    if ('speechSynthesis' in window) {
      pickVoice();
      speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pickVoice);
    }

    // Installazione come app
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvt = e;
      $('#btnInstall').hidden = false;
    });
    $('#btnInstall').onclick = installApp;

    // Orologio / timer del display
    setInterval(() => {
      if (state.loggedIn) ui.lcdTime();
    }, 250);
  }

  // ================================================================ avvio
  async function boot(again) {
    if (!again) bindEvents();
    showView('loading');
    loginFail('');
    let info = null;
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (r.ok) info = await r.json();
    } catch (e) {}
    state.info = info;
    if (!info) {
      showView('error');
      return loginFail('Server non raggiungibile. Se è su Render può metterci fino a un minuto a svegliarsi: riprova tra poco.');
    }
    $('#serverName').textContent = info.nome;
    $('#sideServer').textContent = info.nome;
    if (!window.isSecureContext) $('#insecureNote').hidden = false;
    if (info.errore) {
      showView('error');
      return loginFail('⚠️ ' + info.errore);
    }
    if (info.caricamento) {
      showView('loading');
      setTimeout(() => boot(true), 2000);
      return;
    }
    if (info.setup) showView('setup');
    else showView(state.token ? 'resume' : 'login');

    if (!again && 'serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    ui.speaker();
    ui.ptt();
  }

  // API usata dal pannello Founder/Staff (admin.js)
  const RadioApp = {
    el,
    toast,
    modal,
    state,
    roleInfo,
    displayName,
    fmtTime,
    request: (op, data) => net.request(op, data),
    setToken(t) {
      state.token = t;
      store.set('token', t);
    },
    onAdminDirty: null,
    onSession: null,
    admin: null,
  };
  window.RadioApp = RadioApp;
  window.__radio = { state, audio, settings, rx, disp }; // per diagnosi dalla console del browser

  boot(false);
})();
