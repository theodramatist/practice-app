// Runs on the audio thread. Collects the raw microphone samples into chunks and
// posts them to the page. It never copies the microphone to its output, so the
// microphone is never played through the speakers (spec section 8, Capture).

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.chunkFrames = opts.chunkFrames || 2048;
    this.buffer = new Float32Array(this.chunkFrames);
    this.fill = 0;
    this.chunkStartFrame = 0;
    this.expectedFrame = null;
    this.peak = 0;
    this.sumSquares = 0;
    this.gaps = 0; // times the frame counter jumped
    this.gapFrames = 0;
    this.zeroRun = 0; // length of the current run of exact zeros
    this.zeroRuns = 0; // runs of 128 or more exact zeros: a sign of inserted silence
    this.channels = 0;
    this.alive = true;
    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === 'flush') {
        this.post();
        this.port.postMessage({ type: 'flushed', frame: currentFrame });
      } else if (type === 'stop') {
        // The microphone was closed: stop for good, so an old recorder can never
        // feed samples into a take made after the microphone is opened again.
        this.alive = false;
      }
    };
  }

  post() {
    if (this.fill === 0) return;
    const samples = this.fill === this.chunkFrames ? this.buffer : this.buffer.slice(0, this.fill);
    this.port.postMessage(
      {
        type: 'chunk',
        frame: this.chunkStartFrame,
        samples,
        peak: this.peak,
        sumSquares: this.sumSquares,
        gaps: this.gaps,
        gapFrames: this.gapFrames,
        zeroRuns: this.zeroRuns,
        channels: this.channels,
      },
      [samples.buffer]
    );
    this.buffer = new Float32Array(this.chunkFrames);
    this.fill = 0;
    this.peak = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    if (!this.alive) return false;
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;
    const frames = channel ? channel.length : 128;
    this.channels = input ? input.length : 0;

    if (this.expectedFrame !== null && currentFrame !== this.expectedFrame) {
      this.gaps += 1;
      this.gapFrames += currentFrame - this.expectedFrame;
      this.post(); // keep every chunk contiguous
    }
    this.expectedFrame = currentFrame + frames;

    for (let i = 0; i < frames; i++) {
      const value = channel ? channel[i] : 0;
      if (this.fill === 0) this.chunkStartFrame = currentFrame + i;
      this.buffer[this.fill++] = value;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > this.peak) this.peak = magnitude;
      this.sumSquares += value * value;
      if (value === 0) {
        this.zeroRun += 1;
        if (this.zeroRun === 128) this.zeroRuns += 1;
      } else {
        this.zeroRun = 0;
      }
      if (this.fill === this.chunkFrames) this.post();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
