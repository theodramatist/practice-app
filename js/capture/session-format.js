// The shape of an exported session file. Pure functions (tested under Node and
// read back by the Python analysis), so the page and the analysis agree.
//
// A session file is a ZIP holding:
//   session.json            every label: device, settings granted, chords, takes
//   takes/<take id>.wav     one uncompressed mono WAV per recorded take
//
// All times inside a take ("t") are seconds from the take's first sample.

export const FORMAT = 'practice-prototype-session';
export const FORMAT_VERSION = 1;

export function safeName(id) {
  return String(id).replace(/#/g, 'sharp').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function takeFileName(id) {
  return `takes/${safeName(id)}.wav`;
}

export function sessionFileName(session, part = null) {
  const base = `session-${session.date}-${session.number}`;
  return part ? `${base}-part${part.index}of${part.of}.zip` : `${base}.zip`;
}

/** The recorded takes of a session, in script order. */
export function recordedTakes(session) {
  return session.takes.filter((take) => {
    const result = session.results[take.id];
    return result && result.status === 'recorded';
  });
}

/**
 * Build session.json.
 * @param {object} session  the session record kept on the device
 * @param {{exportedAt?: string, part?: {index:number, of:number}, takeIds?: string[]}} [options]
 */
export function buildManifest(session, options = {}) {
  const only = options.takeIds ? new Set(options.takeIds) : null;
  const takes = recordedTakes(session)
    .filter((take) => !only || only.has(take.id))
    .map((take) => {
      const result = session.results[take.id];
      return {
        id: take.id,
        file: takeFileName(take.id),
        order: take.order,
        kind: take.kind,
        block: take.block,
        title: take.title,
        chordId: take.chordId || null,
        chordName: take.chordName || null,
        targetFrets: take.targetFrets || null,
        playedFrets: take.playedFrets || null,
        condition: take.condition || null,
        conditionDetail: take.conditionDetail || null,
        courseOrder: take.courseOrder || null,
        pair: take.pair || null,
        tempoBpm: take.tempoBpm || null,
        clickRoute: take.clickRoute || null,
        clickSound: take.clickSound || null,
        cues: result.cues || [],
        clicks: result.clicks || [],
        metronomeTimer: result.metronomeTimer || null,
        sampleRate: result.sampleRate,
        startFrame: result.startFrame,
        startTime: result.startTime,
        durationSec: result.durationSec,
        peak: result.peak,
        clipped: result.clipped,
        gaps: result.gaps,
        gapFrames: result.gapFrames,
        zeroRuns: result.zeroRuns,
        wallMinusAudioMs: result.wallMinusAudioMs,
        bitDepth: result.bitDepth,
        recordedAt: result.recordedAt,
        attempt: result.attempt,
        flag: result.flag || null,
        note: result.note || '',
        route: result.route || null,
      };
    });

  const skipped = session.takes
    .filter((take) => (session.results[take.id] || {}).status === 'skipped')
    .map((take) => take.id);
  const notRecorded = session.takes.filter((take) => !session.results[take.id]).map((take) => take.id);

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    sessionId: session.id,
    label: session.label,
    number: session.number,
    date: session.date,
    createdAt: session.createdAt,
    exportedAt: options.exportedAt || new Date().toISOString(),
    part: options.part || null,
    app: { page: 'capture', configVersion: session.configVersion },
    env: session.env,
    setup: session.setup,
    chords: session.chords,
    config: session.config,
    audio: session.audio,
    takes,
    skipped,
    notRecorded,
  };
}

/** Group take ids so each group's audio stays under maxBytes. */
export function splitIntoParts(sizes, maxBytes) {
  const groups = [];
  let current = [];
  let total = 0;
  for (const { id, bytes } of sizes) {
    if (current.length && total + bytes > maxBytes) {
      groups.push(current);
      current = [];
      total = 0;
    }
    current.push(id);
    total += bytes;
  }
  if (current.length) groups.push(current);
  return groups;
}
