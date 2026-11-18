// Lay a take's recorded chunks on one timeline. Pure function, tested under Node.
//
// Each chunk carries the audio-clock frame number of its first sample. Cue and
// click times are kept on that same clock, so a sample must sit at its own
// frame number or every time after a dropout would be wrong. Frames the audio
// thread never delivered are filled with silence, and where they were is kept.

/**
 * @param {{frame: number, samples: Float32Array}[]} chunks  in arrival order
 * @param {number} maxFillFrames  the most silence that may be filled in before the take counts as broken
 * @returns {{
 *   samples: Float32Array, startFrame: number|null,
 *   gapList: {atFrame: number, frames: number}[],   positions are counted from the take's first sample
 *   filledFrames: number, overlapFrames: number,
 *   timeline: 'continuous'|'filled'|'broken'
 * }}
 */
export function assembleChunks(chunks, maxFillFrames) {
  const kept = chunks.filter((chunk) => chunk && chunk.samples && chunk.samples.length);
  if (!kept.length) {
    return { samples: new Float32Array(0), startFrame: null, gapList: [], filledFrames: 0, overlapFrames: 0, timeline: 'continuous' };
  }
  const startFrame = kept[0].frame;
  const gapList = [];
  let expected = startFrame;
  let filledFrames = 0;
  let overlapFrames = 0;
  for (const chunk of kept) {
    if (chunk.frame > expected) {
      gapList.push({ atFrame: expected - startFrame, frames: chunk.frame - expected });
      filledFrames += chunk.frame - expected;
    } else if (chunk.frame < expected) {
      // The frame counter went backwards: nothing after this can be placed with confidence.
      overlapFrames += expected - chunk.frame;
    }
    expected = Math.max(expected, chunk.frame + chunk.samples.length);
  }

  if (overlapFrames > 0 || filledFrames > maxFillFrames) {
    // Too damaged to place. Hand back the samples end to end, clearly marked,
    // so the caller can discard the take.
    let total = 0;
    for (const chunk of kept) total += chunk.samples.length;
    const samples = new Float32Array(total);
    let at = 0;
    for (const chunk of kept) {
      samples.set(chunk.samples, at);
      at += chunk.samples.length;
    }
    return { samples, startFrame, gapList, filledFrames, overlapFrames, timeline: 'broken' };
  }

  const samples = new Float32Array(expected - startFrame); // zeros where frames are missing
  for (const chunk of kept) samples.set(chunk.samples, chunk.frame - startFrame);
  return { samples, startFrame, gapList, filledFrames, overlapFrames, timeline: gapList.length ? 'filled' : 'continuous' };
}
