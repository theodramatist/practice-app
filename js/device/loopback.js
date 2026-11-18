// Finding the app's own clicks in a recording (device check: round-trip
// latency, click loudness, and whether the metronome holds its tempo).
// Pure functions, no browser APIs, so the same code runs under Node for tests.
//
// The idea: the page knows the exact audio-clock time it scheduled each click
// for, and it knows the click's waveform. Sliding that waveform along the
// recording and measuring how well it lines up (a matched filter) gives a sharp
// peak where the click was heard. Heard time minus scheduled time is the
// round-trip delay: out through the speaker, back in through the microphone.

import { fft, nextPow2, median, medianAbsoluteDeviation } from './dsp.js';

/**
 * How strongly the template lines up with the segment at each starting sample.
 * The result is the smooth envelope of the match (no ripple at the click's own
 * frequency), scaled so that a copy of the template at amplitude `a` gives a
 * peak of `a`.
 *
 * @param {Float32Array|Float64Array} segment
 * @param {Float32Array|Float64Array} template
 * @returns {Float64Array} one value per possible start (segment.length - template.length + 1)
 */
export function matchEnvelope(segment, template) {
  const valid = segment.length - template.length + 1;
  if (valid < 1) return new Float64Array(0);
  const size = nextPow2(segment.length + template.length);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(segment);
  bRe.set(template);
  let energy = 0;
  for (let i = 0; i < template.length; i++) energy += template[i] * template[i];
  if (!(energy > 0)) return new Float64Array(valid);

  fft(aRe, aIm);
  fft(bRe, bIm);
  // Cross-correlation is A times the conjugate of B. Keeping only the positive
  // frequencies (doubled) turns the result into its envelope.
  const half = size >> 1;
  for (let k = 0; k < size; k++) {
    const re = aRe[k] * bRe[k] + aIm[k] * bIm[k];
    const im = aIm[k] * bRe[k] - aRe[k] * bIm[k];
    const weight = k === 0 || k === half ? 1 : k < half ? 2 : 0;
    aRe[k] = re * weight;
    aIm[k] = im * weight;
  }
  fft(aRe, aIm, true);
  const out = new Float64Array(valid);
  for (let i = 0; i < valid; i++) out[i] = Math.hypot(aRe[i], aIm[i]) / energy;
  return out;
}

/**
 * Look for one click near the time it was scheduled for.
 *
 * @param {Float32Array} recording   the take's samples
 * @param {number} sampleRate
 * @param {Float32Array} template    the click's waveform
 * @param {number} expectedSec       scheduled time, in seconds from the take's first sample
 * @param {{searchBeforeSec?: number, searchAfterSec?: number, minRatio?: number}} [options]
 * @returns {{found: boolean, reason?: string, arrivalSec?: number, delaySec?: number,
 *            amplitude?: number, background?: number, ratio?: number}}
 */
export function findClick(recording, sampleRate, template, expectedSec, options = {}) {
  const before = options.searchBeforeSec ?? 0.02;
  const after = options.searchAfterSec ?? 0.4;
  const minRatio = options.minRatio ?? 8;
  const start = Math.max(0, Math.floor((expectedSec - before) * sampleRate));
  const end = Math.min(recording.length, Math.ceil((expectedSec + after) * sampleRate) + template.length);
  if (end - start < template.length * 2) return { found: false, reason: 'outside the recording' };

  const envelope = matchEnvelope(recording.subarray(start, end), template);
  let peakIndex = 0;
  for (let i = 1; i < envelope.length; i++) if (envelope[i] > envelope[peakIndex]) peakIndex = i;
  const amplitude = envelope[peakIndex];

  // Background: the typical match strength away from the peak.
  const guard = template.length;
  const rest = [];
  for (let i = 0; i < envelope.length; i++) if (Math.abs(i - peakIndex) > guard) rest.push(envelope[i]);
  const background = rest.length ? median(rest) : 0;
  const ratio = background > 0 ? amplitude / background : amplitude > 0 ? Infinity : 0;

  // Fit a parabola through the peak and its neighbours for a finer time.
  let shift = 0;
  if (peakIndex > 0 && peakIndex < envelope.length - 1) {
    const a = envelope[peakIndex - 1];
    const b = envelope[peakIndex];
    const c = envelope[peakIndex + 1];
    const curve = a - 2 * b + c;
    if (curve < 0) shift = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve));
  }
  const arrivalSec = (start + peakIndex + shift) / sampleRate;
  const found = amplitude > 0 && ratio >= minRatio;
  return {
    found,
    reason: found ? undefined : 'no clear click in the recording',
    arrivalSec,
    delaySec: arrivalSec - expectedSec,
    amplitude,
    background,
    ratio: Number.isFinite(ratio) ? ratio : null,
  };
}

