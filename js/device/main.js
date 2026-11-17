// Device check page (spec section 11, "Device checklist").
//
// Finds out how this iPad behaves before anything is built on it: permission
// prompts, the audio settings actually granted, click loudness and distortion
// with the microphone open, each audio route, round-trip latency across
// launches, a pitch readout against a hardware tuner, wake lock, offline
// launch, and whether saved data survives being left unused.
//
// Every result is saved on the device as it is produced (IndexedDB store
// 'device'), tagged with the mode the page ran in (Safari tab or Home Screen
// app) and the launch it belongs to. Nothing leaves the device unless the
// results file is saved from the last panel.
//
// All sound goes through the AudioIO (audio-io.js). The microphone is only
// ever opened from a tap. The measuring maths lives in loopback.js,
// measures.js and pitch.js, which are tested under Node on synthetic signals.

import { loadConfig } from '../config.js';
import { h, add, clear, envInfo, registerServiceWorker, WakeLock, shareFile, downloadFile, todayIso, noteVisit } from '../shell.js';
import { createAudioIO, features } from '../audio/audio-io.js';
import { Metronome } from '../audio/metronome.js';
import { dbPut, dbGetAll, kvGet, kvSet, requestPersistence } from '../util/db.js';
import { analyseLoopback, summariseDelays } from './loopback.js';
import { levelBetween, toneMeasures, noiseTilt } from './measures.js';
import { detectPitch, nearestNote, centsBetween, midiToHz } from './pitch.js';
import { median, amplitudeDb } from './dsp.js';

// ---- numbers from app/config.json --------------------------------------------
// Filled in by readNumbers() once the config has loaded. Nothing below is hard-coded.

let CLICK_FOUND_MIN_RATIO,
  CLICK_SEARCH_AFTER_SEC,
  CLICK_SEARCH_SPACING_SHARE,
  LOOPBACK_START_DELAY_SEC,
  LOOPBACK_TAIL_MS,
  CLICK_TONE_CLICKS,
  CLICK_TONE_SPACING_SEC,
  TONE_HZ,
  TONE_SEC,
  TONE_GAIN,
  TONE_BAND_PCT,
  TONE_HEARD_MIN_PURITY_DB,
  NOISE_SEC,
  NOISE_GAIN,
  SETTLE_AFTER_OPEN_MS,
  PROMPT_WAIT_HINT_MS,
  TEMPO_HOLD_WAIT_CHOICES_SEC,
  TUNER_MIN_HZ,
  TUNER_MAX_HZ,
  TUNER_PEAK_PICK,
  TUNER_HOP_SAMPLES,
  TUNER_DISPLAY_READINGS,
  TUNER_LOG_WINDOW_MS,
  TUNER_MAX_CENTS_FROM_COURSE;

function readNumbers(cfg) {
  CLICK_FOUND_MIN_RATIO = cfg('device.clickFoundMinRatio');
  CLICK_SEARCH_AFTER_SEC = cfg('device.clickSearchAfterMs') / 1000;
  CLICK_SEARCH_SPACING_SHARE = cfg('device.clickSearchSpacingShare');
  LOOPBACK_START_DELAY_SEC = cfg('device.loopbackStartDelayMs') / 1000;
  LOOPBACK_TAIL_MS = cfg('device.loopbackTailMs');
  CLICK_TONE_CLICKS = cfg('device.clickToneClicks');
  CLICK_TONE_SPACING_SEC = cfg('device.clickToneSpacingMs') / 1000;
  TONE_HZ = cfg('device.toneHz');
  TONE_SEC = cfg('device.toneDurationSec');
  TONE_GAIN = cfg('device.toneGain');
  TONE_BAND_PCT = cfg('device.tonePurityBandPct');
  TONE_HEARD_MIN_PURITY_DB = cfg('device.toneHeardMinPurityDb');
  NOISE_SEC = cfg('device.noiseDurationSec');
  NOISE_GAIN = cfg('device.noiseGain');
  SETTLE_AFTER_OPEN_MS = cfg('device.settleAfterOpenMs');
  PROMPT_WAIT_HINT_MS = cfg('device.promptWaitHintMs');
  TEMPO_HOLD_WAIT_CHOICES_SEC = cfg('device.tempoHoldWaitChoicesSec');
  TUNER_MIN_HZ = cfg('device.tunerMinHz');
  TUNER_MAX_HZ = cfg('device.tunerMaxHz');
  TUNER_PEAK_PICK = cfg('device.tunerPeakPick');
  TUNER_HOP_SAMPLES = cfg('device.tunerHopSamples');
  TUNER_DISPLAY_READINGS = cfg('device.tunerDisplayReadings');
  TUNER_LOG_WINDOW_MS = cfg('device.tunerLogWindowMs');
  TUNER_MAX_CENTS_FROM_COURSE = cfg('device.tunerMaxCentsFromCourse');
}

// ---- fixed lists -------------------------------------------------------------

const MODE_NAMES = { 'browser-tab': 'Safari tab', 'home-screen': 'Home Screen app' };
const SITUATIONS = [
  ['cold-launch', 'Opened fresh (cold launch)'],
  ['after-backgrounding', 'After switching away and back'],
  ['after-reload', 'After reloading the page'],
  ['after-navigation', 'After moving between pages'],
];
const ROUTES = [
  ['speaker', 'Built-in speaker'],
  ['wired-headphones', 'Wired headphones'],
  ['airpods', 'AirPods'],
  ['usb-microphone', 'External USB microphone'],
];
const SESSION_TYPES = ['auto', 'playback', 'play-and-record', 'transient', 'ambient'];
const CONDITIONS = [
  ['normal', 'Normal'],
  ['screen-dimmed', 'Screen dimmed'],
  ['split-view', 'Split View'],
  ['stage-manager', 'Stage Manager'],
];
const SURVIVAL = {
  kvKey: 'survival-marker',
  kvLastVisit: 'survival-last-visit',
  localKey: 'practice-survival-marker',
  localLastVisit: 'practice-survival-last-visit',
  cacheName: 'practice-survival',
  cacheUrl: './survival-marker.json',
};

// ---- state ---------------------------------------------------------------------

const state = {
  cfg: null,
  io: null,
  env: null,
  feat: null,
  mode: 'browser-tab',
  launchId: null,
  launchNumber: null,
  rows: [],
  storageBroken: false,
  sw: { supported: false },
  tuning: { courses: ['G', 'D', 'A', 'E'], openMidi: [55, 62, 69, 76] },
  mic: { info: null, isDefault: false, options: null, devices: [], lastOpen: null, opens: 0 },
  busy: false,
  hiddenSince: 0,
  clickTonePending: null,
  tuner: { on: false, ring: null, filled: 0, sinceLast: 0, readings: [], last: null },
  wakeLock: null,
  survival: null,
  persistence: null,
  offline: null,
  testInput: false,
};

const ui = {};

// ---- small helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** A plain copy that is safe to store and to write as JSON. */
function plain(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function num(value, digits = 1, unit = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
}

function yesNo(value) {
  return value === true ? 'on' : value === false ? 'off' : '—';
}

function clock(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  // toTimeString() starts with the local time as HH:MM:SS.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toTimeString().slice(0, 8)}`;
}

function daysBetween(fromIso, to = new Date()) {
  return (to.getTime() - new Date(fromIso).getTime()) / 86400000;
}

function table(headers, rows, emptyText = 'Nothing recorded yet.') {
  if (!rows.length) return h('p', { class: 'muted small' }, emptyText);
  return h(
    'div',
    { style: 'overflow-x:auto' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((text) => h('th', {}, text)))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell) => h('td', { class: 'num' }, cell)))))
    )
  );
}

function setStatus(el, text, kind = '') {
  if (!el) return;
  clear(el);
  if (!text) {
    el.className = 'hidden';
    return;
  }
  el.className = kind ? `banner ${kind}` : 'small muted';
  el.append(text);
}

function describeError(error) {
  if (!error) return 'Unknown error';
  return error.name && error.message ? `${error.name}: ${error.message}` : String(error);
}

function friendlyError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone was not allowed. Allow it for this site (Safari\u2019s page menu, then Website Settings, then Microphone; or the Settings app, under Safari, then Microphone) and try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by something else, or the iPad would not start it.';
  return describeError(error);
}

/** A row of radio buttons that reads like one choice. */
function choice(name, options, initial = null) {
  const inputs = [];
  const el = h(
    'div',
    { class: 'row' },
    options.map(([value, label]) => {
      const input = h('input', { type: 'radio', name, value });
      input.checked = value === initial;
      inputs.push(input);
      return h('label', {}, input, label);
    })
  );
  return {
    el,
    get value() {
      const chosen = inputs.find((input) => input.checked);
      return chosen ? chosen.value : null;
    },
    set value(v) {
      for (const input of inputs) input.checked = input.value === v;
    },
  };
}

function checkbox(label, initial = false) {
  const input = h('input', { type: 'checkbox' });
  input.checked = initial;
  return { el: h('label', {}, input, label), get value() { return input.checked; } };
}

function select(options, initial = null) {
  const el = h(
    'select',
    {},
    options.map(([value, label]) => {
      const option = h('option', { value }, label);
      option.selected = value === initial;
      return option;
    })
  );
  return { el, get value() { return el.value; } };
}

function panel(title, intro, ...children) {
  return h('section', { class: 'panel stack' }, h('h2', {}, title), intro ? h('p', {}, intro) : null, children);
}

/** Show script errors on the page: an iPad has no console to look at. */
function installErrorSurface() {
  const box = document.getElementById('errors');
  const show = (text) => {
    if (!box) return;
    box.append(h('div', { class: 'banner bad' }, `Something went wrong on this page: ${text}`));
  };
  window.addEventListener('error', (event) => show(event.message || String(event.error)));
  window.addEventListener('unhandledrejection', (event) => show(describeError(event.reason)));
}

