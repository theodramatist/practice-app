// The capture page: walks through the recording script of spec section 11 take
// by take, records uncompressed audio with every label attached, keeps the
// takes on the device, and exports a session as one file.
//
// Sound in and out goes through the AudioIO (audio/audio-io.js) only.

import { loadConfig } from '../config.js';
import { createAudioIO, features } from '../audio/audio-io.js';
import { Metronome } from '../audio/metronome.js';
import { encodeWav } from '../util/wav.js';
import { zipParts } from '../util/zip.js';
import { dbGet, dbGetAll, dbPut, dbDelete, dbKeysByIndex, kvGet, kvSet, requestPersistence } from '../util/db.js';
import {
  h, add, clear, envInfo, isStandalone, noteVisit, registerServiceWorker, WakeLock,
  shareFile, downloadFile, formatDb, formatMB, formatDuration, todayIso,
} from '../shell.js';
import { chordDiagram, fretsText } from '../ui/chord-diagram.js';
import { buildScript, scriptSummary } from './script.js';
import { buildManifest, recordedTakes, sessionFileName, splitIntoParts, takeFileName } from './session-format.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);

const state = {
  cfg: null,
  chordData: null,
  io: null,
  metronome: null,
  wake: null,
  sessions: [],
  session: null,
  view: 'setup', // 'setup' | 'run' | 'export'
  index: 0, // which take is on screen
  recording: null, // { cancel() } while a take is being recorded
  listenInfo: null,
  listenError: null,
  devices: [],
  pageChecked: {},
  persistence: null,
  lastMessage: null,
};

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

async function init() {
  document.getElementById('mode-chip').textContent = isStandalone() ? 'Home Screen app' : 'Safari tab';
  registerServiceWorker();
  noteVisit();
  state.cfg = await loadConfig();
  state.chordData = await (await fetch(new URL('../../data/chords.mandolin.json', import.meta.url))).json();
  state.io = createAudioIO(state.cfg, { testInput: params.has('test-input') || params.get('testInput') === '1' });
  state.metronome = new Metronome(state.io, state.cfg);
  state.wake = new WakeLock(() => {});
  state.pageChecked = await kvGet('pageChecked', {});
  state.sessions = await dbGetAll('sessions');
  state.io.onEvent((entry) => onAudioEvent(entry));
  state.io.onLevel((level) => updateMeter(level));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.recording) state.recording.cancel('The app went to the background, so that take was discarded. Record it again.');
  });
  renderSetup();
}

function statusText(chord) {
  return state.chordData.statuses[chord.status] || chord.status;
}

function selectableChords() {
  // Chop shapes are not part of the recording list in spec section 11.
  return state.chordData.chords.filter((chord) => chord.kind !== 'chop');
}

// ---------------------------------------------------------------------------
// Setup view: existing sessions, and the form for a new one
// ---------------------------------------------------------------------------