/** Middle value, range and spread of a list of delays (any unit). */
export function summariseDelays(values) {
  if (!values.length) return { n: 0, median: null, min: null, max: null, range: null, mad: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { n: values.length, median: median(values), min, max, range: max - min, mad: medianAbsoluteDeviation(values) };
}

/**
 * How far the heard click spacing strays from the nominal spacing.
 * Only pairs of neighbouring beats that were both found are compared.
 *
 * @param {{beat: number, arrivalSec: number}[]} heard
 * @param {number} bpm
 */
export function spacingDeviation(heard, bpm) {
  const nominal = 60 / bpm;
  const sorted = heard.slice().sort((a, b) => a.beat - b.beat);
  const deviationsMs = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].beat - sorted[i - 1].beat !== 1) continue;
    deviationsMs.push((sorted[i].arrivalSec - sorted[i - 1].arrivalSec - nominal) * 1000);
  }
  if (!deviationsMs.length) return { pairs: 0, worstMs: null, meanAbsMs: null };
  const abs = deviationsMs.map(Math.abs);
  return {
    pairs: deviationsMs.length,
    worstMs: Math.max(...abs),
    meanAbsMs: abs.reduce((sum, v) => sum + v, 0) / abs.length,
  };
}

/**
 * Find every scheduled click in a take and sum up the result.
 *
 * @param {object} o
 * @param {Float32Array} o.samples        the take
 * @param {number} o.sampleRate
 * @param {number} o.takeStartTime        audio-clock time of the take's first sample
 * @param {{beat: number, time: number, accent: boolean, lateByMs?: number}[]} o.clicks  the scheduler's log
 * @param {{normal: Float32Array, accent: Float32Array}} o.templates
 * @param {number} [o.bpm]                if given, spacing is checked against it
 * @param {number} [o.searchAfterSec]
 * @param {number} [o.minRatio]
 */
export function analyseLoopback(o) {
  const perClick = [];
  for (const click of o.clicks) {
    const template = click.accent ? o.templates.accent : o.templates.normal;
    const expectedSec = click.time - o.takeStartTime;
    const hit = findClick(o.samples, o.sampleRate, template, expectedSec, {
      searchBeforeSec: o.searchBeforeSec,
      searchAfterSec: o.searchAfterSec,
      minRatio: o.minRatio,
    });
    perClick.push({
      beat: click.beat,
      accent: !!click.accent,
      lateByMs: click.lateByMs || 0,
      found: hit.found,
      delayMs: hit.found ? hit.delaySec * 1000 : null,
      arrivalSec: hit.found ? hit.arrivalSec : null,
      amplitude: hit.amplitude ?? null,
      ratio: hit.ratio ?? null,
    });
  }
  const found = perClick.filter((c) => c.found);
  const delays = summariseDelays(found.map((c) => c.delayMs));
  const result = {
    scheduled: perClick.length,
    found: found.length,
    delayMs: delays,
    medianAmplitude: found.length ? median(found.map((c) => c.amplitude)) : null,
    medianRatio: found.length ? median(found.map((c) => c.ratio).filter((r) => r !== null)) : null,
    scheduledLate: perClick.filter((c) => c.lateByMs > 0).length,
    perClick,
  };
  if (o.bpm) result.spacing = spacingDeviation(found, o.bpm);
  return result;
}