// ---- saving results ------------------------------------------------------------

async function saveRow(check, result) {
  const row = {
    at: new Date().toISOString(),
    mode: state.mode,
    launchId: state.launchId,
    launchNumber: state.launchNumber,
    check,
    result: plain(result),
  };
  try {
    const id = await dbPut('device', row);
    if (id !== undefined) row.id = id;
  } catch (error) {
    noteStorageBroken(error);
  }
  state.rows.push(row);
  refreshAfterSave();
  return row;
}

async function updateRow(row) {
  row.result = plain(row.result);
  try {
    if (row.id !== undefined) await dbPut('device', row);
  } catch (error) {
    noteStorageBroken(error);
  }
  refreshAfterSave();
}

function refreshAfterSave() {
  renderSummary();
  renderExportCount();
}

function noteStorageBroken(error) {
  if (state.storageBroken) return;
  state.storageBroken = true;
  const box = document.getElementById('errors');
  if (box) {
    box.append(
      h(
        'div',
        { class: 'banner bad' },
        `Results cannot be saved on this device right now (${describeError(error)}). They are kept only until this page closes, so save the results file before leaving.`
      )
    );
  }
}

const rowsOf = (check, mode = null) => state.rows.filter((r) => r.check === check && (mode === null || r.mode === mode));

// ---- microphone ------------------------------------------------------------------

async function queryMicPermission() {
  if (!state.feat.permissionsQuery) return 'not available';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch (error) {
    return 'not available';
  }
}

function guessSituation() {
  if (state.mic.opens > 1) return 'after-backgrounding';
  let type = null;
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    type = entry ? entry.type : null;
  } catch (error) {
    type = null;
  }
  if (type === 'reload') return 'after-reload';
  if (document.referrer && document.referrer.startsWith(location.origin)) return 'after-navigation';
  return 'cold-launch';
}

/**
 * Open the microphone. MUST be called straight from a tap: the call into the
 * AudioIO happens before anything is awaited.
 * @param {object|null} options null = the app's defaults (all processing asked off)
 */
function openMic(options) {
  const beforePromise = queryMicPermission();
  const listenPromise = state.io.startListening(options || {});
  return (async () => {
    let info;
    try {
      info = await listenPromise;
    } catch (error) {
      const before = await beforePromise;
      state.mic.info = null;
      await saveRow('microphone-refused', { error: describeError(error), permissionBefore: before, options: options || null });
      renderMic();
      throw error;
    }
    const before = await beforePromise;
    const after = await queryMicPermission();
    let devices = [];
    try {
      devices = await state.io.listInputDevices();
    } catch (error) {
      devices = [];
    }
    state.mic.opens += 1;
    state.mic.info = info;
    state.mic.isDefault = isAppDefault(options);
    state.mic.options = options || null;
    state.mic.devices = devices;
    state.mic.lastOpen = {
      at: new Date().toISOString(),
      permissionBefore: before,
      permissionAfter: after,
      permissionWaitMs: info.permissionWaitMs,
      trackLabel: info.trackLabel,
      answered: false,
    };
    await saveRow('settings', { options: options || null, info, devices: devices.map((d) => ({ kind: d.kind, label: d.label })) });
    renderMic({ newOpen: true });
    return info;
  })();
}

/** True when these options are what the app itself asks for (all processing off, session type untouched). */
function isAppDefault(options) {
  if (!options) return true;
  const cfg = state.cfg;
  return (
    !options.sessionType &&
    !options.deviceId &&
    (options.echoCancellation ?? cfg('capture.echoCancellation')) === cfg('capture.echoCancellation') &&
    (options.noiseSuppression ?? cfg('capture.noiseSuppression')) === cfg('capture.noiseSuppression') &&
    (options.autoGainControl ?? cfg('capture.autoGainControl')) === cfg('capture.autoGainControl')
  );
}

/** Open with the app's defaults unless it is already open that way. Call straight from a tap. */
function ensureDefaultMic() {
  if (state.io.listening && state.mic.isDefault) return Promise.resolve(state.mic.info);
  return openMic(null);
}

/** Run one check at a time. `task` is called immediately, so it may open the microphone. */
function runExclusive(statusEl, task) {
  if (state.busy) {
    setStatus(statusEl, 'Another check is still running. Wait for it to finish.', 'warn');
    return;
  }
  state.busy = true;
  setRunButtonsDisabled(true);
  let promise;
  try {
    promise = Promise.resolve(task());
  } catch (error) {
    promise = Promise.reject(error);
  }
  promise
    .catch((error) => {
      try {
        if (state.io) state.io.cancelTake();
      } catch (ignored) {
        // nothing to cancel
      }
      setStatus(statusEl, friendlyError(error), 'bad');
    })
    .finally(() => {
      state.busy = false;
      setRunButtonsDisabled(false);
    });
}

function setRunButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('button.run')) button.disabled = disabled;
}

function takeFacts(take) {
  return {
    durationSec: take.durationSec,
    sampleRate: take.sampleRate,
    peakDb: amplitudeDb(take.peak),
    clipped: take.clipped,
    gaps: take.gaps,
    gapFrames: take.gapFrames,
    zeroRuns: take.zeroRuns,
    wallMinusAudioMs: take.wallMinusAudioMs,
  };
}

/**
 * Play clicks through the metronome while recording, then find each click in
 * the recording. Used for round-trip latency and for the tempo check.
 */
async function runLoopback({ bpm, clicks, gain }) {
  const io = state.io;
  const templates = { normal: io.clickTemplate(false), accent: io.clickTemplate(true) };
  const hiddenBefore = state.hiddenSince;
  io.startTake();
  const metronome = new Metronome(io, state.cfg);
  const totalSec = (clicks * 60) / bpm;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    metronome.start({ bpm, totalBeats: clicks, audible: true, gain, startDelaySec: LOOPBACK_START_DELAY_SEC, onDone: finish });
    // The metronome reports "done" from the screen's redraw loop. If the
    // screen stops redrawing (dimmed, covered), this timer ends the wait.
    setTimeout(finish, (LOOPBACK_START_DELAY_SEC + totalSec + 1) * 1000);
  });
  await sleep(LOOPBACK_TAIL_MS);
  const timerKind = metronome.timerKind || 'worker';
  const log = metronome.stop().slice();
  const take = await io.stopTake();
  const spacing = 60 / bpm;
  const analysis = analyseLoopback({
    samples: take.samples,
    sampleRate: take.sampleRate,
    takeStartTime: take.startTime,
    clicks: log,
    templates,
    bpm,
    searchAfterSec: Math.min(CLICK_SEARCH_AFTER_SEC, CLICK_SEARCH_SPACING_SHARE * spacing),
    minRatio: CLICK_FOUND_MIN_RATIO,
  });
  const described = io.describe();
  return {
    bpm,
    scheduled: analysis.scheduled,
    found: analysis.found,
    delayMs: analysis.delayMs,
    spacing: analysis.spacing,
    scheduledLate: analysis.scheduledLate,
    clickLevelDb: amplitudeDb(analysis.medianAmplitude),
    medianRatio: analysis.medianRatio,
    perClick: analysis.perClick.map((c) => ({ beat: c.beat, found: c.found, delayMs: c.delayMs, lateByMs: c.lateByMs, ratio: c.ratio })),
    timerKind,
    wentHidden: state.hiddenSince !== hiddenBefore || document.visibilityState !== 'visible',
    reportedOutputLatencyMs: described.outputLatency === null ? null : described.outputLatency * 1000,
    reportedBaseLatencyMs: described.baseLatency === null ? null : described.baseLatency * 1000,
    trackLabel: described.trackLabel,
    audioSessionType: described.audioSessionType,
    take: takeFacts(take),
  };
}

// ---- panel: where am I, and what is left to do -------------------------------------

function progressFor(mode) {
  const cfg = state.cfg;
  const situations = new Set(rowsOf('permission', mode).map((r) => r.result.situation));
  const settings = rowsOf('settings', mode).length;
  const clickTone = rowsOf('click-tone', mode);
  const routes = new Set(clickTone.map((r) => r.result.route));
  const latencyLaunches = new Set(rowsOf('latency', mode).filter((r) => r.result.found > 0).map((r) => r.launchId));
  const tempo = new Set(rowsOf('tempo-hold', mode).map((r) => `${r.result.condition}@${r.result.bpm}`));
  const tempoTarget = CONDITIONS.length * cfg('device.tempoHoldBpms').length;
  const tuner = new Set(rowsOf('tuner', mode).map((r) => `${r.result.course}/${r.result.strings}`));
  const tunerTarget = state.tuning.courses.length * 2;
  const wake = rowsOf('wake-lock', mode).filter((r) => r.result.question === 'stayed-on');
  const offline = rowsOf('offline', mode).some((r) => r.result.worked);
  const gaps = rowsOf('survival', mode)
    .filter((r) => r.result.gapDays !== null && r.result.lost.length === 0 && !r.result.firstVisit)
    .map((r) => r.result.gapDays);
  const longestGap = gaps.length ? Math.max(...gaps) : 0;
  const lost = rowsOf('survival', mode).some((r) => r.result.lost.length > 0);
  const latencyTarget = cfg('device.latencyLaunchesTarget');
  const survivalTarget = cfg('device.dataSurvivalDays');
  return [
    ['Permission prompts', `${situations.size} of ${SITUATIONS.length} situations`, situations.size >= SITUATIONS.length],
    ['Audio settings granted', settings ? 'recorded' : 'not yet', settings > 0],
    ['Click and tone, microphone open', clickTone.length ? `${clickTone.length} run${clickTone.length === 1 ? '' : 's'}, ${routes.size} route${routes.size === 1 ? '' : 's'}` : 'not yet', clickTone.length > 0],
    ['Round-trip latency', `${latencyLaunches.size} of ${latencyTarget} launches`, latencyLaunches.size >= latencyTarget],
    ['Metronome holds tempo', `${tempo.size} of ${tempoTarget} runs`, tempo.size >= tempoTarget],
    ['Tuner against a hardware tuner', `${tuner.size} of ${tunerTarget} readings`, tuner.size >= tunerTarget],
    ['Wake lock', wake.length ? (wake[wake.length - 1].result.answer === 'stayed-on' ? 'screen stayed on' : 'screen dimmed or locked') : 'not yet', wake.length > 0],
    ['Offline launch', offline ? 'worked' : 'not yet', offline],
    ['Data survival', !rowsOf('survival', mode).length ? 'not yet' : lost ? 'a marker was lost' : `${longestGap.toFixed(1)} of ${survivalTarget} days unused`, !lost && longestGap >= survivalTarget],
  ];
}