function renderSetup() {
  state.session = null;
  state.view = 'setup';
  const cfg = state.cfg;
  clear(app);

  if (!features().audioWorklet || (!features().getUserMedia && !state.io.testInput)) {
    add(app, h('div', { class: 'banner bad' }, 'This browser cannot record here. Open this page in Safari on the iPad, over https.'));
  }

  // --- sessions already on this device
  if (state.sessions.length) {
    const rows = state.sessions
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((session) => {
        const done = recordedTakes(session).length;
        return h('tr', {},
          h('td', {}, h('strong', {}, session.label), h('br'), h('small', {}, session.date)),
          h('td', { class: 'num' }, `${done} of ${session.takes.length} takes`),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => openSession(session.id) }, done < session.takes.length ? 'Continue' : 'Open'),
            h('button', { class: 'danger', onclick: () => deleteSession(session) }, 'Delete'),
          )),
        );
      });
    add(app, h('div', { class: 'panel' },
      h('h2', {}, 'Sessions on this iPad'),
      h('table', {}, h('tbody', {}, rows)),
      h('p', { class: 'small' }, `The plan is at least ${cfg('script.sessionsMin')} sessions on different days, each with fresh tuning. A session can be recorded in more than one sitting on the same day.`),
    ));
  }

  // --- a new session
  const number = state.sessions.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  const chosen = new Set(cfg('script.defaultChordIds'));
  const min = cfg('script.chordsMin');
  const max = cfg('script.chordsMax');

  const countLine = h('p', {});
  const estimateLine = h('p', { class: 'small' });
  const createButton = h('button', { class: 'primary big' }, `Create Session ${number}`);

  const refresh = () => {
    const n = chosen.size;
    const ok = n >= min && n <= max;
    countLine.textContent = `${n} chosen. Choose ${min} to ${max}.`;
    countLine.className = ok ? '' : 'banner';
    createButton.disabled = !ok;
    if (n > 0) {
      const chords = selectableChords().filter((c) => chosen.has(c.id));
      const summary = scriptSummary(buildScript({ cfg, chords, sessionNumber: number }));
      estimateLine.textContent = `With these chords the session is ${summary.takes} short takes: ${summary.strums} strums plus the chord changes, about ${formatDuration(summary.recordingSeconds)} of recording. Allow roughly twice that with the pauses in between.`;
    } else {
      estimateLine.textContent = '';
    }
  };

  const cards = selectableChords().map((chord) => {
    const select = h('input', { type: 'checkbox' });
    select.checked = chosen.has(chord.id);
    const checked = h('input', { type: 'checkbox' });
    checked.checked = !!state.pageChecked[chord.id];
    const card = h('div', { class: `chord-card${select.checked ? ' selected' : ''}` },
      h('div', { class: 'name' }, chord.name),
      h('div', { html: chordDiagram(chord.frets) }),
      h('div', { class: 'small' }, statusText(chord)),
      chord.noThird ? h('div', { class: 'small' }, `No third: sounds the same as ${chord.alsoAccept.join(', ')}`) : null,
      h('label', {}, select, 'Record this chord'),
      h('label', {}, checked, 'Matches my book'),
    );
    select.addEventListener('change', () => {
      if (select.checked) chosen.add(chord.id); else chosen.delete(chord.id);
      card.classList.toggle('selected', select.checked);
      refresh();
    });
    checked.addEventListener('change', async () => {
      state.pageChecked[chord.id] = checked.checked;
      await kvSet('pageChecked', state.pageChecked);
    });
    return card;
  });

  const distance = h('input', { type: 'number', inputmode: 'numeric', min: '5', max: '300', placeholder: 'e.g. 50' });
  const position = h('input', { type: 'text', placeholder: 'e.g. on the music stand, leaning back' });
  const room = h('input', { type: 'text', placeholder: 'e.g. study, door closed' });
  const headphones = h('input', { type: 'text', placeholder: 'e.g. wired earbuds through the USB-C adapter' });
  const notes = h('textarea', { rows: '2', placeholder: 'Anything else worth remembering about today' });

  createButton.addEventListener('click', async () => {
    const chords = selectableChords().filter((c) => chosen.has(c.id));
    await createSession({
      number,
      chords,
      setup: {
        distanceCm: distance.value ? Number(distance.value) : null,
        position: position.value.trim(),
        room: room.value.trim(),
        headphones: headphones.value.trim(),
        notes: notes.value.trim(),
      },
    });
  });

  add(app, h('div', { class: 'panel stack' },
    h('h2', {}, `New session (Session ${number}, ${todayIso()})`),
    h('p', {}, 'Choose the chords you will really use. Each shape below is one the spec marks as printed; the line under it says where. Every shape was read from a screen image, so tick "Matches my book" once you have checked it against the page.'),
    h('p', { class: 'small' }, 'Am comes in two printed shapes. Record whichever you mean to use; the choice is still open in the spec.'),
    h('div', { class: 'chord-grid' }, cards),
    countLine,
    estimateLine,
    h('h3', {}, 'Where things are today'),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'iPad to mandolin, in centimetres', distance),
      h('label', { class: 'field grow' }, 'Where the iPad sits', position),
    ),
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, 'Room', room),
      h('label', { class: 'field grow' }, 'Headphones', headphones),
    ),
    h('label', { class: 'field' }, 'Notes', notes),
    createButton,
  ));
  refresh();
}

async function createSession({ number, chords, setup }) {
  const cfg = state.cfg;
  const date = todayIso();
  const takes = buildScript({ cfg, chords, sessionNumber: number });
  state.persistence = await requestPersistence();
  const session = {
    id: `s-${date}-${number}-${Date.now().toString(36)}`,
    label: `Session ${number}`,
    number,
    date,
    createdAt: new Date().toISOString(),
    configVersion: cfg.version,
    config: cfg.snapshot(['capture.', 'script.', 'metronome.']),
    env: envInfo(),
    persistence: state.persistence,
    setup,
    chords: chords.map((chord) => ({
      id: chord.id,
      name: chord.name,
      frets: chord.frets,
      status: chord.status,
      statusText: statusText(chord),
      noThird: !!chord.noThird,
      alsoAccept: chord.alsoAccept || [],
      matchesBook: !!state.pageChecked[chord.id],
    })),
    takes,
    results: {},
    audio: { openings: [], events: [] },
  };
  await dbPut('sessions', session);
  state.sessions.push(session);
  await openSession(session.id);
}

