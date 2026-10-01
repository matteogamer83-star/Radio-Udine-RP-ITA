/*
 * Cattura del microfono (gira nel thread audio del browser).
 * Converte l'audio del microfono (44.1/48 kHz, float) in PCM 16 bit a 16 kHz
 * e lo spedisce all'app a pacchetti da 40 ms.
 */
class MicCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / target;
    this.frame = Math.round(target * 0.04);
    this.active = false;
    this.sid = 0;
    this.reset();
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.cmd === 'start') {
        this.reset();
        this.sid = msg.sid;
        this.active = true;
      } else if (msg.cmd === 'stop') {
        if (this.active && msg.sid === this.sid) {
          this.flush(true);
          this.active = false;
        } else {
          this.port.postMessage({ sid: msg.sid, final: true });
        }
      }
    };
  }

  reset() {
    this.out = new Int16Array(this.frame);
    this.n = 0;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
    this.sumSq = 0;
  }

  flush(final) {
    if (this.n > 0) {
      const pcm = this.out.slice(0, this.n).buffer;
      const level = Math.sqrt(this.sumSq / this.n);
      this.port.postMessage({ sid: this.sid, pcm, level, final: !!final }, [pcm]);
    } else if (final) {
      this.port.postMessage({ sid: this.sid, final: true });
    }
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    if (!this.active) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // ricampionamento con media (filtro anti-aliasing semplice)
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
        if (this.n === this.frame) this.flush(false);
      }
    }
    return true;
  }
}

registerProcessor('mic-capture', MicCapture);