function renderSummary() {
  if (!ui.summary) return;
  const here = progressFor('browser-tab');
  const there = progressFor('home-screen');
  const cell = ([, text, done]) => h('span', { class: `chip ${done ? 'good' : ''}` }, done ? `✓ ${text}` : text);
  clear(ui.summary).append(
    table(
      ['Check', MODE_NAMES['browser-tab'], MODE_NAMES['home-screen']],
      here.map((row, i) => [row[0], cell(row), cell(there[i])])
    )
  );
}

function buildIntro() {
  ui.summary = h('div', {});
  return panel(
    'Where you are',
    null,
    h(
      'p',
      {},
      'This page is running ',
      h('strong', {}, state.mode === 'home-screen' ? 'from the Home Screen icon' : 'in a Safari tab'),
      `. This is launch ${state.launchNumber} of this page in this mode.`
    ),
    h(
      'p',
      {},
      'These checks find out how this iPad behaves, before anything is built on it. Run them once in a Safari tab and once from the Home Screen icon. Each result is saved on this iPad as you go; the last panel puts everything into one file.'
    ),
    ui.summary,
    h(
      'p',
      { class: 'small muted' },
      'On an iPad the Safari tab and the Home Screen app keep separate saved data, so each one shows only its own results in this table. Save the results file from each.'
    ),
    state.testInput
      ? h('div', { class: 'banner' }, 'Test input is on: a built-in synthetic sound stands in for the microphone. Results from this mode say nothing about the real device.')
      : null
  );
}

// ---- panel 1: this device ------------------------------------------------------------

function buildDevice() {
  const env = state.env;
  const feat = state.feat;
  const extra = {
    wakeLock: 'wakeLock' in navigator,
    serviceWorker: 'serviceWorker' in navigator,
    storagePersist: !!(navigator.storage && navigator.storage.persist),
    shareSheet: !!navigator.share,
    cacheStorage: 'caches' in globalThis,
    clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
  };
  state.extraFeatures = extra;
  const facts = [
    ['Mode', MODE_NAMES[env.mode]],
    ['Browser reports itself as', env.userAgent],
    ['Platform', env.platform || '—'],
    ['Touch points', String(env.maxTouchPoints)],
    ['Screen', `${env.screen.width} × ${env.screen.height} at ${env.screen.pixelRatio}×`],
    ['Window', `${env.viewport.width} × ${env.viewport.height}`],
    ['Online', env.online ? 'yes' : 'no'],
    ['Secure page (HTTPS)', env.secureContext ? 'yes' : 'no'],
  ];
  const names = {
    audioContext: 'Web Audio',
    audioWorklet: 'AudioWorklet (analysis on the audio thread)',
    getUserMedia: 'Microphone access',
    enumerateDevices: 'List of audio devices',
    outputLatency: 'Reports output latency',
    baseLatency: 'Reports base latency',
    audioSession: 'Audio session type (Safari only)',
    permissionsQuery: 'Permission state can be read',
    worker: 'Web Worker (metronome timer)',
    wakeLock: 'Screen wake lock',
    serviceWorker: 'Service worker (offline use)',
    storagePersist: 'Can ask to keep saved data',
    shareSheet: 'Share sheet',
    cacheStorage: 'Cache storage',
    clipboard: 'Copy to clipboard',
  };
  const all = { ...feat, ...extra };
  return panel(
    '1. This device',
    'What the browser reports about itself. Nothing here identifies you: no serial number, no account.',
    h('dl', { class: 'kv' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h(
      'details',
      {},
      h('summary', {}, 'What this device supports'),
      table(
        ['Feature', 'Available'],
        Object.keys(all).map((key) => [
          names[key] || key,
          h('span', { class: `chip ${all[key] ? 'good' : 'warn'}` }, all[key] ? 'yes' : 'not available on this device'),
        ])
      )
    )
  );
}

// ---- panels 2 and 3: permission prompts, settings granted ----------------------------

function buildPermission() {
  ui.permissionStatus = h('div', { class: 'hidden' });
  ui.permissionPending = h('div', { class: 'stack' });
  ui.permissionGrid = h('div', {});
  ui.permissionAtLoad = h('p', { class: 'small muted' });
  const button = h(
    'button',
    {
      class: 'primary run',
      onclick: () =>
        runExclusive(ui.permissionStatus, async () => {
          await openMic(null);
          setStatus(ui.permissionStatus, '');
        }),
    },
    'Open the microphone'
  );
  ui.openMicButton = button;
  return panel(
    '2. Permission prompts',
    'Does the iPad ask for the microphone every time? Open the microphone, then say whether a prompt appeared and what you had just done. Try each of the four situations.',
    h('div', { class: 'row' }, button),
    ui.permissionAtLoad,
    ui.permissionStatus,
    ui.permissionPending,
    h('h3', {}, 'Recorded so far'),
    ui.permissionGrid
  );
}

function renderPermissionPending() {
  const box = clear(ui.permissionPending);
  const last = state.mic.lastOpen;
  if (!last || last.answered) return;
  const situation = choice('perm-situation', SITUATIONS, guessSituation());
  const prompt = choice('perm-prompt', [
    ['yes', 'A prompt appeared'],
    ['no', 'No prompt'],
  ]);
  const message = h('div', { class: 'hidden' });
  box.append(
    h(
      'p',
      {},
      `Opened at ${clock(last.at).slice(11)}. The iPad took ${last.permissionWaitMs} ms to answer`,
      last.permissionWaitMs > PROMPT_WAIT_HINT_MS ? ', which usually means a prompt was on screen.' : ', which is quick: usually no prompt.',
      ` Permission state before: ${last.permissionBefore}; after: ${last.permissionAfter}.`
    ),
    h('p', { class: 'small muted' }, 'What had you just done?'),
    situation.el,
    h('p', { class: 'small muted' }, 'What did you see?'),
    prompt.el,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            if (!situation.value || !prompt.value) {
              setStatus(message, 'Choose one answer in each row first.', 'warn');
              return;
            }
            last.answered = true;
            await saveRow('permission', {
              situation: situation.value,
              promptAppeared: prompt.value === 'yes',
              permissionWaitMs: last.permissionWaitMs,
              permissionBefore: last.permissionBefore,
              permissionAfter: last.permissionAfter,
              trackLabel: last.trackLabel,
              openNumberThisLaunch: state.mic.opens,
            });
            renderPermissionPending();
            renderPermissionGrid();
          },
        },
        'Save this answer'
      )
    ),
    message
  );
}

function renderPermissionGrid() {
  const cellFor = (situation, mode) => {
    const rows = rowsOf('permission', mode).filter((r) => r.result.situation === situation);
    if (!rows.length) return h('span', { class: 'muted' }, '—');
    const prompts = rows.filter((r) => r.result.promptAppeared).length;
    const none = rows.length - prompts;
    const parts = [];
    if (prompts) parts.push(`prompt ×${prompts}`);
    if (none) parts.push(`no prompt ×${none}`);
    return parts.join(', ');
  };
  clear(ui.permissionGrid).append(
    table(
      ['Situation', MODE_NAMES['browser-tab'], MODE_NAMES['home-screen']],
      SITUATIONS.map(([id, label]) => [label, cellFor(id, 'browser-tab'), cellFor(id, 'home-screen')])
    )
  );
}

function buildSettings() {
  ui.settingsBody = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Open the microphone (panel 2) to see this.'));
  ui.meterBar = h('i', {});
  ui.meter = h('div', { class: 'meter' }, ui.meterBar);
  ui.meterText = h('span', { class: 'small muted' }, '—');
  ui.events = h('div', {});
  return panel(
    '3. Audio settings granted',
    'The app asks the iPad to leave the sound alone: no echo cancelling, no noise removal, no automatic volume. This shows what the iPad actually gave.',
    h('div', { class: 'row' }, h('span', { class: 'small' }, 'Level'), ui.meter, ui.meterText),
    ui.settingsBody,
    h('details', {}, h('summary', {}, 'Audio events on this launch'), ui.events)
  );
}

function renderMic({ newOpen = false } = {}) {
  const chip = document.getElementById('mic-chip');
  const listening = state.io.listening;
  if (chip) {
    chip.className = `chip ${listening ? 'good' : ''}`;
    chip.textContent = listening ? `Microphone open${state.mic.info && state.mic.info.trackLabel ? `: ${state.mic.info.trackLabel}` : ''}` : 'Microphone closed';
  }
  if (ui.openMicButton) ui.openMicButton.textContent = state.mic.opens ? 'Open the microphone again' : 'Open the microphone';
  if (newOpen) renderPermissionPending();
  renderSettings();
}

