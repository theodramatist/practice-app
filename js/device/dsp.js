// Small signal-processing helpers for the device check. Pure functions, no
// browser APIs, so the same code runs under Node for tests.

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place radix-2 FFT. `re` and `im` must have the same power-of-two length.
 * With inverse = true the result is scaled by 1/N.
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const half = len >> 1;
    for (let k = 0; k < half; k++) {
      // Each twiddle is computed directly, so no rounding error builds up.
      const wr = Math.cos(angle * k);
      const wi = Math.sin(angle * k);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const vr = re[j] * wr - im[j] * wi;
        const vi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - vr;
        im[j] = im[i] - vi;
        re[i] += vr;
        im[i] += vi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * One-sided power spectrum of a stretch of samples (Hann window, zero-padded
 * to a power of two). It is scaled so that adding the bins across a band gives
 * the mean square of the signal in that band: a full-scale sine sums to 0.5.
 *
 * @returns {{power: Float64Array, binHz: number} | null} null if the stretch is too short
 */
export function powerSpectrum(samples, sampleRate, startIndex, length) {
  const start = Math.max(0, Math.floor(startIndex));
  const end = Math.min(samples.length, start + Math.floor(length));
  const n = end - start;
  if (n < 32) return null;
  const size = nextPow2(n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let windowPower = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = samples[start + i] * w;
    windowPower += w * w;
  }
  fft(re, im);
  const half = size >> 1;
  const power = new Float64Array(half + 1);
  const scale = 1 / (size * windowPower);
  for (let k = 0; k <= half; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) * scale;
    power[k] = k === 0 || k === half ? p : 2 * p;
  }
  return { power, binHz: sampleRate / size };
}

/** Mean square of the signal between two frequencies. */
export function bandPower(spectrum, lowHz, highHz) {
  const { power, binHz } = spectrum;
  const first = Math.max(0, Math.ceil(lowHz / binHz));
  const last = Math.min(power.length - 1, Math.floor(highHz / binHz));
  let sum = 0;
  for (let k = first; k <= last; k++) sum += power[k];
  return sum;
}

/** Decibels for an amplitude (1.0 = full scale). null when there is nothing to measure. */
export function amplitudeDb(amplitude) {
  return amplitude > 0 && Number.isFinite(amplitude) ? 20 * Math.log10(amplitude) : null;
}

/** Decibels for a power or mean-square value. null when there is nothing to measure. */
export function powerDb(power) {
  return power > 0 && Number.isFinite(power) ? 10 * Math.log10(power) : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation: a spread measure that ignores the odd outlier. */
export function medianAbsoluteDeviation(values) {
  const centre = median(values);
  if (centre === null) return null;
  return median(values.map((v) => Math.abs(v - centre)));
}
