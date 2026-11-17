// Metronome: clicks are scheduled ahead on the audio clock (spec section 8).
// A timer wakes this scheduler every 25 ms or so; each time, every click that
// falls inside the next 100 ms is handed to the audio system with its exact
// time. Clicks already handed over keep their timing even if the page stalls.
// Every click time is kept in `log`, so a recording can be compared with it.

/** Pure helper: the audio-clock time of beat n. No drift: always t0 + n * interval. */
export function beatTime(t0, bpm, n) {
  return t0 + (n * 60) / bpm;
}

export class Metronome {
  /**
   * @param io  an AudioIO (see audio-io.js)
   * @param cfg the config getter
   */
  constructor(io, cfg) {
    this.io = io;
    this.cfg = cfg;
    this.running = false;
    this.log = [];
    this.worker = null;
    this.fallbackTimer = null;
    this.rafId = null;
  }

  /**
   * @param {object} o
   * @param {number} o.bpm
   * @param {number} [o.beatsPerBar=4]
   * @param {boolean} [o.audible=true]   false = visual pulse only (times are still logged)
   * @param {number} [o.gain]            click loudness
   * @param {string} [o.sound]           'woodblock' or 'tick'; default is the config's choice
   * @param {number} [o.startDelaySec=0.4]
   * @param {number|null} [o.totalBeats] stop by itself after this many beats
   * @param {(beat: object) => void} [o.onBeat]  called on screen when a beat arrives
   * @param {() => void} [o.onDone]      called after the last beat has sounded
   */
  start(o) {
    this.stop();
    this.options = {
      beatsPerBar: 4,
      audible: true,
      startDelaySec: 0.4,
      totalBeats: null,
      gain: this.cfg('metronome.clickGainSpeaker'),
      ...o,
    };
    this.t0 = this.io.now() + this.options.startDelaySec;
    this.nextBeat = 0;
    this.log = [];
    this.pendingVisual = [];
    this.running = true;
    this.finished = false;
    this.timerKind = 'worker';

    const intervalMs = this.cfg('metronome.timerMs');
    try {
      this.worker = new Worker(new URL('./metronome-worker.js', import.meta.url));
      this.worker.onmessage = () => this.tick();
      this.worker.onerror = () => this.useFallbackTimer(intervalMs);
      this.worker.postMessage({ type: 'start', intervalMs });
    } catch (error) {
      this.useFallbackTimer(intervalMs);
    }
    this.tick();
    const frame = () => {
      if (!this.running) return;
      this.showDueBeats();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
    return { t0: this.t0 };
  }

  useFallbackTimer(intervalMs) {
    if (this.fallbackTimer) return;
    this.timerKind = 'page-timer';
    this.fallbackTimer = setInterval(() => this.tick(), intervalMs);
  }

  /** Schedule every beat that falls inside the look-ahead window. */
  tick() {
    if (!this.running || this.finished) return;
    const o = this.options;
    const now = this.io.now();
    const horizon = now + this.cfg('metronome.lookaheadMs') / 1000;
    while (beatTime(this.t0, o.bpm, this.nextBeat) < horizon) {
      const n = this.nextBeat;
      const time = beatTime(this.t0, o.bpm, n);
      const accent = n % o.beatsPerBar === 0;
      const lateByMs = time < now ? Math.round((now - time) * 1000) : 0;
      if (o.audible) this.io.scheduleClick(time, { accent, gain: o.gain, sound: o.sound });
      const entry = { beat: n, time, accent, audible: !!o.audible, lateByMs };
      this.log.push(entry);
      this.pendingVisual.push(entry);
      this.nextBeat = n + 1;
      if (o.totalBeats !== null && this.nextBeat >= o.totalBeats) {
        this.finished = true;
        break;
      }
    }
  }

  /** Called every animation frame: flash for beats whose time has come. */
  showDueBeats() {
    const now = this.io.now();
    while (this.pendingVisual.length && this.pendingVisual[0].time <= now) {
      const beat = this.pendingVisual.shift();
      if (this.options.onBeat) this.options.onBeat(beat);
    }
    if (this.finished && this.pendingVisual.length === 0 && !this.doneCalled) {
      this.doneCalled = true;
      if (this.options.onDone) this.options.onDone();
    }
  }

  stop() {
    this.running = false;
    this.doneCalled = false;
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    return this.log;
  }
}