function renderSettings() {
  const info = state.mic.info;
  const box = clear(ui.settingsBody);
  if (!info) {
    box.append(h('p', { class: 'muted small' }, 'Open the microphone (panel 2) to see this.'));
    return;
  }
  const asked = info.requested || {};
  const given = info.granted || {};
  const flag = (key) => {
    const a = asked[key];
    const g = given[key];
    const matches = g === undefined ? null : g === a;
    const chipClass = matches === null ? 'warn' : matches ? 'good' : 'bad';
    const chipText = matches === null ? 'not reported' : matches ? 'as asked' : 'not as asked';
    return [yesNo(a), g === undefined ? '—' : yesNo(g), h('span', { class: `chip ${chipClass}` }, chipText)];
  };
  box.append(
    table(
      ['Setting', 'Asked for', 'Given', ''],
      [
        ['Echo cancelling', ...flag('echoCancellation')],
        ['Noise removal', ...flag('noiseSuppression')],
        ['Automatic volume', ...flag('autoGainControl')],
        ['Channels', String(asked.channelCount ?? '—'), String(given.channelCount ?? '—'), ''],
        ['Sample rate of the microphone', '—', given.sampleRate ? `${given.sampleRate} Hz` : 'not reported', ''],
      ]
    ),
    h(
      'dl',
      { class: 'kv' },
      [
        ['Microphone in use', info.trackLabel || '—'],
        ['Sample rate of the audio engine', info.sampleRate ? `${info.sampleRate} Hz` : '—'],
        ['Base latency (reported)', info.baseLatency === null ? 'not available on this device' : `${(info.baseLatency * 1000).toFixed(1)} ms`],
        ['Output latency (reported)', info.outputLatency === null ? 'not available on this device' : `${(info.outputLatency * 1000).toFixed(1)} ms`],
        ['Audio session type', info.audioSessionType || 'not available on this device'],
        ['Opened with', state.mic.isDefault ? 'the app’s defaults (all processing asked off)' : 'the settings chosen in panel 4'],
      ].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
    )
  );
  const devices = state.mic.devices || [];
  box.append(
    h('h3', {}, 'Audio devices the iPad lists'),
    devices.length
      ? h('ul', {}, devices.map((d) => h('li', {}, `${d.kind === 'audioinput' ? 'Input' : 'Output'}: ${d.label || '(no name given)'}`)))
      : h('p', { class: 'muted small' }, 'None listed.')
  );
  box.append(h('details', {}, h('summary', {}, 'Everything reported'), h('pre', {}, JSON.stringify(plain(info), null, 2))));
}

function renderEvents() {
  if (!ui.events) return;
  const events = state.io.events.slice(-15).reverse();
  clear(ui.events).append(
    table(
      ['When', 'Event', 'Detail'],
      events.map((e) => [clock(e.at).slice(11), e.type, JSON.stringify(e.detail || {})]),
      'No audio events yet.'
    )
  );
}

let meterPending = null;
function onLevel(level) {
  meterPending = level;
}
function drawMeter() {
  if (meterPending && ui.meterBar) {
    const db = amplitudeDb(meterPending.peak);
    const percent = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    ui.meterBar.style.width = `${percent}%`;
    ui.meter.classList.toggle('hot', meterPending.peak >= state.cfg('capture.clipLevel'));
    ui.meterText.textContent = db === null ? 'silent' : `${db.toFixed(0)} dB`;
    meterPending = null;
  }
  requestAnimationFrame(drawMeter);
}

// ---- panel 4: click and tone with the microphone open ----------------------------------

function buildClickTone() {
  const form = {
    echo: checkbox('Echo cancelling', false),
    noise: checkbox('Noise removal', false),
    gain: checkbox('Automatic volume', false),
    session: state.feat.audioSession ? select([['leave', 'Leave as it is'], ...SESSION_TYPES.map((t) => [t, t])], 'leave') : null,
    route: select(ROUTES, 'speaker'),
  };
  ui.clickToneForm = form;
  ui.clickToneStatus = h('div', { class: 'hidden' });
  ui.clickToneResult = h('div', { class: 'stack' });
  ui.clickToneTable = h('div', {});
  return panel(
    '4. Click and tone with the microphone open',
    'On an iPad, opening the microphone can make sound from the speaker quieter, crackly or dull. This plays eight clicks, a steady tone and a short burst of hiss while the microphone is open, measures how they come back, and asks what you heard. Run it once for each way you might listen, and again with different settings to compare.',
    h('p', { class: 'small muted' }, 'Ask the iPad for (the app’s own choice is all three off):'),
    h('div', { class: 'row' }, form.echo.el, form.noise.el, form.gain.el),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'How you are listening', form.route.el),
      form.session
        ? h('label', { class: 'field' }, 'Audio session type', form.session.el)
        : h('span', { class: 'small muted' }, 'Audio session type: not available on this device.')
    ),
    h(
      'p',
      { class: 'small muted' },
      'Under headphones the microphone cannot hear these sounds, so the measurements will say “not heard”. Your answers by ear are still recorded. An audio session type, once chosen, stays until this page is reloaded; every later result records which type was in force.'
    ),
    h('div', { class: 'row' }, h('button', { class: 'primary run', onclick: () => runExclusive(ui.clickToneStatus, runClickTone) }, 'Run')),
    ui.clickToneStatus,
    ui.clickToneResult,
    h('h3', {}, 'Runs so far'),
    ui.clickToneTable
  );
}

async function runClickTone() {
  const form = ui.clickToneForm;
  const asked = {
    echoCancellation: form.echo.value,
    noiseSuppression: form.noise.value,
    autoGainControl: form.gain.value,
  };
  const sessionType = form.session ? form.session.value : 'not available';
  const route = form.route.value;
  const options = { ...asked };
  if (form.session && sessionType !== 'leave') options.sessionType = sessionType;

  // Called first, before anything is awaited: this is the tap opening the microphone.
  const info = await openMic(options);
  setStatus(ui.clickToneStatus, 'Playing the test sounds…');
  await sleep(SETTLE_AFTER_OPEN_MS);

  const io = state.io;
  const cfg = state.cfg;
  const gain = route === 'speaker' ? cfg('metronome.clickGainSpeaker') : cfg('metronome.clickGainHeadphones');
  const templates = { normal: io.clickTemplate(false), accent: io.clickTemplate(true) };
  io.startTake();
  const first = io.now() + LOOPBACK_START_DELAY_SEC;
  const clicks = [];
  for (let i = 0; i < CLICK_TONE_CLICKS; i++) {
    const time = first + i * CLICK_TONE_SPACING_SEC;
    io.scheduleClick(time, { accent: false, gain });
    clicks.push({ beat: i, time, accent: false });
  }
  const toneStart = first + CLICK_TONE_CLICKS * CLICK_TONE_SPACING_SEC + 0.3;
  io.scheduleTone(toneStart, { frequencyHz: TONE_HZ, durationSec: TONE_SEC, gain: TONE_GAIN });
  const noiseStart = toneStart + TONE_SEC + 0.3;
  io.scheduleNoise(noiseStart, { durationSec: NOISE_SEC, gain: NOISE_GAIN });
  const endTime = noiseStart + NOISE_SEC + LOOPBACK_TAIL_MS / 1000;
  await sleep((endTime - io.now()) * 1000);
  const take = await io.stopTake();

  const { samples, sampleRate } = take;
  const loop = analyseLoopback({
    samples,
    sampleRate,
    takeStartTime: take.startTime,
    clicks,
    templates,
    searchAfterSec: Math.min(CLICK_SEARCH_AFTER_SEC, CLICK_SEARCH_SPACING_SHARE * CLICK_TONE_SPACING_SEC),
    minRatio: CLICK_FOUND_MIN_RATIO,
  });
  // Later sounds are looked for where the clicks say sound arrives.
  const delaySec = loop.found ? loop.delayMs.median / 1000 : 0;
  const at = (time) => time - take.startTime + delaySec;
  const tone = toneMeasures(samples, sampleRate, at(toneStart) + 0.2, at(toneStart) + TONE_SEC - 0.2, TONE_HZ, { bandPct: TONE_BAND_PCT });
  const toneHeard = tone.purityDb !== null && tone.purityDb >= TONE_HEARD_MIN_PURITY_DB;
  const tilt = noiseTilt(samples, sampleRate, at(noiseStart) + 0.03, at(noiseStart) + NOISE_SEC - 0.03);
  const noiseLevel = levelBetween(samples, sampleRate, at(noiseStart) + 0.03, at(noiseStart) + NOISE_SEC - 0.03);
  const room = levelBetween(samples, sampleRate, 0.05, Math.max(0.1, first - take.startTime - 0.05));
  const noiseHeard = noiseLevel.rmsDb !== null && room.rmsDb !== null && noiseLevel.rmsDb - room.rmsDb >= TONE_HEARD_MIN_PURITY_DB;

  const result = {
    route,
    asked,
    sessionTypeAsked: sessionType,
    granted: info.granted || null,
    audioSessionType: info.audioSessionType,
    trackLabel: info.trackLabel,
    sampleRate,
    clickGain: gain,
    clicksPlayed: CLICK_TONE_CLICKS,
    clicksFound: loop.found,
    clickLevelDb: amplitudeDb(loop.medianAmplitude),
    clickDelayMs: loop.delayMs.median,
    toneHeard,
    toneLevelDb: toneHeard ? tone.toneDb : null,
    tonePurityDb: tone.purityDb,
    noiseHeard,
    noiseHighsDb: noiseHeard ? tilt.tiltDb : null,
    noiseHighsTopHz: tilt.highTopHz,
    roomLevelDb: room.rmsDb,
    take: takeFacts(take),
    byEar: null,
  };
  const row = await saveRow('click-tone', result);
  state.clickTonePending = row;
  setStatus(ui.clickToneStatus, '');
  renderClickToneResult();
  renderClickToneTable();
}

