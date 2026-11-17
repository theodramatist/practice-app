// Uncompressed WAV writer. 16-bit PCM by default; 32-bit float on request.
// Pure functions, no browser APIs, so the same code runs under Node for tests.

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * @param {Float32Array} samples mono samples in the range -1..1
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|32}} [options]
 * @returns {Uint8Array} the bytes of a .wav file
 */
export function encodeWav(samples, sampleRate, options = {}) {
  const bitDepth = options.bitDepth === 32 ? 32 : 16;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = IEEE float
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * bytesPerSample, true); // bytes per second
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  if (bitDepth === 32) {
    for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i], true);
  } else {
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
    }
  }
  return new Uint8Array(buffer);
}