async function deleteSession(session) {
  const done = recordedTakes(session).length;
  const sure = confirm(`Delete ${session.label} (${session.date}) and its ${done} recorded takes from this iPad? This cannot be undone. Export it first if you want to keep it.`);
  if (!sure) return;
  const keys = await dbKeysByIndex('audio', 'sessionId', session.id);
  for (const key of keys) await dbDelete('audio', key);
  await dbDelete('sessions', session.id);
  state.sessions = state.sessions.filter((s) => s.id !== session.id);
  renderSetup();
}

async function openSession(id) {
  state.session = state.sessions.find((s) => s.id === id);
  const firstOpen = state.session.takes.findIndex((take) => !state.session.results[take.id]);
  state.index = firstOpen === -1 ? state.session.takes.length - 1 : firstOpen;
  state.lastMessage = null;
  renderRun();
  window.scrollTo(0, 0);
}

async function saveSession() {
  await dbPut('sessions', state.session);
}

// ---------------------------------------------------------------------------
// Listening: open the one microphone stream, show what was granted
// ---------------------------------------------------------------------------

async function startListening(deviceId = null) {
  state.listenError = null;
  try {
    state.wake.request();
    const info = await state.io.startListening(deviceId ? { deviceId } : {});
    state.listenInfo = info;
    state.devices = await state.io.listInputDevices();
    if (state.session) {
      state.session.audio.openings.push({ at: new Date().toISOString(), mode: envInfo().mode, wake: state.wake.state(), ...info });
      await saveSession();
    }
  } catch (error) {
    state.listenInfo = null;
    state.listenError = describeMicError(error);
  }
  if (state.view === 'run') renderRun();
}

function describeMicError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone was not allowed. Reload the page and tap Allow when asked. If no question appears, open Settings, Apps, Safari, Microphone and set it to Ask or Allow.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app. Close that app and try again.';
  return `The microphone could not be opened: ${error && error.message ? error.message : error}`;
}

function onAudioEvent(entry) {
  if (state.session && ['devicechange', 'track-ended', 'track-muted', 'track-unmuted', 'context-state'].includes(entry.type)) {
    state.session.audio.events.push(entry);
    saveSession();
  }
  if (entry.type === 'track-ended' || entry.type === 'track-muted') {
    if (state.recording) state.recording.cancel('The microphone stopped part-way through (the sound route changed). Start listening again, then record that take again.');
    else if (state.view === 'run') renderRun();
  }
  if (entry.type === 'devicechange' && state.session && !state.recording) {
    state.io.listInputDevices().then((devices) => {
      state.devices = devices;
      if (state.view === 'run') renderRun();
    });
  }
}

let meterEl = null;
let meterText = null;
function updateMeter(level) {
  if (!meterEl) return;
  const db = level.peak > 0 ? 20 * Math.log10(level.peak) : -100;
  const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterEl.firstChild.style.width = `${percent}%`;
  meterEl.classList.toggle('hot', level.peak >= state.cfg('capture.clipLevel'));
  if (meterText) meterText.textContent = db <= -99 ? 'silent' : `${db.toFixed(0)} dB`;
}

function listeningPanel() {
  const io = state.io;
  const cfg = state.cfg;
  const panel = h('div', { class: 'panel stack' });
  if (state.listenError) add(panel, h('div', { class: 'banner bad' }, state.listenError));

  if (!io.listening) {
    meterEl = null;
    add(panel, 
      h('h2', {}, 'Microphone'),
      h('p', {}, state.listenInfo
        ? 'The microphone has stopped. Tap to open it again.'
        : 'Tap once to open the microphone for this sitting. Echo cancellation, noise suppression and automatic gain are all asked to be off; the iPad\'s answer is shown and saved with the recordings.'),
      h('button', { class: 'primary big', onclick: () => startListening() }, 'Start listening'),
    );
    return panel;
  }

  const info = io.describe();
  const granted = info.granted || {};
  const flag = (key) => {
    const asked = cfg(`capture.${key}`);
    const got = granted[key];
    const chipClass = got === undefined ? 'warn' : got === asked ? 'good' : 'bad';
    const text = got === undefined ? 'not reported' : got ? 'ON' : 'off';
    return h('tr', {}, h('td', {}, key), h('td', {}, asked ? 'on' : 'off'), h('td', {}, h('span', { class: `chip ${chipClass}` }, text)));
  };
  meterEl = h('div', { class: 'meter' }, h('i'));
  meterText = h('span', { class: 'small', style: 'min-width:4.5em' }, '');

  const inputs = state.devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
  let picker = null;
  if (inputs.length > 1) {
    picker = h('select', {
      onchange: (event) => startListening(event.target.value),
    }, inputs.map((d) => {
      const option = h('option', { value: d.deviceId }, d.label || 'Microphone');
      if (granted.deviceId && granted.deviceId === d.deviceId) option.selected = true;
      return option;
    }));
  }

  add(panel, 
    h('div', { class: 'row spread' },
      h('h2', {}, 'Microphone'),
      h('span', { class: 'chip good' }, 'Listening'),
    ),
    h('div', { class: 'row' }, h('span', { class: 'small' }, 'Level'), meterEl, meterText),
    h('p', { class: 'small' }, 'Through: ', h('strong', {}, info.trackLabel || 'unnamed microphone'), `. ${Math.round(info.sampleRate)} samples a second.`,
      picker ? ' If this is not the iPad\'s own microphone, choose it here: ' : '', picker),
    h('details', {},
      h('summary', {}, 'What the iPad granted'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Setting'), h('th', {}, 'Asked for'), h('th', {}, 'Granted'))),
        h('tbody', {}, flag('echoCancellation'), flag('noiseSuppression'), flag('autoGainControl')),
      ),
      h('pre', {}, JSON.stringify({ granted: info.granted, baseLatency: info.baseLatency, outputLatency: info.outputLatency, audioSessionType: info.audioSessionType, inputChannels: info.inputChannels }, null, 1)),
    ),
  );
  return panel;
}