function renderClickToneResult() {
  const box = clear(ui.clickToneResult);
  const row = state.clickTonePending;
  if (!row) return;
  const r = row.result;
  const heardAnything = r.clicksFound > 0 || r.toneHeard || r.noiseHeard;
  add(
    box,
    h('h3', {}, 'This run'),
    heardAnything
      ? null
      : h('div', { class: 'banner' }, 'Not heard: the microphone did not pick up the test sounds. That is expected under headphones. If you were on the speaker, the sound may be very quiet or going somewhere else; say what you heard below.'),
    h(
      'dl',
      { class: 'kv' },
      [
        ['Clicks heard by the microphone', `${r.clicksFound} of ${r.clicksPlayed}`],
        ['Click level', r.clicksFound ? num(r.clickLevelDb, 1, ' dB (0 dB = as loud as the microphone can record)') : 'not heard'],
        ['Tone level', r.toneHeard ? num(r.toneLevelDb, 1, ' dB') : 'not heard'],
        ['Tone purity', r.toneHeard ? `${num(r.tonePurityDb, 1, ' dB')} (higher is cleaner; crackle and distortion pull it down)` : 'not heard'],
        ['Highs in the hiss', r.noiseHeard ? `${num(r.noiseHighsDb, 1, ' dB')} (near 0 = highs intact; far below 0 = highs missing)` : 'not heard'],
        ['Loudest moment in the recording', num(r.take.peakDb, 1, ' dB')],
        ['Clipped samples', String(r.take.clipped)],
        ['Gaps in the recording', `${r.take.gaps} jump${r.take.gaps === 1 ? '' : 's'}, ${r.take.zeroRuns} silent run${r.take.zeroRuns === 1 ? '' : 's'}`],
      ].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
    )
  );
  if (r.byEar) {
    box.append(h('p', { class: 'small muted' }, 'Your answers for this run are saved.'));
    return;
  }
  const crackle = choice('ear-crackle', [
    ['no', 'No'],
    ['a-little', 'A little'],
    ['yes', 'Yes'],
  ]);
  const loudness = choice('ear-loudness', [
    ['normal', 'Normal'],
    ['quieter', 'Quieter than usual'],
    ['very-quiet', 'Very quiet'],
  ]);
  const speakers = choice('ear-speakers', [
    ['both-ends', 'Both ends of the iPad'],
    ['one-end', 'One end'],
    ['headphones', 'Headphones'],
    ['could-not-tell', 'Could not tell'],
  ]);
  const message = h('div', { class: 'hidden' });
  box.append(
    h('p', {}, 'Now three quick answers from your own ears:'),
    h('p', { class: 'small muted' }, 'Did you hear crackle or distortion?'),
    crackle.el,
    h('p', { class: 'small muted' }, 'How loud was it?'),
    loudness.el,
    h('p', { class: 'small muted' }, 'Where did the sound come from?'),
    speakers.el,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            if (!crackle.value || !loudness.value || !speakers.value) {
              setStatus(message, 'Choose one answer in each row first.', 'warn');
              return;
            }
            row.result.byEar = { crackle: crackle.value, loudness: loudness.value, speakers: speakers.value };
            await updateRow(row);
            renderClickToneResult();
            renderClickToneTable();
          },
        },
        'Save what I heard'
      )
    ),
    message
  );
}

function renderClickToneTable() {
  const routeName = Object.fromEntries(ROUTES);
  const rows = rowsOf('click-tone').map((row) => {
    const r = row.result;
    const g = r.granted || {};
    const flags = (o) => `${yesNo(o.echoCancellation)} / ${yesNo(o.noiseSuppression)} / ${yesNo(o.autoGainControl)}`;
    const ear = r.byEar ? `${r.byEar.crackle}, ${r.byEar.loudness}, ${r.byEar.speakers}` : 'not answered';
    return [
      clock(row.at).slice(5, 16),
      MODE_NAMES[row.mode] || row.mode,
      routeName[r.route] || r.route,
      flags(r.asked),
      flags(g),
      r.audioSessionType || '—',
      `${r.clicksFound}/${r.clicksPlayed}`,
      r.clicksFound ? num(r.clickLevelDb, 1) : 'not heard',
      r.toneHeard ? num(r.toneLevelDb, 1) : 'not heard',
      r.toneHeard ? num(r.tonePurityDb, 1) : '—',
      r.noiseHeard ? num(r.noiseHighsDb, 1) : '—',
      String(r.take.clipped),
      ear,
    ];
  });
  clear(ui.clickToneTable).append(
    table(
      ['When', 'Mode', 'Listening on', 'Asked: echo / noise / volume', 'Given', 'Session', 'Clicks', 'Click dB', 'Tone dB', 'Purity dB', 'Highs dB', 'Clipped', 'By ear: crackle, loudness, where'],
      rows
    )
  );
}

// ---- panel 5: round-trip latency ---------------------------------------------------------

function buildLatency() {
  ui.latencyStatus = h('div', { class: 'hidden' });
  ui.latencyBody = h('div', { class: 'stack' });
  const target = state.cfg('device.latencyLaunchesTarget');
  return panel(
    '5. Round-trip latency',
    `The time from the app asking for a click to the microphone hearing it. The app needs this number to judge timing fairly. Use the built-in speaker (unplug headphones), keep the room quiet, and tap Measure. Do this on ${target} separate launches: close the app fully (swipe it away in the app switcher) or close the tab, open it again, and tap Measure.`,
    h('div', { class: 'row' }, h('button', { class: 'primary run', onclick: () => runExclusive(ui.latencyStatus, measureLatency) }, 'Measure')),
    ui.latencyStatus,
    ui.latencyBody
  );
}

async function measureLatency() {
  const cfg = state.cfg;
  // Called first, before anything is awaited: this is the tap opening the microphone.
  await ensureDefaultMic();
  setStatus(ui.latencyStatus, 'Playing clicks and listening for them…');
  await sleep(SETTLE_AFTER_OPEN_MS);
  const run = await runLoopback({
    bpm: cfg('device.loopbackBpm'),
    clicks: cfg('device.loopbackClicks'),
    gain: cfg('metronome.clickGainSpeaker'),
  });
  await saveRow('latency', run);
  if (run.found === 0) {
    setStatus(ui.latencyStatus, 'No clicks were heard. Check that headphones are unplugged and the volume is up, then try again. (This attempt is saved as “not heard”.)', 'warn');
  } else if (run.found < run.scheduled) {
    setStatus(ui.latencyStatus, `Only ${run.found} of ${run.scheduled} clicks were heard clearly. The result is saved; a quieter room or a little more volume may help.`, 'warn');
  } else {
    setStatus(ui.latencyStatus, '');
  }
  renderLatency();
}

function latencySummary(mode) {
  const rows = rowsOf('latency', mode).filter((r) => r.result.found > 0);
  // One result per launch: the last measurement of each launch.
  const byLaunch = new Map();
  for (const row of rows) byLaunch.set(row.launchId, row);
  const perLaunch = [...byLaunch.values()];
  const medians = perLaunch.map((r) => r.result.delayMs.median);
  return { perLaunch, across: summariseDelays(medians) };
}

function renderLatency() {
  const target = state.cfg('device.latencyLaunchesTarget');
  const box = clear(ui.latencyBody);
  for (const mode of ['browser-tab', 'home-screen']) {
    const { perLaunch, across } = latencySummary(mode);
    add(
      box,
      h('h3', {}, `${MODE_NAMES[mode]}: ${perLaunch.length} of ${target} launches measured`),
      perLaunch.length
        ? h(
            'p',
            {},
            `Across launches: middle value ${num(across.median, 1, ' ms')}, from ${num(across.min, 1, ' ms')} to ${num(across.max, 1, ' ms')} (range ${num(across.range, 1, ' ms')}).`
          )
        : null,
      table(
        ['Launch', 'When', 'Delay (middle)', 'Range in this run', 'Spread', 'Clicks heard', 'Peak over background', 'Reported output latency'],
        perLaunch.map((row) => {
          const r = row.result;
          return [
            String(row.launchNumber ?? '—'),
            clock(row.at).slice(5, 16),
            num(r.delayMs.median, 1, ' ms'),
            num(r.delayMs.range, 2, ' ms'),
            num(r.delayMs.mad, 2, ' ms'),
            `${r.found}/${r.scheduled}`,
            r.medianRatio === null ? '—' : `${num(r.medianRatio, 0)}×`,
            r.reportedOutputLatencyMs === null ? 'not available' : num(r.reportedOutputLatencyMs, 1, ' ms'),
          ];
        }),
        'No launch measured yet.'
      )
    );
  }
  const unheard = rowsOf('latency').filter((r) => r.result.found === 0).length;
  if (unheard) box.append(h('p', { class: 'small muted' }, `${unheard} attempt${unheard === 1 ? '' : 's'} heard no clicks and ${unheard === 1 ? 'is' : 'are'} not counted above.`));
  box.append(
    h(
      'p',
      { class: 'small muted' },
      '“Spread” is the typical distance of one click from the middle value. “Peak over background” says how clearly the clicks stood out; a small number means a noisy room or a very quiet click.'
    )
  );
}

// ---- panel 6: metronome holds tempo --------------------------------------------------------

function buildTempoHold() {
  const cfg = state.cfg;
  ui.tempoCondition = select(CONDITIONS, 'normal');
  ui.tempoWait = select(
    TEMPO_HOLD_WAIT_CHOICES_SEC.map((s) => [String(s), s === 0 ? 'Start straight away' : `Wait ${s / 60} minute${s === 60 ? '' : 's'} first`]),
    '0'
  );
  ui.tempoStatus = h('div', { class: 'hidden' });
  ui.tempoTable = h('div', {});
  const bpms = cfg('device.tempoHoldBpms');
  return panel(
    '6. Metronome holds tempo',
    `Checks that the clicks stay evenly spaced at ${bpms.join(', ')} beats a minute, including with the screen dimmed and in Split View. Built-in speaker, quiet room. Choose the condition you have set up, then run; each run plays ${cfg('device.tempoHoldClicks')} clicks at each tempo.`,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'Condition', ui.tempoCondition.el),
      h('label', { class: 'field' }, 'Before starting', ui.tempoWait.el)
    ),
    h(
      'p',
      { class: 'small muted' },
      'For “Screen dimmed”, turn the wake lock off (panel 8), choose a wait, tap Run and leave the iPad alone so the screen dims before the clicks start. If the iPad locks, the run pauses until you unlock it, and that is noted.'
    ),
    h('div', { class: 'row' }, h('button', { class: 'primary run', onclick: () => runExclusive(ui.tempoStatus, runTempoHold) }, 'Run')),
    ui.tempoStatus,
    ui.tempoTable
  );
}

