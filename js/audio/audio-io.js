// The one doorway for sound in and sound out (spec section 10, "Code shape").
//
// Every page talks to an AudioIO object and never touches getUserMedia or the
// Web Audio API directly. If the device tests fail, a native audio layer can
// replace this file by offering the same methods:
//
//   features()                       what this platform supports
//   startListening(options)          open the ONE microphone stream of the session
//   stopListening()
//   listening / sampleRate / now()   state, and the audio clock in seconds
//   describe()                       what was requested and what was actually granted
//   listInputDevices()
//   startTake() / stopTake()         record raw samples between the two calls
//   scheduleClick(time, opts)        play a click (woodblock or tick) at an exact audio-clock time
//   scheduleTone / scheduleNoise     test sounds for the device check
//   clickTemplate(accent)            the click's waveform, for finding it in a recording
//   setSessionType(type)             Safari's audio session type, where it exists
//   onEvent / onLevel / onFrames     route changes, level meter, live samples
//
// All times are seconds on the audio clock. A recorded take reports the frame
// number of its first sample, so "sample i of the take" and "click scheduled at
// time T" sit on the same clock (apart from the round-trip latency, which the
// device check measures).

const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;

export function features() {
  const nav = globalThis.navigator || {};
  return {
    audioContext: !!AudioContextClass,
    audioWorklet: !!(AudioContextClass && 'audioWorklet' in AudioContextClass.prototype),
    getUserMedia: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia),
    enumerateDevices: !!(nav.mediaDevices && nav.mediaDevices.enumerateDevices),
    outputLatency: !!(AudioContextClass && 'outputLatency' in AudioContextClass.prototype),
    baseLatency: !!(AudioContextClass && 'baseLatency' in AudioContextClass.prototype),
    audioSession: 'audioSession' in nav,
    permissionsQuery: !!(nav.permissions && nav.permissions.query),
    worker: typeof Worker !== 'undefined',
  };
}

/**
 * @param cfg the config getter
 * @param {{testInput?: boolean}} [options] testInput: use a built-in synthetic
 *   "microphone" instead of the real one (for checking the pages on a machine
 *   with no microphone; never used unless the page address asks for it).
 */
export function createAudioIO(cfg, options = {}) {
  return new WebAudioIO(cfg, options);
}

class WebAudioIO {
  constructor(cfg, options = {}) {
    this.cfg = cfg;
    this.testInput = !!options.testInput;
    this.kind = this.testInput ? 'web-audio-test-input' : 'web-audio';
    this.ctx = null;
    this.stream = null;
    this.track = null;
    this.sourceNode = null;
    this.recorderNode = null;
    this.requested = null;
    this.events = [];
    this.eventListeners = new Set();
    this.levelListeners = new Set();
    this.frameListeners = new Set();
    this.take = null;
    this.flushWaiters = [];
    this.counters = { gaps: 0, gapFrames: 0, zeroRuns: 0, channels: 0 };
    this.buffers = {};
    this.onDeviceChange = () => this.logEvent('devicechange', {});
  }

  // ---- state ---------------------------------------------------------------

