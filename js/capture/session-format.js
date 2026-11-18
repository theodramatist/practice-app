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
 * Where a session stands, counted one way for every screen:
 * usable (recorded and not marked bad), flagged (recorded, marked bad),
 * skipped, and todo (nothing yet). usable + flagged + skipped + todo = total.
 */
export function tally(session) {
  const out = { total: session.takes.length, usable: 0, flagged: 0, skipped: 0, todo: 0 };
  for (const take of session.takes) {
    const result = session.results[take.id];
    if (!result) out.todo += 1;
    else if (result.status === 'skipped') out.skipped += 1;
    else if (result.flag) out.flagged += 1;
    else out.usable += 1;
  }
  out.recorded = out.usable + out.flagged;
  return out;
}

/**
 * Save a take's audio and its labels together, or not at all.
 * The session passed in is NOT changed; the caller updates its own copy only
 * after this resolves. `putTogether` is db.js's dbPutTogether (one transaction).
 * @returns {Promise<object>} the session as it now is on the device
 */
export async function commitTake(session, takeId, result, audioBytes, putTogether) {
  const next = { ...session, results: { ...session.results, [takeId]: result } };
  await putTogether([
    { store: 'audio', value: { key: `${session.id}/${takeId}`, sessionId: session.id, bytes: audioBytes } },
    { store: 'sessions', value: next },
  ]);
  return next;
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
        // Dropouts: frames the audio thread never delivered. The WAV has silence
        // there, so every time in the take is still true; gapList says where.
        timeline: result.timeline || (result.gaps > 0 ? 'unknown' : 'continuous'),
        gaps: result.gaps,
        gapFrames: result.gapFrames,
        gapList: result.gapList || [],
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