async function runTempoHold() {
  const cfg = state.cfg;
  const condition = ui.tempoCondition.value;
  const waitSec = Number(ui.tempoWait.value) || 0;
  // Called first, before anything is awaited: this is the tap opening the microphone.
  await ensureDefaultMic();
  for (let left = waitSec; left > 0; left--) {
    setStatus(ui.tempoStatus, `Waiting ${left} s before the clicks start…`);
    await sleep(1000);
  }
  await sleep(SETTLE_AFTER_OPEN_MS);
  for (const bpm of cfg('device.tempoHoldBpms')) {
    setStatus(ui.tempoStatus, `Playing ${bpm} beats a minute…`);
    const run = await runLoopback({ bpm, clicks: cfg('device.tempoHoldClicks'), gain: cfg('metronome.clickGainSpeaker') });
    await saveRow('tempo-hold', { condition, waitSec, ...run });
    renderTempoHold();
    await sleep(400);
  }
  setStatus(ui.tempoStatus, '');
}

function renderTempoHold() {
  const names = Object.fromEntries(CONDITIONS);
  clear(ui.tempoTable).append(
    table(
      ['When', 'Mode', 'Condition', 'Tempo', 'Worst spacing error', 'Typical spacing error', 'Clicks heard', 'Scheduled late', 'Timer', 'Page hidden during run'],
      rowsOf('tempo-hold').map((row) => {
        const r = row.result;
        const spacing = r.spacing || {};
        return [
          clock(row.at).slice(5, 16),
          MODE_NAMES[row.mode] || row.mode,
          names[r.condition] || r.condition,
          `${r.bpm} bpm`,
          num(spacing.worstMs, 2, ' ms'),
          num(spacing.meanAbsMs, 2, ' ms'),
          `${r.found}/${r.scheduled}`,
          String(r.scheduledLate),
          r.timerKind === 'worker' ? 'Web Worker' : 'page timer (fallback)',
          r.wentHidden ? 'yes' : 'no',
        ];
      })
    ),
    h(
      'p',
      { class: 'small muted' },
      '“Spacing error” is how far the gap between two heard clicks strays from the exact gap for that tempo. “Scheduled late” counts clicks the page handed over after their time had already passed.'
    )
  );
}

// ---- panel 7: pitch readout against a hardware tuner ------------------------------------------

function buildTuner() {
  const courses = state.tuning.courses;
  ui.tunerToggle = h(
    'button',
    {
      class: 'primary run',
      onclick: () => {
        if (state.tuner.on) {
          state.tuner.on = false;
          renderTunerReadout();
          return;
        }
        runExclusive(ui.tunerStatus, async () => {
          // Called first, before anything is awaited: this is the tap opening the microphone.
          await ensureDefaultMic();
          state.tuner.on = true;
          state.tuner.filled = 0;
          state.tuner.readings = [];
          setStatus(ui.tunerStatus, '');
          renderTunerReadout();
        });
      },
    },
    'Start the readout'
  );
  ui.tunerStatus = h('div', { class: 'hidden' });
  ui.tunerReadout = h('div', { class: 'cue' });
  ui.tunerCourse = choice('tuner-course', courses.map((c) => [c, `${c} course`]), courses[0]);
  ui.tunerStrings = choice('tuner-strings', [
    ['one', 'One string'],
    ['both', 'Both strings'],
  ], 'one');
  ui.tunerHardware = h('input', { type: 'number', step: '0.5', inputmode: 'decimal', placeholder: 'e.g. -3', style: 'width: 8em' });
  ui.tunerLogStatus = h('div', { class: 'hidden' });
  ui.tunerTable = h('div', {});
  return panel(
    '7. Tuner reading against a hardware tuner',
    'This shows the pitch the page hears, to compare with your own tuner. Play one open string (touch its partner so it stays silent), read both, and log the pair. Then let both strings of the course ring and log again. It is only a readout for this check, not the app’s tuner.',
    h('div', { class: 'row' }, ui.tunerToggle),
    ui.tunerStatus,
    ui.tunerReadout,
    h('h3', {}, 'Log a reading'),
    ui.tunerCourse.el,
    ui.tunerStrings.el,
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Your tuner shows (cents; flat is negative)', ui.tunerHardware), h('button', { class: 'primary', onclick: logTunerReading }, 'Log reading')),
    ui.tunerLogStatus,
    ui.tunerTable
  );
}

function onFrames(samples, frame, sampleRate) {
  const t = state.tuner;
  if (!t.on) return;
  const cfg = state.cfg;
  const size = cfg('device.tunerWindowSamples');
  if (!t.ring || t.ring.length !== size) {
    t.ring = new Float32Array(size);
    t.filled = 0;
  }
  if (samples.length >= size) {
    t.ring.set(samples.subarray(samples.length - size));
  } else {
    t.ring.copyWithin(0, samples.length);
    t.ring.set(samples, size - samples.length);
  }
  t.filled = Math.min(size, t.filled + samples.length);
  t.sinceLast += samples.length;
  if (t.filled < size || t.sinceLast < TUNER_HOP_SAMPLES) return;
  t.sinceLast = 0;
  const result = detectPitch(t.ring, sampleRate, { minHz: TUNER_MIN_HZ, maxHz: TUNER_MAX_HZ, peakPick: TUNER_PEAK_PICK });
  const now = performance.now();
  t.last = { at: now, ...result };
  if (result.frequencyHz && result.clarity >= cfg('device.tunerClarityMin')) {
    t.readings.push({ at: now, hz: result.frequencyHz, clarity: result.clarity });
  }
  while (t.readings.length && now - t.readings[0].at > 5000) t.readings.shift();
  renderTunerReadout();
}

/** The middle of the clear readings in the last stretch, or null. */
function recentPitch(windowMs, maxCount = Infinity) {
  const now = performance.now();
  let recent = state.tuner.readings.filter((r) => now - r.at <= windowMs);
  if (recent.length > maxCount) recent = recent.slice(-maxCount);
  if (!recent.length) return null;
  return { hz: median(recent.map((r) => r.hz)), clarity: median(recent.map((r) => r.clarity)), count: recent.length };
}

function renderTunerReadout() {
  const t = state.tuner;
  ui.tunerToggle.textContent = t.on ? 'Stop the readout' : 'Start the readout';
  const box = clear(ui.tunerReadout);
  if (!t.on) {
    box.append(h('div', { class: 'sub-text muted' }, 'Readout is off'));
    return;
  }
  const a4 = state.cfg('analysis.referenceA4Hz');
  const pitch = recentPitch(TUNER_LOG_WINDOW_MS, TUNER_DISPLAY_READINGS);
  if (!pitch) {
    box.append(
      h('div', { class: 'big-text muted' }, '—'),
      h('div', { class: 'sub-text muted' }, 'Play one string and let it ring'),
      h('div', { class: 'small muted' }, t.last ? `Clarity ${num(t.last.clarity, 2)} (needs ${state.cfg('device.tunerClarityMin')} or more)` : 'Listening…')
    );
    return;
  }
  const note = nearestNote(pitch.hz, a4);
  const sign = note.cents >= 0 ? '+' : '−';
  box.append(
    h('div', { class: 'big-text' }, `${note.name}  ${sign}${Math.abs(note.cents).toFixed(1)} cents`),
    h('div', { class: 'sub-text' }, `${pitch.hz.toFixed(2)} Hz`),
    h('div', { class: 'small muted' }, `Clarity ${num(pitch.clarity, 2)} · A = ${a4} Hz`)
  );
}

async function logTunerReading() {
  const a4 = state.cfg('analysis.referenceA4Hz');
  if (!state.tuner.on) {
    setStatus(ui.tunerLogStatus, 'Start the readout first.', 'warn');
    return;
  }
  const hardware = ui.tunerHardware.value.trim();
  if (hardware === '' || !Number.isFinite(Number(hardware))) {
    setStatus(ui.tunerLogStatus, 'Type what your tuner shows, in cents (0 if it shows dead on).', 'warn');
    return;
  }
  const pitch = recentPitch(TUNER_LOG_WINDOW_MS);
  if (!pitch || pitch.count < 2) {
    setStatus(ui.tunerLogStatus, 'No steady note was heard in the last second. Play the string, let it ring, and tap Log reading while it sounds.', 'warn');
    return;
  }
  const course = ui.tunerCourse.value;
  const index = state.tuning.courses.indexOf(course);
  const targetHz = midiToHz(state.tuning.openMidi[index], a4);
  const pageCents = centsBetween(pitch.hz, targetHz);
  if (Math.abs(pageCents) > TUNER_MAX_CENTS_FROM_COURSE) {
    setStatus(ui.tunerLogStatus, `The page heard ${pitch.hz.toFixed(1)} Hz, which is not near the open ${course} course (${targetHz.toFixed(1)} Hz). Check which course is chosen, or play the open string again.`, 'warn');
    return;
  }
  await saveRow('tuner', {
    course,
    strings: ui.tunerStrings.value,
    hardwareCents: Number(hardware),
    pageHz: pitch.hz,
    pageCents,
    differenceCents: pageCents - Number(hardware),
    clarity: pitch.clarity,
    readingsUsed: pitch.count,
    referenceA4Hz: a4,
    trackLabel: state.mic.info ? state.mic.info.trackLabel : null,
  });
  setStatus(ui.tunerLogStatus, '');
  ui.tunerHardware.value = '';
  renderTunerTable();
}