// ---------------------------------------------------------------------------
// Run view: one take at a time
// ---------------------------------------------------------------------------

function takeStatus(take) {
  const result = state.session.results[take.id];
  if (!result) return 'todo';
  if (result.status === 'skipped') return 'skipped';
  return result.flag ? 'flagged' : 'recorded';
}

function remainingSeconds() {
  return state.session.takes.filter((take) => !state.session.results[take.id]).reduce((sum, take) => sum + take.durationSec, 0);
}

function renderRun() {
  const session = state.session;
  if (!session) return renderSetup();
  if (state.recording) return; // the cue view owns the screen while recording
  state.view = 'run';
  clear(app);

  const done = session.takes.filter((take) => state.session.results[take.id]).length;
  const take = session.takes[state.index];

  add(app, h('div', { class: 'panel stack' },
    h('div', { class: 'row spread' },
      h('h2', {}, `${session.label} · ${session.date}`),
      h('div', { class: 'row' },
        h('button', { onclick: () => renderExport() }, 'Save session file'),
        h('button', { onclick: () => { state.io.stopListening(); state.listenInfo = null; renderSetup(); } }, 'All sessions'),
      ),
    ),
    h('div', { class: 'progress' }, h('i', { style: `width:${(done / session.takes.length) * 100}%` })),
    h('p', { class: 'small' }, `${done} of ${session.takes.length} takes done. About ${formatDuration(remainingSeconds())} of recording left. You can stop at any point and carry on later today.`),
  ));

  add(app, listeningPanel());
  if (state.lastMessage) add(app, h('div', { class: `banner ${state.lastMessage.kind || ''}` }, state.lastMessage.text));
  add(app, takePanel(take));
  add(app, takeListPanel());
}

function shapesFor(take) {
  if (take.kind === 'strums') {
    const wrong = take.condition === 'fret-off';
    return h('div', { class: 'shape-pair' },
      h('figure', {},
        h('figcaption', {}, wrong ? 'Play this (wrong on purpose)' : take.chordName),
        h('div', { html: chordDiagram(take.playedFrets, take.marks) }),
        h('small', {}, fretsText(take.playedFrets)),
      ),
      wrong ? h('figure', {},
        h('figcaption', {}, `The real ${take.chordName}`),
        h('div', { html: chordDiagram(take.targetFrets) }),
        h('small', {}, fretsText(take.targetFrets)),
      ) : null,
    );
  }
  if (take.kind === 'changes') {
    return h('div', { class: 'shape-pair' }, take.pair.map((chord) => h('figure', {},
      h('figcaption', {}, chord.name),
      h('div', { html: chordDiagram(chord.frets) }),
      h('small', {}, fretsText(chord.frets)),
    )));
  }
  return null;
}

function shapeStatusLine(take) {
  const ids = take.kind === 'strums' ? [take.chordId] : take.kind === 'changes' ? take.pair.map((c) => c.id) : [];
  if (!ids.length) return null;
  const parts = ids.map((id) => {
    const chord = state.session.chords.find((c) => c.id === id);
    return `${chord.name} ${fretsText(chord.frets)}: ${chord.statusText}${chord.matchesBook ? ', checked against the page' : ', not yet checked against the page'}`;
  });
  return h('p', { class: 'small' }, parts.join(' · '));
}

