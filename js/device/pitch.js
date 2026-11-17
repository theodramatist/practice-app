// Pitch readout for the tuner-accuracy check: the McLeod pitch method, written
// by hand. Pure functions, no browser APIs, so they run under Node for tests.
//
// In plain words: the method slides a copy of the sound along itself and asks
// "at what shift does it line up with itself again?" That shift is one cycle
// of the note. "Clarity" (0 to 1) says how well it lined up: a clean single
// note is near 1; a chord, a noise or two strings beating score lower.
//
// This is only a readout for comparing with a hardware tuner. It is not the
// app's tuner (no coaching, no beating indicator).

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/**
 * @param {Float32Array|Float64Array} samples  one window of sound
 * @param {number} sampleRate
 * @param {{minHz?: number, maxHz?: number, peakPick?: number}} [options]
 * @returns {{frequencyHz: number|null, clarity: number}}
 */
export function detectPitch(samples, sampleRate, options = {}) {
  const minHz = options.minHz ?? 70;
  const maxHz = options.maxHz ?? 1500;
  const peakPick = options.peakPick ?? 0.93;
  const n = samples.length;
  const maxLag = Math.min(n >> 1, Math.ceil(sampleRate / minHz) + 2);
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxLag <= minLag + 2) return { frequencyHz: null, clarity: 0 };

  // Normalised square difference function: +1 = lines up perfectly.
  const nsdf = new Float64Array(maxLag + 1);
  let total = 0;
  for (let i = 0; i < n; i++) total += samples[i] * samples[i];
  if (!(total > 0)) return { frequencyHz: null, clarity: 0 };
  // m(lag) = sum of squares of the two overlapping stretches; kept up to date
  // by removing the samples that drop out of the overlap as the lag grows.
  let m = 2 * total;
  for (let lag = 0; lag <= maxLag; lag++) {
    if (lag > 0) m -= samples[lag - 1] * samples[lag - 1] + samples[n - lag] * samples[n - lag];
    let r = 0;
    for (let i = 0, end = n - lag; i < end; i++) r += samples[i] * samples[i + lag];
    nsdf[lag] = m > 0 ? (2 * r) / m : 0;
  }

  // The highest point of each positive hump after the first downward crossing.
  const humps = [];
  let lag = 1;
  while (lag <= maxLag && nsdf[lag] > 0) lag++; // skip the hump around lag 0
  while (lag <= maxLag) {
    while (lag <= maxLag && nsdf[lag] <= 0) lag++;
    let best = -1;
    while (lag <= maxLag && nsdf[lag] > 0) {
      if (best < 0 || nsdf[lag] > nsdf[best]) best = lag;
      lag++;
    }
    // A hump still rising at the end of the search range is not a real peak.
    if (best >= minLag && best < maxLag) humps.push(best);
  }
  if (!humps.length) return { frequencyHz: null, clarity: 0 };

  // Refine each hump's top with a parabola through its three highest points.
  const refined = humps.map((index) => {
    const a = nsdf[index - 1];
    const b = nsdf[index];
    const c = nsdf[Math.min(maxLag, index + 1)];
    const curve = a - 2 * b + c;
    const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve)) : 0;
    return { lag: index + shift, value: b - 0.25 * (a - c) * shift };
  });
  const highest = Math.max(...refined.map((p) => p.value));
  // Take the FIRST hump that is nearly as high as the highest: this picks the
  // true cycle and not a multiple of it.
  const chosen = refined.find((p) => p.value >= peakPick * highest);
  if (!chosen || !(chosen.lag > 0)) return { frequencyHz: null, clarity: 0 };
  const frequencyHz = sampleRate / chosen.lag;
  if (frequencyHz < minHz || frequencyHz > maxHz) return { frequencyHz: null, clarity: 0 };
  return { frequencyHz, clarity: Math.max(0, Math.min(1, chosen.value)) };
}

/** The nearest equal-tempered note, and how many cents sharp (+) or flat (−) the pitch is. */
export function nearestNote(frequencyHz, referenceA4Hz = 440) {
  const exact = 69 + 12 * Math.log2(frequencyHz / referenceA4Hz);
  const midi = Math.round(exact);
  const octave = Math.floor(midi / 12) - 1;
  return {
    midi,
    name: `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`,
    cents: (exact - midi) * 100,
    noteHz: referenceA4Hz * Math.pow(2, (midi - 69) / 12),
  };
}

/** Cents between a measured pitch and a target pitch (+ = sharp). */
export function centsBetween(frequencyHz, targetHz) {
  return 1200 * Math.log2(frequencyHz / targetHz);
}

/** The pitch an open string should have, from its MIDI note number. */
export function midiToHz(midi, referenceA4Hz = 440) {
  return referenceA4Hz * Math.pow(2, (midi - 69) / 12);
}