function renderTunerTable() {
  clear(ui.tunerTable).append(
    table(
      ['When', 'Mode', 'Course', 'Strings', 'Your tuner', 'This page', 'Difference', 'Clarity'],
      rowsOf('tuner').map((row) => {
        const r = row.result;
        return [
          clock(row.at).slice(5, 16),
          MODE_NAMES[row.mode] || row.mode,
          r.course,
          r.strings === 'one' ? 'one' : 'both',
          num(r.hardwareCents, 1, ' cents'),
          `${num(r.pageCents, 1, ' cents')} (${num(r.pageHz, 2, ' Hz')})`,
          num(r.differenceCents, 1, ' cents'),
          num(r.clarity, 2),
        ];
      })
    )
  );
}

// ---- panel 8: wake lock --------------------------------------------------------------------------

function buildWakeLock() {
  ui.wakeState = h('div', {});
  ui.wakeHistory = h('div', {});
  ui.wakeAnswers = h('div', {});
  const lock = state.wakeLock;
  return panel(
    '8. Wake lock',
    'Keeps the screen from dimming and locking during practice. Turn it on, leave the iPad untouched for longer than its Auto-Lock time (Settings, then Display & Brightness, then Auto-Lock), and say what happened.',
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', onclick: () => lock.request() }, 'Keep the screen on'),
      h('button', { onclick: () => lock.release().then(renderWakeLock) }, 'Let the screen sleep again')
    ),
    ui.wakeState,
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => answerWakeLock('stayed-on') }, 'The screen stayed on'),
      h('button', { onclick: () => answerWakeLock('dimmed-or-locked') }, 'The screen dimmed or locked')
    ),
    ui.wakeAnswers,
    h('details', {}, h('summary', {}, 'What the wake lock did on this launch'), ui.wakeHistory)
  );
}

async function answerWakeLock(answer) {
  const lock = state.wakeLock;
  await saveRow('wake-lock', { question: 'stayed-on', answer, state: lock.state(), history: lock.history });
  renderWakeLock();
}

function renderWakeLock() {
  const lock = state.wakeLock;
  const s = lock.state();
  clear(ui.wakeState).append(
    !s.supported
      ? h('span', { class: 'chip warn' }, 'Wake lock: not available on this device')
      : h('span', { class: `chip ${s.held ? 'good' : ''}` }, s.held ? 'Wake lock is on' : s.wanted ? 'Wake lock was asked for but is not held' : 'Wake lock is off')
  );
  clear(ui.wakeHistory).append(
    table(
      ['When', 'What happened', 'Detail'],
      lock.history.map((e) => [clock(e.at).slice(11), e.type, e.detail || '']),
      'Nothing yet.'
    )
  );
  const answers = rowsOf('wake-lock');
  const label = (r) => {
    if (r.result.question === 'stayed-on') return r.result.answer === 'stayed-on' ? 'You said: the screen stayed on' : 'You said: the screen dimmed or locked';
    return r.result.held ? 'Came back to the page: wake lock was taken again' : 'Came back to the page: wake lock was NOT taken again';
  };
  clear(ui.wakeAnswers).append(
    table(
      ['When', 'Mode', 'Recorded'],
      answers.map((row) => [clock(row.at).slice(5, 16), MODE_NAMES[row.mode] || row.mode, label(row)])
    )
  );
}

// ---- panel 9: offline launch ------------------------------------------------------------------------

function buildOffline() {
  ui.offlineBody = h('div', { class: 'stack' });
  return panel(
    '9. Offline launch',
    'The pages should open with no connection. With this page loaded once, turn on Airplane Mode, close the app or tab fully, and open it again. If it opens, that is recorded by itself.',
    ui.offlineBody,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          onclick: async () => {
            const result = await probeOffline();
            await saveRow('offline', { worked: true, recordedBy: 'tap', ...result });
            renderOffline();
          },
        },
        'Record: it opened with no connection'
      )
    )
  );
}

async function probeOffline() {
  const result = {
    online: navigator.onLine,
    serviceWorker: {
      supported: 'serviceWorker' in navigator,
      controlling: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      scope: state.sw.scope || null,
      error: state.sw.error || null,
    },
    fetch: null,
  };
  const started = performance.now();
  try {
    const response = await fetch(new URL('../../config.json', import.meta.url), { cache: 'no-store' });
    result.fetch = { ok: response.ok, status: response.status, ms: Math.round(performance.now() - started) };
  } catch (error) {
    result.fetch = { ok: false, error: describeError(error), ms: Math.round(performance.now() - started) };
  }
  return result;
}

function renderOffline() {
  const o = state.offline;
  const box = clear(ui.offlineBody);
  if (o) {
    const sw = o.serviceWorker;
    box.append(
      h(
        'dl',
        { class: 'kv' },
        [
          ['Connection right now', o.online ? 'online' : 'offline'],
          ['Service worker', !sw.supported ? 'not available on this device' : sw.error ? `could not be set up (${sw.error})` : sw.controlling ? 'set up and serving this page' : 'set up; it takes over from the next launch'],
          ['Its scope', sw.scope || '—'],
          ['Fetching the app’s own config file', o.fetch.ok ? `worked (${o.fetch.ms} ms)` : `failed (${o.fetch.error || o.fetch.status})`],
        ].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
      )
    );
  }
  const worked = rowsOf('offline').filter((r) => r.result.worked);
  box.append(
    table(
      ['When', 'Mode', 'How it was recorded', 'Config file fetched'],
      worked.map((row) => [
        clock(row.at).slice(5, 16),
        MODE_NAMES[row.mode] || row.mode,
        row.result.recordedBy === 'tap' ? 'you tapped the button' : 'by itself (the page loaded while offline)',
        row.result.fetch && row.result.fetch.ok ? 'yes' : 'no',
      ]),
      'No offline launch recorded yet.'
    )
  );
}

// ---- panel 10: data survival -------------------------------------------------------------------------

async function readMarkers() {
  const out = { indexedDb: { present: false }, localStorage: { present: false }, cache: { present: false } };
  try {
    const marker = await kvGet(SURVIVAL.kvKey, null);
    if (marker) out.indexedDb = { present: true, writtenAt: marker.writtenAt };
  } catch (error) {
    out.indexedDb = { present: false, error: describeError(error) };
  }
  try {
    const raw = globalThis.localStorage ? localStorage.getItem(SURVIVAL.localKey) : null;
    if (raw) out.localStorage = { present: true, writtenAt: JSON.parse(raw).writtenAt };
    else if (!globalThis.localStorage) out.localStorage = { present: false, error: 'not available on this device' };
  } catch (error) {
    out.localStorage = { present: false, error: describeError(error) };
  }
  try {
    if (!('caches' in globalThis)) {
      out.cache = { present: false, error: 'not available on this device' };
    } else {
      const cache = await caches.open(SURVIVAL.cacheName);
      const response = await cache.match(SURVIVAL.cacheUrl);
      if (response) out.cache = { present: true, writtenAt: (await response.json()).writtenAt };
    }
  } catch (error) {
    out.cache = { present: false, error: describeError(error) };
  }
  return out;
}

async function writeMarker(area, writtenAt, note) {
  const marker = { writtenAt, mode: state.mode, note };
  if (area === 'indexedDb') await kvSet(SURVIVAL.kvKey, marker);
  if (area === 'localStorage') localStorage.setItem(SURVIVAL.localKey, JSON.stringify(marker));
  if (area === 'cache') {
    const cache = await caches.open(SURVIVAL.cacheName);
    await cache.put(SURVIVAL.cacheUrl, new Response(JSON.stringify(marker), { headers: { 'Content-Type': 'application/json' } }));
  }
}