function takePanel(take) {
  const session = state.session;
  const result = session.results[take.id];
  const status = takeStatus(take);
  const panel = h('div', { class: 'panel stack' });
  const canRecord = state.io.listening;

  add(panel, 
    h('div', { class: 'row spread' },
      h('div', {}, h('small', {}, `Take ${state.index + 1} of ${session.takes.length} · ${take.blockTitle}`), h('h2', {}, take.title)),
      h('span', { class: `chip ${status === 'recorded' ? 'good' : status === 'flagged' ? 'warn' : ''}` },
        { todo: 'Not recorded yet', recorded: 'Recorded', flagged: 'Recorded, marked bad', skipped: 'Skipped' }[status]),
    ),
    h('div', {}, take.lines.map((line) => h('p', {}, line))),
    shapesFor(take),
    shapeStatusLine(take),
    h('p', { class: 'small' }, `This take lasts ${formatDuration(take.durationSec)}${take.cues.length ? ` (${take.cues.length} cues)` : ''}.`),
  );

  if (result && result.status === 'recorded') {
    const warnings = [];
    if (result.clipped > 0) warnings.push(`${result.clipped} samples hit the top of the scale (clipping). Move the iPad a little further away or play less hard, and record it again.`);
    if (result.peak < 0.01) warnings.push('This take is very quiet. Check that the right microphone is in use and that nothing covers it.');
    if (result.gaps > 0 || result.zeroRuns > 0) warnings.push(`The recording has ${result.gaps} gap(s) and ${result.zeroRuns} patch(es) of dead silence. Record it again.`);
    if (Math.abs(result.wallMinusAudioMs) > 100) warnings.push(`The audio clock and the wall clock drifted apart by ${result.wallMinusAudioMs} ms during this take.`);
    add(panel, 
      h('p', {}, `Recorded ${formatDuration(result.durationSec)}. Loudest point ${formatDb(result.peak)} of full scale. Attempt ${result.attempt}.`),
      warnings.map((text) => h('div', { class: 'banner' }, text)),
    );
  }

  const buttons = h('div', { class: 'row' });
  if (!result || result.status === 'skipped') {
    add(buttons, h('button', { class: 'primary big', disabled: !canRecord, onclick: () => recordTake(take) }, 'Record'));
    if (!result) add(buttons, h('button', { onclick: () => skipTake(take) }, 'Skip this take'));
  } else {
    add(buttons, 
      h('button', { class: 'primary big', onclick: () => goNext() }, 'Next take'),
      h('button', { disabled: !canRecord, onclick: () => recordTake(take) }, 'Record it again'),
      h('button', { onclick: () => toggleFlag(take) }, result.flag ? 'It was fine after all' : 'Mark as bad'),
    );
  }
  add(buttons, 
    h('button', { disabled: state.index === 0, onclick: () => { state.index -= 1; state.lastMessage = null; renderRun(); } }, 'Back'),
    h('button', { disabled: state.index >= session.takes.length - 1, onclick: () => { state.index += 1; state.lastMessage = null; renderRun(); } }, 'Forward'),
  );
  add(panel, buttons);
  if (!canRecord) add(panel, h('p', { class: 'small' }, 'Start listening first.'));
  return panel;
}

function takeListPanel() {
  const session = state.session;
  const blocks = [];
  for (const take of session.takes) {
    let block = blocks[blocks.length - 1];
    if (!block || block.key !== take.block) {
      block = { key: take.block, title: take.blockTitle, takes: [] };
      blocks.push(block);
    }
    block.takes.push(take);
  }
  const current = session.takes[state.index];
  return h('div', { class: 'panel' },
    h('h2', {}, 'All takes'),
    blocks.map((block) => {
      const done = block.takes.filter((take) => session.results[take.id]).length;
      const details = h('details', {},
        h('summary', {}, `${block.title} (${done} of ${block.takes.length})`),
        h('ul', { class: 'take-list' }, block.takes.map((take) => h('li', {
          class: take.id === current.id ? 'current' : '',
          onclick: () => { state.index = take.order; state.lastMessage = null; renderRun(); window.scrollTo(0, 0); },
        }, h('span', { class: `dot ${takeStatus(take)}` }), h('span', {}, take.title)))),
      );
      if (block.key === current.block) details.open = true;
      return details;
    }),
  );
}

function goNext() {
  const session = state.session;
  const next = session.takes.findIndex((take, i) => i > state.index && !session.results[take.id]);
  const any = session.takes.findIndex((take) => !session.results[take.id]);
  state.lastMessage = null;
  if (next !== -1) state.index = next;
  else if (any !== -1) state.index = any;
  else return renderExport();
  renderRun();
  window.scrollTo(0, 0);
}

