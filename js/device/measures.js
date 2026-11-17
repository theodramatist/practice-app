// Measurements for the "click and tone with the microphone open" check:
// how loud and how clean the app's own test sounds come back through the
// microphone. Pure functions, no browser APIs, so they run under Node for tests.

import { powerSpectrum, bandPower, powerDb, amplitudeDb } from './dsp.js';

/** Peak and RMS level of a stretch of a recording, in dB relative to full scale. */
export function levelBetween(samples, sampleRate, startSec, endSec) {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  let peak = 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
    sum += samples[i] * samples[i];
  }
  const count = Math.max(1, end - start);
  return { peakDb: amplitudeDb(peak), rmsDb: powerDb(sum / count), samples: Math.max(0, end - start) };
}

/**
 * How loud and how pure a steady test tone is in the recording.
 *
 * "Purity" compares the energy at the tone itself with everything else between
 * `lowHz` and `highHz`. A clean tone scores high (tens of dB). Crackle,
 * distortion or a lot of room noise pull the number down.
 *
 * @returns {{toneDb: number|null, restDb: number|null, purityDb: number|null}}
 */
export function toneMeasures(samples, sampleRate, startSec, endSec, toneHz, options = {}) {
  const bandPct = options.bandPct ?? 3;
  const lowHz = options.lowHz ?? 100;
  const highHz = Math.min(options.highHz ?? 10000, sampleRate * 0.45);
  const start = Math.floor(startSec * sampleRate);
  const length = Math.floor((endSec - startSec) * sampleRate);
  const spectrum = powerSpectrum(samples, sampleRate, start, length);
  if (!spectrum) return { toneDb: null, restDb: null, purityDb: null };
  // The band is at least a few bins wide so the window's own spread stays inside it.
  const halfWidth = Math.max((toneHz * bandPct) / 100, 4 * spectrum.binHz);
  const tone = bandPower(spectrum, toneHz - halfWidth, toneHz + halfWidth);
  const all = bandPower(spectrum, lowHz, highHz);
  const rest = Math.max(0, all - tone);
  const toneDb = powerDb(tone);
  const restDb = powerDb(rest);
  return {
    toneDb,
    restDb,
    purityDb: toneDb !== null && restDb !== null ? toneDb - restDb : null,
  };
}

/**
 * Whether the highs of a white-noise burst survive the trip through the
 * speaker and microphone. White noise has the same energy in every hertz, so
 * the result compares energy per hertz above `highLowHz` with energy per hertz
 * in the middle band. Near 0 dB means the highs are intact; a large negative
 * number means they are missing, as happens when playback drops to a low
 * sample rate.
 *
 * @returns {{highDb: number|null, midDb: number|null, tiltDb: number|null, highTopHz: number}}
 */
export function noiseTilt(samples, sampleRate, startSec, endSec, options = {}) {
  const midLowHz = options.midLowHz ?? 1000;
  const midHighHz = options.midHighHz ?? 4000;
  const highLowHz = options.highLowHz ?? 8000;
  const highTopHz = Math.min(options.highTopHz ?? 16000, sampleRate * 0.45);
  const start = Math.floor(startSec * sampleRate);
  const length = Math.floor((endSec - startSec) * sampleRate);
  const spectrum = powerSpectrum(samples, sampleRate, start, length);
  if (!spectrum || highTopHz <= highLowHz) return { highDb: null, midDb: null, tiltDb: null, highTopHz };
  const mid = bandPower(spectrum, midLowHz, midHighHz) / (midHighHz - midLowHz);
  const high = bandPower(spectrum, highLowHz, highTopHz) / (highTopHz - highLowHz);
  const midDb = powerDb(mid);
  const highDb = powerDb(high);
  return { highDb, midDb, tiltDb: midDb !== null && highDb !== null ? highDb - midDb : null, highTopHz };
}