async function readLastVisit() {
  let fromDb = null;
  let fromLocal = null;
  try {
    fromDb = await kvGet(SURVIVAL.kvLastVisit, null);
  } catch (error) {
    fromDb = null;
  }
  try {
    fromLocal = globalThis.localStorage ? localStorage.getItem(SURVIVAL.localLastVisit) : null;
  } catch (error) {
    fromLocal = null;
  }
  const candidates = [fromDb, fromLocal].filter(Boolean).sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

async function checkSurvival() {
  const now = new Date();
  const nowIso = now.toISOString();
  const found = await readMarkers();
  const areas = ['indexedDb', 'localStorage', 'cache'];
  const anyPresent = areas.some((a) => found[a].present);
  const usable = areas.filter((a) => !found[a].error || found[a].present);
  // A marker is "lost" when it is missing while another one survived.
  const lost = anyPresent ? usable.filter((a) => !found[a].present) : [];
  const previousVisitAt = await readLastVisit();
  // Every page of the site notes its visits, so "unused" means the whole site (shell.js).
  const visit = noteVisit();
  const markers = {};
  for (const area of areas) {
    const m = found[area];
    markers[area] = {
      present: m.present,
      writtenAt: m.writtenAt || null,
      ageDays: m.present && m.writtenAt ? daysBetween(m.writtenAt, now) : null,
      error: m.error || null,
    };
  }
  // Write what is missing. An existing marker is never overwritten.
  const written = [];
  for (const area of usable) {
    if (found[area].present) continue;
    try {
      await writeMarker(area, nowIso, anyPresent ? 'rewritten after being lost' : 'first visit');
      written.push(area);
    } catch (error) {
      markers[area].error = describeError(error);
    }
  }
  const persistence = await requestPersistence();
  const result = {
    firstVisit: !anyPresent,
    markers,
    lost,
    written,
    previousVisitAt,
    gapDays: previousVisitAt ? daysBetween(previousVisitAt, now) : null,
    longestGap: visit.longest || null,
    persistence: plain(persistence),
  };
  state.survival = result;
  state.persistence = persistence;
  await saveRow('survival', result);
  try {
    await kvSet(SURVIVAL.kvLastVisit, nowIso);
  } catch (error) {
    // saveRow has already reported broken storage
  }
}

function buildSurvival() {
  ui.survivalBody = h('div', { class: 'stack' });
  const days = state.cfg('device.dataSurvivalDays');
  return panel(
    '10. Data survival',
    `Safari can clear a site’s saved data if the site is left unused. Three dated markers are written here on the first visit, one in each kind of storage. Leave every page of this site unopened in this mode for ${days} days, come back, and this panel shows whether they survived. The Safari tab and the Home Screen app keep separate data, so each has its own markers and its own ${days} days.`,
    ui.survivalBody
  );
}

function renderSurvival() {
  const s = state.survival;
  const box = clear(ui.survivalBody);
  if (!s) {
    box.append(h('p', { class: 'muted small' }, 'Checking…'));
    return;
  }
  const names = { indexedDb: 'Database (where practice history will live)', localStorage: 'Simple site storage', cache: 'Offline file cache' };
  if (s.firstVisit) {
    box.append(h('div', { class: 'banner' }, 'No markers were found, so they were written just now. Either this is the first visit in this mode, or everything saved here had been cleared.'));
  } else if (s.lost.length) {
    box.append(h('div', { class: 'banner bad' }, `Lost since the last visit: ${s.lost.map((a) => names[a]).join('; ')}. A new marker was written and the loss is recorded.`));
  } else {
    box.append(h('div', { class: 'banner good' }, 'All markers from earlier visits are still here.'));
  }
  box.append(
    table(
      ['Storage', 'Marker', 'Written', 'Age'],
      Object.keys(names).map((area) => {
        const m = s.markers[area];
        const status = m.error && !m.present ? `not usable (${m.error})` : m.present ? 'still here' : s.written.includes(area) ? 'written just now' : 'missing';
        return [names[area], status, m.writtenAt ? clock(m.writtenAt).slice(0, 16) : '—', m.ageDays === null ? '—' : `${m.ageDays.toFixed(1)} days`];
      })
    )
  );
  const p = s.persistence || {};
  const quota = p.estimate && p.estimate.quota ? `${(p.estimate.usage / 1048576).toFixed(1)} MB used of about ${(p.estimate.quota / 1048576).toFixed(0)} MB allowed` : 'not reported';
  box.append(
    h(
      'dl',
      { class: 'kv' },
      [
        ['Time since any page of this site was last opened', s.gapDays === null ? 'this is the first recorded visit' : `${s.gapDays.toFixed(1)} days`],
        ['Longest stretch unused so far', s.longestGap ? `${s.longestGap.days.toFixed(1)} days (target: ${state.cfg('device.dataSurvivalDays')})` : 'none recorded yet'],
        ['Asked the iPad to keep this data', !p.supported ? 'not available on this device' : p.error ? `failed (${p.error})` : p.granted ? 'yes: it agreed' : 'it did not agree (data may be cleared when unused)'],
        ['Storage', quota],
      ].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
    )
  );
}

// ---- panel 11: save the results ------------------------------------------------------------------------

function buildExport() {
  ui.exportStatus = h('div', { class: 'hidden' });
  ui.exportCount = h('p', { class: 'small muted' });
  const buttons = [
    h('button', { class: 'primary', onclick: () => exportResults('share') }, 'Save the results file'),
    h('button', { onclick: () => exportResults('download') }, 'Download instead'),
  ];
  if (navigator.clipboard && navigator.clipboard.writeText) buttons.push(h('button', { onclick: () => exportResults('copy') }, 'Copy as text'));
  return panel(
    '11. Save the results',
    'Puts every result recorded here into one file. “Save the results file” opens the share sheet: choose Save to Files. Do this once in the Safari tab and once in the Home Screen app, because each keeps its own results.',
    h('div', { class: 'row' }, buttons),
    ui.exportCount,
    ui.exportStatus
  );
}

/** Built from what is already in memory, so the share sheet opens straight from the tap. */
function buildExportText() {
  const cfg = state.cfg;
  return JSON.stringify(
    {
      format: 'practice-device-check',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedFromMode: state.mode,
      launchId: state.launchId,
      launchNumber: state.launchNumber,
      configVersion: cfg.version,
      config: cfg.snapshot(['device.', 'metronome.', 'capture.', 'analysis.']),
      device: plain(state.env),
      features: plain({ ...state.feat, ...(state.extraFeatures || {}) }),
      survivalNow: plain(state.survival),
      audioEventsThisLaunch: plain(state.io.events),
      wakeLockThisLaunch: plain(state.wakeLock.history),
      testInput: state.testInput,
      rows: state.rows,
    },
    null,
    2
  );
}

function exportResults(how) {
  const text = buildExportText();
  const filename = `device-check-${todayIso()}.json`;
  if (how === 'copy') {
    navigator.clipboard.writeText(text).then(
      () => setStatus(ui.exportStatus, 'Copied. Paste it into a note or a message to yourself.', 'good'),
      (error) => setStatus(ui.exportStatus, `Could not copy (${describeError(error)}). Try the other buttons.`, 'bad')
    );
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  if (how === 'download') {
    downloadFile(blob, filename);
    setStatus(ui.exportStatus, `Download started: ${filename}. Look in the Downloads folder in Files.`, 'good');
    return;
  }
  shareFile(blob, filename, 'application/json').then((outcome) => {
    if (outcome.ok) setStatus(ui.exportStatus, `Shared: ${filename}.`, 'good');
    else if (outcome.cancelled) setStatus(ui.exportStatus, 'Nothing was saved (the share sheet was closed).', 'warn');
    else setStatus(ui.exportStatus, `The share sheet did not work here (${outcome.reason}). Use “Download instead”.`, 'warn');
  });
}

function renderExportCount() {
  if (!ui.exportCount) return;
  const mine = state.rows.filter((r) => r.mode === state.mode).length;
  ui.exportCount.textContent = `${state.rows.length} result${state.rows.length === 1 ? '' : 's'} saved on this device (${mine} from this mode).`;
}

// ---- start-up ---------------------------------------------------------------------------------------------

async function loadTuning() {
  try {
    const response = await fetch(new URL('../../data/chords.mandolin.json', import.meta.url));
    if (!response.ok) return;
    const data = await response.json();
    if (data.tuning && Array.isArray(data.tuning.courses) && Array.isArray(data.tuning.openMidi)) {
      state.tuning = { courses: data.tuning.courses, openMidi: data.tuning.openMidi };
    }
  } catch (error) {
    // keep the built-in G D A E tuning
  }
}

async function init() {
  installErrorSurface();
  const app = document.getElementById('app');
  state.cfg = await loadConfig();
  readNumbers(state.cfg);
  state.env = envInfo();
  state.feat = features();
  state.mode = state.env.mode;
  const params = new URLSearchParams(location.search);
  state.testInput = params.has('test-input') || params.get('testInput') === '1';
  state.io = createAudioIO(state.cfg, { testInput: state.testInput });

  const modeChip = document.getElementById('mode-chip');
  if (modeChip) modeChip.textContent = MODE_NAMES[state.mode];

  // A launch is one load of this page.
  const counterKey = `device-check-launches-${state.mode}`;
  try {
    state.launchNumber = (await kvGet(counterKey, 0)) + 1;
    await kvSet(counterKey, state.launchNumber);
    state.rows = await dbGetAll('device');
  } catch (error) {
    state.launchNumber = 1;
    noteStorageBroken(error);
  }
  state.launchId = `${state.mode}-${state.launchNumber}-${Date.now().toString(36)}`;

  await loadTuning();
  state.sw = await registerServiceWorker();
  state.wakeLock = new WakeLock(() => {
    if (ui.wakeState) renderWakeLock();
  });

  const loading = document.getElementById('loading');
  if (loading) loading.remove();
  app.append(
    buildIntro(),
    buildDevice(),
    buildPermission(),
    buildSettings(),
    buildClickTone(),
    buildLatency(),
    buildTempoHold(),
    buildTuner(),
    buildWakeLock(),
    buildOffline(),
    buildSurvival(),
    buildExport()
  );

  // Live hooks.
  state.io.onLevel(onLevel);
  state.io.onFrames(onFrames);
  state.io.onEvent((entry) => {
    renderEvents();
    if (entry.type === 'track-ended' || entry.type === 'listening-stopped') renderMic();
  });
  requestAnimationFrame(drawMeter);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      state.hiddenSince += 1;
      return;
    }
    renderMic();
    // Did the wake lock come back after being away?
    if (state.wakeLock.wanted) {
      setTimeout(async () => {
        await saveRow('wake-lock', { question: 'came-back', held: state.wakeLock.state().held, state: state.wakeLock.state() });
        renderWakeLock();
      }, 1500);
    }
  });

  // First renders.
  renderSummary();
  renderPermissionGrid();
  renderEvents();
  renderClickToneTable();
  renderLatency();
  renderTempoHold();
  renderTunerReadout();
  renderTunerTable();
  renderWakeLock();
  renderSurvival();
  renderExportCount();

  // Things recorded by themselves on every launch.
  await saveRow('launch', { device: state.env, features: { ...state.feat, ...state.extraFeatures }, serviceWorker: state.sw, testInput: state.testInput });

  const atLoad = await queryMicPermission();
  ui.permissionAtLoad.textContent = `Permission state when this page opened: ${atLoad}.`;

  state.offline = await probeOffline();
  if (!state.offline.online) await saveRow('offline', { worked: true, recordedBy: 'page', ...state.offline });
  renderOffline();

  await checkSurvival();
  renderSurvival();
  renderSummary();
  renderExportCount();
}

init().catch((error) => {
  const box = document.getElementById('errors');
  if (box) box.append(h('div', { class: 'banner bad' }, `The page could not start: ${describeError(error)}`));
});