async function skipTake(take) {
  state.session.results[take.id] = { status: 'skipped', at: new Date().toISOString() };
  await saveSession();
  goNext();
}

async function toggleFlag(take) {
  const result = state.session.results[take.id];
  result.flag = result.flag ? null : 'bad';
  await saveSession();
  renderRun();
}

// ---------------------------------------------------------------------------
// Recording a take
// ---------------------------------------------------------------------------

class Cancelled extends Error {}

function cueView(take) {
  const big = h('div', { class: 'big-text' }, 'Get ready');
  const sub = h('div', { class: 'sub-text' }, '');
  const dots = h('div', { class: 'beat-dots' });
  const bar = h('div', { class: 'progress' }, h('i'));
  const box = h('div', { class: 'cue' }, big, sub, dots);
  clear(app);
  add(app, 
    h('div', { class: 'panel stack' },
      h('div', { class: 'row spread' },
        h('h2', {}, h('span', { class: 'recording-mark' }), take.title),
        h('button', { class: 'danger', onclick: () => state.recording && state.recording.cancel('Take stopped and discarded.') }, 'Stop and discard'),
      ),
      box,
      bar,
      shapesFor(take),
    ),
  );
  let flashTimer = null;
  return {
    set(bigText, subText) {
      if (big.textContent !== bigText) big.textContent = bigText;
      if (sub.textContent !== subText) sub.textContent = subText;
    },
    flash() {
      box.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => box.classList.remove('flash'), 160);
    },
    progress(fraction) {
      bar.firstChild.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    },
    beatDots(count, on) {
      if (dots.childElementCount !== count) {
        clear(dots);
        for (let i = 0; i < count; i++) add(dots, h('i'));
      }
      [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i === on));
    },
  };
}

const strokeArrow = { down: 'down ↓', up: 'up ↑' };