  get listening() {
    return !!(this.track && this.track.readyState === 'live' && this.recorderNode);
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : null;
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  features() {
    return features();
  }

  logEvent(type, detail) {
    const entry = { at: new Date().toISOString(), audioTime: this.now(), type, detail: detail || {} };
    this.events.push(entry);
    for (const listener of this.eventListeners) listener(entry);
    return entry;
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onLevel(listener) {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  onFrames(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  // ---- output only (no microphone) ------------------------------------------

  /** Make sure there is a running audio context. Call from a tap. */
  async ensureContext() {
    if (!AudioContextClass) throw new Error('This browser has no Web Audio support.');
    if (!this.ctx) {
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      this.ctx.addEventListener('statechange', () => this.logEvent('context-state', { state: this.ctx.state }));
      // Everything the app plays goes through this one node.
      this.outputBus = this.ctx.createGain();
      this.outputBus.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (error) {
        this.logEvent('context-resume-failed', { error: String(error) });
      }
    }
    return this.ctx;
  }

  setSessionType(type) {
    const session = globalThis.navigator && navigator.audioSession;
    if (!session) return { supported: false, type: null };
    try {
      session.type = type;
      this.logEvent('audio-session-type', { asked: type, now: session.type });
      return { supported: true, type: session.type };
    } catch (error) {
      this.logEvent('audio-session-type-failed', { asked: type, error: String(error) });
      return { supported: true, type: session.type, error: String(error) };
    }
  }

  // ---- microphone -----------------------------------------------------------

  /**
   * Open the microphone. Call from a tap ("Start listening").
   * Processing is requested off unless the caller overrides it (the device
   * check does, to compare settings).
   */
  async startListening(options = {}) {
    const cfg = this.cfg;
    if (!this.testInput && !features().getUserMedia) throw new Error('This browser cannot open the microphone.');
    if (!features().audioWorklet) throw new Error('This browser has no AudioWorklet support.');
    if (this.stream) await this.stopListening();

    // Create and resume the context first, while we are still inside the tap.
    const ctxReady = this.ensureContext();
    if (options.sessionType) this.setSessionType(options.sessionType);

    const audio = {
      echoCancellation: options.echoCancellation ?? cfg('capture.echoCancellation'),
      noiseSuppression: options.noiseSuppression ?? cfg('capture.noiseSuppression'),
      autoGainControl: options.autoGainControl ?? cfg('capture.autoGainControl'),
      channelCount: cfg('capture.channelCount'),
    };
    if (options.deviceId) audio.deviceId = { exact: options.deviceId };
    this.requested = { ...audio, deviceId: options.deviceId || null };

    const askedAt = performance.now();
    if (this.testInput) {
      await ctxReady;
      this.stream = this.makeTestStream();
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    const waitedMs = performance.now() - askedAt;
    await ctxReady;

    this.track = this.stream.getAudioTracks()[0];
    this.track.addEventListener('ended', () => this.logEvent('track-ended', {}));
    this.track.addEventListener('mute', () => this.logEvent('track-muted', {}));
    this.track.addEventListener('unmute', () => this.logEvent('track-unmuted', {}));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    }

    if (!this.workletLoaded) {
      await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this.workletLoaded = true;
    }
    this.counters = { gaps: 0, gapFrames: 0, zeroRuns: 0, channels: 0 }; // each recorder counts from zero
    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.recorderNode = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { chunkFrames: cfg('capture.chunkFrames') },
    });
    this.recorderNode.port.onmessage = (event) => this.handleWorkletMessage(event.data);
    this.sourceNode.connect(this.recorderNode);
    // The recorder outputs silence. Connecting it keeps it running in Safari.
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.recorderNode.connect(this.silentGain).connect(this.ctx.destination);

    if (this.ctx.state !== 'running') await this.ensureContext();
    const info = this.describe();
    this.logEvent('listening-started', { permissionWaitMs: Math.round(waitedMs), granted: info.granted, label: info.trackLabel });
    return { ...info, permissionWaitMs: Math.round(waitedMs) };
  }

  async stopListening() {
    if (this.take) this.take = null;
    try {
      if (this.recorderNode) {
        // Silence the old recorder completely before anything new is opened.
        this.recorderNode.port.onmessage = null;
        this.recorderNode.port.postMessage({ type: 'stop' });
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.recorderNode) this.recorderNode.disconnect();
      if (this.silentGain) this.silentGain.disconnect();
    } catch (error) {
      // already disconnected
    }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.testNodes) {
      try {
        this.testNodes.source.stop();
        this.testNodes.source.disconnect();
        this.outputBus.disconnect(this.testNodes.delay);
        this.testNodes.delay.disconnect();
      } catch (error) {
        // already torn down
      }
      this.testNodes = null;
    }
    this.sourceNode = null;
    this.recorderNode = null;
    this.silentGain = null;
    this.stream = null;
    this.track = null;
    this.logEvent('listening-stopped', {});
  }

  /** What was asked for and what the device actually gave. */
  describe() {
    const track = this.track;
    const ctx = this.ctx;
    const safe = (fn) => {
      try {
        return fn();
      } catch (error) {
        return null;
      }
    };
    return {
      kind: this.kind,
      requested: this.requested,
      granted: track ? safe(() => track.getSettings()) : null,
      capabilities: track && track.getCapabilities ? safe(() => track.getCapabilities()) : null,
      appliedConstraints: track && track.getConstraints ? safe(() => track.getConstraints()) : null,
      supportedConstraints: safe(() => navigator.mediaDevices.getSupportedConstraints()),
      trackLabel: track ? track.label : null,
      trackState: track ? track.readyState : null,
      trackMuted: track ? track.muted : null,
      inputChannels: this.counters.channels,
      sampleRate: ctx ? ctx.sampleRate : null,
      baseLatency: ctx && typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatency: ctx && typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      contextState: ctx ? ctx.state : null,
      audioSessionType: navigator.audioSession ? navigator.audioSession.type : null,
    };
  }

  async listInputDevices() {
    if (!features().enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
      .map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }));
  }

  handleWorkletMessage(message) {
    if (message.type === 'chunk') {
      this.counters.gaps = message.gaps;
      this.counters.gapFrames = message.gapFrames;
      this.counters.zeroRuns = message.zeroRuns;
      this.counters.channels = message.channels;
      if (this.take) this.take.chunks.push(message);
      const frames = message.samples.length;
      const level = { frame: message.frame, peak: message.peak, rms: Math.sqrt(message.sumSquares / Math.max(1, frames)) };
      for (const listener of this.levelListeners) listener(level);
      for (const listener of this.frameListeners) listener(message.samples, message.frame, this.ctx.sampleRate);
    } else if (message.type === 'flushed') {
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      for (const resolve of waiters) resolve(message.frame);
    }
  }

  /**
   * A synthetic "microphone" for checking the pages without a real one: a
   * plucked G chord every two seconds, a little noise, and the app's own
   * output fed back with a 50 ms delay (so click loopback has something to find).
   */
  makeTestStream() {
    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const destination = ctx.createMediaStreamDestination();
    const length = Math.round(2 * sampleRate);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const notes = [196.0, 293.66, 493.88, 783.99]; // G chord 0-0-2-3
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      let value = (Math.random() * 2 - 1) * 0.0005;
      notes.forEach((f0, course) => {
        const start = 0.5 + course * 0.006;
        if (t < start) return;
        const age = t - start;
        for (let h = 1; h <= 5; h++) {
          value += (0.05 / h) * Math.exp(-age * (3 + h)) * Math.sin(2 * Math.PI * f0 * h * age);
        }
      });
      data[i] = value;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(destination);
    source.start();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.05;
    this.outputBus.connect(delay).connect(destination);
    this.testNodes = { source, delay, destination };
    return destination.stream;
  }

  // ---- takes ----------------------------------------------------------------

  /** Start keeping samples. The take begins with the next chunk that arrives. */
  startTake() {
    if (!this.listening) throw new Error('The microphone is not open.');
    this.take = {
      chunks: [],
      wallStart: performance.now(),
      audioStart: this.now(),
      countersAtStart: { ...this.counters },
    };
    return { audioStart: this.take.audioStart };
  }

  /** Stop keeping samples and hand back the whole take. */
  async stopTake() {
    const take = this.take;
    if (!take) throw new Error('No take is being recorded.');
    // Ask the audio thread for whatever it is still holding.
    await new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.recorderNode.port.postMessage({ type: 'flush' });
      setTimeout(resolve, 500); // never hang if the audio thread has stopped
    });
    this.take = null;
    const wallMs = performance.now() - take.wallStart;
    const audioMs = (this.now() - take.audioStart) * 1000;

    let total = 0;
    for (const chunk of take.chunks) total += chunk.samples.length;
    const samples = new Float32Array(total);
    let at = 0;
    let peak = 0;
    let clipped = 0;
    const clipLevel = this.cfg('capture.clipLevel');
    for (const chunk of take.chunks) {
      samples.set(chunk.samples, at);
      at += chunk.samples.length;
    }
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= clipLevel) clipped += 1;
    }
    const sampleRate = this.ctx.sampleRate;
    const startFrame = take.chunks.length ? take.chunks[0].frame : Math.round(take.audioStart * sampleRate);
    return {
      samples,
      sampleRate,
      startFrame,
      startTime: startFrame / sampleRate,
      durationSec: samples.length / sampleRate,
      peak,
      clipped,
      gaps: this.counters.gaps - take.countersAtStart.gaps,
      gapFrames: this.counters.gapFrames - take.countersAtStart.gapFrames,
      zeroRuns: this.counters.zeroRuns - take.countersAtStart.zeroRuns,
      wallMinusAudioMs: Math.round(wallMs - audioMs),
    };
  }

  cancelTake() {
    this.take = null;
  }

  // ---- playback ---------------------------------------------------------------

  /** A short sine burst with a smooth (Hann) envelope. */
  makeBurst(frequencyHz, durationMs) {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(8, Math.round((durationMs / 1000) * sampleRate));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
      data[i] = envelope * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    }
    return buffer;
  }

  /**
   * A woodblock-like click: two quickly dying partials with a fast attack.
   * No random part, so the same waveform can be searched for in a recording.
   */
  makeWoodblock(frequencyHz) {
    const cfg = this.cfg;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(8, Math.round((cfg('metronome.woodblockDurationMs') / 1000) * sampleRate));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const decay = cfg('metronome.woodblockDecayMs') / 1000;
    const ratio = cfg('metronome.woodblockOvertoneRatio');
    const level = cfg('metronome.woodblockOvertoneLevel');
    const fade = Math.round(0.01 * sampleRate);
    let peak = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const attack = 1 - Math.exp(-t / 0.0004);
      const tail = Math.min(1, (length - 1 - i) / fade);
      data[i] = attack * tail * (
        Math.exp(-t / decay) * Math.sin(2 * Math.PI * frequencyHz * t)
        + level * Math.exp(-t / (decay * 0.5)) * Math.sin(2 * Math.PI * frequencyHz * ratio * t)
      );
      peak = Math.max(peak, Math.abs(data[i]));
    }
    for (let i = 0; i < length; i++) data[i] /= peak || 1;
    return buffer;
  }

  /** The buffer for one click. sound: 'woodblock' or 'tick'; default is the config's choice. */
  clickBuffer(accent, sound) {
    const kind = sound || this.cfg('metronome.sound');
    const key = `${kind}:${accent ? 'accent' : 'beat'}`;
    if (!this.buffers[key] || this.buffers[key].sampleRate !== this.ctx.sampleRate) {
      if (kind === 'tick') {
        const frequency = this.cfg(accent ? 'metronome.accentFrequencyHz' : 'metronome.clickFrequencyHz');
        this.buffers[key] = this.makeBurst(frequency, this.cfg('metronome.clickDurationMs'));
      } else {
        this.buffers[key] = this.makeWoodblock(this.cfg(accent ? 'metronome.woodblockAccentHz' : 'metronome.woodblockHz'));
      }
    }
    return this.buffers[key];
  }

  /** The click's waveform as plain samples (for matched filtering). */
  clickTemplate(accent = false, sound = null) {
    return this.clickBuffer(accent, sound).getChannelData(0).slice();
  }

  playBuffer(buffer, time, gain) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = gain;
    source.connect(gainNode).connect(this.outputBus);
    source.start(Math.max(time, 0));
    return source;
  }

  /** Play one metronome click at an exact audio-clock time. */
  scheduleClick(time, options = {}) {
    const gain = options.gain ?? this.cfg('metronome.clickGainSpeaker');
    if (gain <= 0) return null;
    return this.playBuffer(this.clickBuffer(!!options.accent, options.sound), time, gain);
  }

  /** Steady test tone with short fades (device check). */
  scheduleTone(time, { frequencyHz = 1000, durationSec = 1, gain = 0.2 } = {}) {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = frequencyHz;
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(gain, time + 0.02);
    gainNode.gain.setValueAtTime(gain, time + durationSec - 0.02);
    gainNode.gain.linearRampToValueAtTime(0, time + durationSec);
    osc.connect(gainNode).connect(this.outputBus);
    osc.start(time);
    osc.stop(time + durationSec + 0.01);
    return osc;
  }

  /** White-noise burst (device check: shows whether the highs survive playback). */
  scheduleNoise(time, { durationSec = 0.5, gain = 0.1 } = {}) {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.round(durationSec * sampleRate);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const fade = Math.round(0.01 * sampleRate);
    for (let i = 0; i < length; i++) {
      const edge = Math.min(1, i / fade, (length - 1 - i) / fade);
      data[i] = (Math.random() * 2 - 1) * edge;
    }
    return this.playBuffer(buffer, time, gain);
  }
}