/** Takes driven by flashes at fixed times: silence, open courses, single-chord strums. */
async function runCuedTake(take, view, isCancelled) {
  const io = state.io;
  const { audioStart } = io.startTake();
  const cues = take.cues.map((cue) => ({ ...cue, at: audioStart + cue.t }));
  const endAt = audioStart + take.durationSec;
  let next = 0;

  const cueLabel = (cue) => {
    if (take.kind === 'open-courses') return { top: `Pick the ${cue.label}`, sub: `${cue.i + 1} of ${cues.length}` };
    return { top: `Strum ${cue.i + 1} of ${cues.length}`, sub: `${cue.dynamic} · ${strokeArrow[cue.stroke] || cue.stroke}` };
  };

  await new Promise((resolve, reject) => {
    const frame = () => {
      if (isCancelled()) return reject(new Cancelled());
      const now = io.now();
      view.progress((now - audioStart) / take.durationSec);
      if (!cues.length) {
        view.set('Stay quiet', `${Math.max(0, Math.ceil(endAt - now))} s`);
      } else {
        while (next < cues.length && now >= cues[next].at) {
          view.flash();
          next += 1;
        }
        if (next === 0) {
          const wait = cues[0].at - now;
          const label = cueLabel(cues[0]);
          view.set(String(Math.max(1, Math.ceil(wait))), `First: ${label.sub}`);
        } else {
          const shown = cueLabel(cues[next - 1]);
          const upcoming = next < cues.length ? cueLabel(cues[next]) : null;
          const sinceFlash = now - cues[next - 1].at;
          // Just after a flash show what was asked; then show what comes next.
          if (upcoming && sinceFlash > take.cueIntervalSec * 0.45) view.set(upcoming.top.replace('Strum', 'Next: strum').replace('Pick', 'Next: pick'), upcoming.sub);
          else view.set(shown.top, shown.sub);
        }
      }
      if (now >= endAt) return resolve();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  const recording = await io.stopTake();
  return {
    recording,
    cues: cues.map((cue) => ({ i: cue.i, t: cue.at - recording.startTime, dynamic: cue.dynamic, stroke: cue.stroke, label: cue.label })),
    clicks: [],
  };
}

/** Takes driven by the metronome: chord changes, and the click with no playing. */
async function runClickTake(take, view, isCancelled) {
  const io = state.io;
  const cfg = state.cfg;
  const metronome = state.metronome;
  const audible = take.clickRoute !== 'visual';
  const gain = take.clickRoute === 'headphones' ? cfg('metronome.clickGainHeadphones') : cfg('metronome.clickGainSpeaker');
  const beatsPerBar = cfg('script.changeBeatsPerChord');
  const total = take.plan.length;

  io.startTake();
  let finished = false;
  view.set('Get ready', take.kind === 'changes' ? `First chord: ${take.pair[0].name}` : 'Do not play');

  const started = metronome.start({
    bpm: take.tempoBpm,
    beatsPerBar,
    audible,
    gain,
    sound: take.clickSound || undefined,
    totalBeats: total,
    startDelaySec: 1.0,
    onBeat: (beat) => {
      const step = take.plan[beat.beat];
      view.flash();
      view.progress((beat.beat + 1) / total);
      view.beatDots(beatsPerBar, beat.beat % beatsPerBar);
      if (step.role === 'count-in') {
        view.set(`Count in: ${beat.beat + 1}`, `First chord: ${take.pair[0].name}`);
      } else if (step.role === 'click-only') {
        view.set('Do not play', `Click ${beat.beat + 1} of ${total}`);
      } else {
        const nextStep = take.plan[beat.beat + 1];
        const changing = nextStep && nextStep.chordId !== step.chordId;
        view.set(step.chordName, changing ? `Change to ${nextStep.chordName} next` : nextStep ? `Chord ${step.segment + 1} of ${take.plan[total - 1].segment + 1}` : 'Last strum');
      }
    },
    onDone: () => { finished = true; },
  });

  const lastBeatAt = started.t0 + ((total - 1) * 60) / take.tempoBpm;
  const endAt = lastBeatAt + cfg('script.tailSec');
  await new Promise((resolve, reject) => {
    const frame = () => {
      if (isCancelled()) {
        metronome.stop();
        return reject(new Cancelled());
      }
      if (finished && io.now() >= endAt) return resolve();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const log = metronome.stop();
  const recording = await io.stopTake();
  return {
    recording,
    cues: [],
    metronomeTimer: metronome.timerKind,
    clicks: log.map((entry) => {
      const step = take.plan[entry.beat];
      return {
        beat: entry.beat,
        t: entry.time - recording.startTime,
        accent: entry.accent,
        audible: entry.audible,
        lateByMs: entry.lateByMs,
        role: step.role,
        segment: step.segment,
        chordId: step.chordId,
      };
    }),
  };
}

async function recordTake(take) {
  if (state.recording || !state.io.listening) return;
  const session = state.session;
  let cancelled = false;
  let cancelMessage = null;
  state.recording = {
    cancel(message) {
      cancelled = true;
      cancelMessage = message;
    },
  };
  state.lastMessage = null;
  state.wake.request();
  const view = cueView(take);

  try {
    const run = take.kind === 'changes' || take.kind === 'click-only' ? runClickTake : runCuedTake;
    const { recording, cues, clicks, metronomeTimer } = await run(take, view, () => cancelled);
    const bitDepth = state.cfg('capture.wavBitDepth');
    const bytes = encodeWav(recording.samples, recording.sampleRate, { bitDepth });
    await dbPut('audio', { key: `${session.id}/${take.id}`, sessionId: session.id, bytes: bytes.buffer });
    const previous = session.results[take.id];
    const info = state.io.describe();
    session.results[take.id] = {
      status: 'recorded',
      recordedAt: new Date().toISOString(),
      attempt: previous && previous.attempt ? previous.attempt + 1 : 1,
      flag: null,
      note: '',
      sampleRate: recording.sampleRate,
      startFrame: recording.startFrame,
      startTime: recording.startTime,
      durationSec: recording.durationSec,
      peak: recording.peak,
      clipped: recording.clipped,
      gaps: recording.gaps,
      gapFrames: recording.gapFrames,
      zeroRuns: recording.zeroRuns,
      wallMinusAudioMs: recording.wallMinusAudioMs,
      bitDepth,
      bytes: bytes.length,
      cues,
      clicks,
      metronomeTimer: metronomeTimer || null,
      route: {
        declared: take.clickRoute || null,
        mode: envInfo().mode,
        trackLabel: info.trackLabel,
        granted: info.granted,
        sampleRate: info.sampleRate,
        baseLatency: info.baseLatency,
        outputLatency: info.outputLatency,
        audioSessionType: info.audioSessionType,
        inputChannels: info.inputChannels,
      },
    };
    await saveSession();
  } catch (error) {
    state.io.cancelTake();
    state.metronome.stop();
    if (error instanceof Cancelled) {
      state.lastMessage = { kind: '', text: cancelMessage || 'Take discarded.' };
    } else {
      state.lastMessage = { kind: 'bad', text: `That take could not be saved: ${error && error.message ? error.message : error}` };
    }
  } finally {
    state.recording = null;
  }
  renderRun();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Export: one file per session, through the share sheet or a download
// ---------------------------------------------------------------------------

async function buildSessionZip(session, takeIds = null, part = null) {
  const manifest = buildManifest(session, { takeIds, part });
  const files = [{ name: 'session.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) }];
  for (const take of manifest.takes) {
    const row = await dbGet('audio', `${session.id}/${take.id}`);
    if (!row) throw new Error(`The audio for "${take.title}" is missing from this iPad.`);
    files.push({ name: takeFileName(take.id), bytes: new Uint8Array(row.bytes), date: new Date(take.recordedAt) });
  }
  return new Blob(zipParts(files), { type: 'application/zip' });
}

function renderExport() {
  const session = state.session;
  const cfg = state.cfg;
  state.view = 'export';
  clear(app);
  const recorded = recordedTakes(session);
  const totalBytes = recorded.reduce((sum, take) => sum + (session.results[take.id].bytes || 0), 0);
  const flagged = recorded.filter((take) => session.results[take.id].flag).length;
  const left = session.takes.filter((take) => !session.results[take.id]).length;
  const status = h('div', {});
  const say = (text, kind = '') => {
    clear(status);
    add(status, h('div', { class: `banner ${kind}` }, text));
  };

  const exportWhole = async (how) => {
    try {
      say('Building the file…');
      const blob = await buildSessionZip(session);
      const name = sessionFileName(session);
      if (how === 'share') {
        const outcome = await shareFile(blob, name, 'application/zip');
        if (outcome.ok) say(`Handed ${name} to the share sheet. Choose "Save to Files".`, 'good');
        else if (outcome.cancelled) say('Nothing was saved (the share sheet was closed).');
        else say(`The share sheet would not take the file (${outcome.reason}). Use "Download instead".`, 'bad');
      } else {
        downloadFile(blob, name);
        say(`Download started: ${name}. Look in the Files app under Downloads.`, 'good');
      }
    } catch (error) {
      say(`The file could not be built: ${error && error.message ? error.message : error}. Try "Save in smaller parts".`, 'bad');
    }
  };

  const exportParts = async () => {
    try {
      const sizes = recorded.map((take) => ({ id: take.id, bytes: session.results[take.id].bytes || 0 }));
      const groups = splitIntoParts(sizes, cfg('capture.exportPartMaxMB') * 1024 * 1024);
      clear(status);
      add(status, h('p', {}, `${groups.length} part(s). Tap each one in turn and save it.`));
      groups.forEach((ids, i) => {
        const part = { index: i + 1, of: groups.length };
        const name = sessionFileName(session, part);
        const line = h('span', { class: 'small' }, '');
        add(status, h('div', { class: 'row' },
          h('button', {
            onclick: async () => {
              line.textContent = 'Building…';
              try {
                const blob = await buildSessionZip(session, ids, part);
                const outcome = await shareFile(blob, name, 'application/zip');
                if (outcome.ok) line.textContent = 'Handed to the share sheet.';
                else if (outcome.cancelled) line.textContent = 'Not saved.';
                else {
                  downloadFile(blob, name);
                  line.textContent = 'Download started.';
                }
              } catch (error) {
                line.textContent = `Failed: ${error && error.message ? error.message : error}`;
              }
            },
          }, `Save ${name}`),
          line,
        ));
      });
    } catch (error) {
      say(`Could not split the session: ${error}`, 'bad');
    }
  };

  add(app, h('div', { class: 'panel stack' },
    h('div', { class: 'row spread' },
      h('h2', {}, `Save ${session.label} · ${session.date}`),
      h('button', { onclick: () => renderRun() }, 'Back to the takes'),
    ),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Recorded takes'), h('dd', {}, `${recorded.length} of ${session.takes.length}${left ? ` (${left} not done yet)` : ''}`),
      h('dt', {}, 'Marked bad'), h('dd', {}, String(flagged)),
      h('dt', {}, 'Size'), h('dd', {}, formatMB(totalBytes)),
      h('dt', {}, 'File'), h('dd', {}, sessionFileName(session)),
    ),
    h('p', {}, 'The file holds the uncompressed audio of every take and one list of labels. Nothing leaves the iPad except through this button. The takes stay on the iPad until you delete the session, so you can save again if something goes wrong.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary big', disabled: !recorded.length, onclick: () => exportWhole('share') }, 'Save to Files…'),
      h('button', { disabled: !recorded.length, onclick: () => exportWhole('download') }, 'Download instead'),
      h('button', { disabled: !recorded.length, onclick: () => exportParts() }, 'Save in smaller parts'),
    ),
    status,
  ));
}

init().catch((error) => {
  clear(app);
  add(app, h('div', { class: 'banner bad' }, `The page could not start: ${error && error.message ? error.message : error}`));
});
