// The recording script from spec section 11 ("What he records"), built take by
// take from the config and the chosen chords. Pure functions: no browser APIs,
// so the same code is tested under Node.
//
// Every take carries its own labels (chord, the shape actually played, the
// condition, tempo, click route), so the analysis never has to guess.

import { COURSE_NAMES, fretsText } from '../ui/chord-diagram.js';

/** Shapes with one finger a fret off, for a given chord shape. */
export function fretOffVariants(frets, count, rotate = 0) {
  const fretted = frets.map((fret, course) => ({ fret, course })).filter((x) => x.fret !== null && x.fret > 0);
  const variants = [];
  const seen = new Set([fretsText(frets)]);
  for (let k = 0; k < fretted.length * 2 && variants.length < count; k++) {
    const pick = fretted[(k + rotate) % fretted.length];
    // Alternate: up a fret, then down a fret where that still leaves a fretted note.
    const down = variants.length % 2 === 1 && pick.fret >= 2;
    const toFret = down ? pick.fret - 1 : pick.fret + 1;
    const playedFrets = frets.slice();
    playedFrets[pick.course] = toFret;
    const key = fretsText(playedFrets);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ courseIndex: pick.course, course: COURSE_NAMES[pick.course], fromFret: pick.fret, toFret, playedFrets });
  }
  return variants;
}

function strumCues(cfg, count, { dynamics = ['medium'], strokes = ['down'], labels = null } = {}) {
  const leadIn = cfg('script.leadInSec');
  const interval = cfg('script.strumCueIntervalSec');
  const cues = [];
  for (let i = 0; i < count; i++) {
    cues.push({
      i,
      t: leadIn + i * interval,
      dynamic: dynamics[i % dynamics.length],
      stroke: strokes[i % strokes.length],
      label: labels ? labels[i] : null,
    });
  }
  const durationSec = leadIn + count * interval + Math.max(0, cfg('script.tailSec') - interval);
  return { cues, durationSec };
}

function strumTake(cfg, chord, base) {
  const count = base.count;
  const { cues, durationSec } = strumCues(cfg, count, base.cueOptions);
  return {
    kind: 'strums',
    block: `chord:${chord.id}`,
    blockTitle: `${chord.name} (${fretsText(chord.frets)})`,
    chordId: chord.id,
    chordName: chord.name,
    targetFrets: chord.frets,
    playedFrets: base.playedFrets || chord.frets,
    condition: base.condition,
    conditionDetail: base.conditionDetail || null,
    marks: base.marks || {},
    id: base.id,
    title: base.title,
    lines: base.lines,
    cues,
    durationSec,
  };
}

/**
 * @param {object} o
 * @param {(key: string) => any} o.cfg     config getter
 * @param {object[]} o.chords              the chosen chord records, in order
 * @param {number} o.sessionNumber         1, 2, 3 ... (rotates which course carries a fault)
 * @returns {object[]} takes in recording order
 */
export function buildScript({ cfg, chords, sessionNumber = 1 }) {
  const takes = [];
  const interval = cfg('script.strumCueIntervalSec');

  // ---- Setup: room silence, then the open courses --------------------------
  takes.push({
    id: 'cal-noise',
    kind: 'noise',
    block: 'setup',
    blockTitle: 'Before you play',
    title: 'Room silence',
    lines: ['Sit as you will when you practise, mandolin in your lap, and stay quiet.', 'This measures how much sound the room makes by itself.'],
    cues: [],
    durationSec: cfg('script.noiseFloorSec'),
  });

  const picks = cfg('script.openCoursePicks');
  const openLabels = [];
  for (const name of COURSE_NAMES) for (let p = 0; p < picks; p++) openLabels.push(`${name} course`);
  const open = strumCues(cfg, openLabels.length, { labels: openLabels });
  takes.push({
    id: 'cal-open',
    kind: 'open-courses',
    block: 'setup',
    blockTitle: 'Before you play',
    title: 'Open courses, one at a time',
    lines: [
      'Tune first with your own tuner.',
      `Pick each open course by itself on each flash: G ${picks} times, then D, then A, then E. Let each one ring.`,
      'This records how the mandolin is actually tuned today.',
    ],
    cues: open.cues,
    durationSec: open.durationSec,
    courseOrder: COURSE_NAMES.flatMap((name) => Array(picks).fill(name)),
  });

  // ---- One block per chord ---------------------------------------------------
  chords.forEach((chord, chordIndex) => {
    const rotate = chordIndex + (sessionNumber - 1);
    const shape = fretsText(chord.frets);
    const played = chord.frets.map((fret, course) => ({ fret, course })).filter((x) => x.fret !== null);
    const fretted = played.filter((x) => x.fret > 0);

    takes.push(
      strumTake(cfg, chord, {
        id: `strums-${chord.id}-clean`,
        condition: 'clean',
        count: cfg('script.cleanStrums'),
        cueOptions: { dynamics: cfg('script.cleanDynamicsCycle'), strokes: cfg('script.cleanStrokeCycle') },
        title: `${chord.name}: clean strums`,
        lines: [
          `Hold ${chord.name} (${shape}) and strum all four courses once on each flash.`,
          'Follow the prompt for soft, medium or loud, and for a down or up stroke.',
          'Play it as cleanly as you can. If a strum goes wrong, carry on to the end, then record this take again: the analysis takes its bearings for this chord from it.',
        ],
      })
    );

    for (const { course } of played) {
      const name = COURSE_NAMES[course];
      takes.push(
        strumTake(cfg, chord, {
          id: `strums-${chord.id}-damped-${name}`,
          condition: 'damped-course',
          conditionDetail: { course: name, courseIndex: course },
          marks: { damped: [course] },
          count: cfg('script.dampedCourseStrums'),
          title: `${chord.name}: ${name} course damped`,
          lines: [
            `Hold ${chord.name} (${shape}), but rest a finger lightly across both strings of the ${name} course so it gives a dull thud.`,
            'Strum all four courses once on each flash, medium loudness, down strokes.',
          ],
        })
      );
    }

    const variants = fretOffVariants(chord.frets, cfg('script.fretOffVariants'), rotate);
    const perVariant = Math.max(1, Math.round(cfg('script.fretOffStrums') / Math.max(1, variants.length)));
    variants.forEach((variant, k) => {
      takes.push(
        strumTake(cfg, chord, {
          id: `strums-${chord.id}-fretoff-${k + 1}`,
          condition: 'fret-off',
          conditionDetail: { course: variant.course, courseIndex: variant.courseIndex, fromFret: variant.fromFret, toFret: variant.toFret },
          playedFrets: variant.playedFrets,
          marks: { moved: [{ course: variant.courseIndex, from: variant.fromFret }] },
          count: perVariant,
          title: `${chord.name}: one finger a fret off (${fretsText(variant.playedFrets)})`,
          lines: [
            `Play this WRONG shape on purpose: the finger on the ${variant.course} course sits at fret ${variant.toFret} instead of fret ${variant.fromFret}.`,
            'Press it cleanly so the wrong note rings. Strum once on each flash, medium loudness, down strokes.',
          ],
        })
      );
    });

    if (fretted.length) {
      const buzzCourse = fretted[rotate % fretted.length].course;
      const name = COURSE_NAMES[buzzCourse];
      takes.push(
        strumTake(cfg, chord, {
          id: `strums-${chord.id}-buzz`,
          condition: 'buzz',
          conditionDetail: { course: name, courseIndex: buzzCourse },
          marks: { buzz: [buzzCourse] },
          count: cfg('script.buzzStrums'),
          title: `${chord.name}: a buzz on the ${name} course`,
          lines: [
            `Hold ${chord.name} (${shape}), but make the ${name} course buzz: press too lightly, or too far back from the fret.`,
            'Strum once on each flash, medium loudness, down strokes.',
          ],
        })
      );
    }

    const pairCourse = played[(rotate + 1) % played.length].course;
    const pairName = COURSE_NAMES[pairCourse];
    takes.push(
      strumTake(cfg, chord, {
        id: `strums-${chord.id}-pairstring`,
        condition: 'pair-string-damped',
        conditionDetail: { course: pairName, courseIndex: pairCourse },
        marks: { halfDamped: [pairCourse] },
        count: cfg('script.pairStringDampedStrums'),
        title: `${chord.name}: one string of the ${pairName} pair damped`,
        lines: [
          `Hold ${chord.name} (${shape}), and touch just ONE of the two strings of the ${pairName} course so only its partner rings.`,
          'Strum once on each flash, medium loudness, down strokes.',
          'The app is not expected to hear this one. It is recorded to confirm that.',
        ],
      })
    );
  });

  // ---- Chord changes against the click, grouped by how the click is heard ----
  const byId = new Map(chords.map((c) => [c.id, c]));
  const byName = new Map();
  for (const chord of chords) if (!byName.has(chord.name)) byName.set(chord.name, chord);
  const find = (key) => byId.get(key) || byName.get(key) || null;
  const pairs = cfg('script.changePairs')
    .map(([a, b]) => [find(a), find(b)])
    .filter(([a, b]) => a && b);
  const beatsPerChord = cfg('script.changeBeatsPerChord');
  const segments = cfg('script.changeChordSegments');
  const countIn = cfg('script.countInBeats');
  const routeText = {
    headphones: { title: 'Changes with the click in wired headphones', how: 'Plug in the wired headphones. The click plays in them.' },
    visual: { title: 'Changes with a silent, flashing click', how: 'No sound: follow the flash on screen. Headphones in or out makes no difference.' },
    speaker: { title: 'Changes with the click from the iPad speaker', how: 'Unplug the headphones. The click plays quietly from the iPad.' },
  };

  const changeTake = (a, b, bpm, route, sound, comparison) => {
    const plan = [];
    for (let n = 0; n < countIn; n++) plan.push({ beat: n, role: 'count-in', segment: -1, chordId: null, chordName: null });
    for (let s = 0; s < segments; s++) {
      const chord = s % 2 === 0 ? a : b;
      for (let k = 0; k < beatsPerChord; k++) {
        plan.push({ beat: countIn + s * beatsPerChord + k, role: 'strum', segment: s, chordId: chord.id, chordName: chord.name });
      }
    }
    return {
      id: `changes-${a.id}-${b.id}-${bpm}-${route}${comparison ? `-${sound}` : ''}`,
      kind: 'changes',
      block: `changes:${route}`,
      blockTitle: routeText[route].title,
      title: `${a.name} to ${b.name} at ${bpm} bpm${comparison ? ' (high tick, for comparison)' : ''}`,
      lines: [
        comparison ? 'Headphones still unplugged. This repeat uses the short high tick instead of the woodblock, so the two can be compared.' : routeText[route].how,
        `After a count of ${countIn}, strum once on every beat: ${beatsPerChord} beats of ${a.name}, then ${beatsPerChord} of ${b.name}, back and forth, ${segments} chords in all.`,
        'Keep going even if a change is late; mark the take as bad only if you lost your place.',
      ],
      pair: [
        { id: a.id, name: a.name, frets: a.frets },
        { id: b.id, name: b.name, frets: b.frets },
      ],
      tempoBpm: bpm,
      clickRoute: route,
      clickSound: route === 'visual' ? null : sound,
      plan,
      cues: [],
      durationSec: (plan.length * 60) / bpm + cfg('script.tailSec') + 0.5,
    };
  };

  for (const route of cfg('script.clickRoutes')) {
    for (const [a, b] of pairs) {
      for (const bpm of cfg('script.changeTemposBpm')) takes.push(changeTake(a, b, bpm, route, cfg('metronome.sound'), false));
    }
    if (route === 'speaker' && cfg('script.speakerComparisonSound') !== cfg('metronome.sound')) {
      const again = cfg('script.speakerComparisonPairs').map(([x, y]) => [find(x), find(y)]).filter(([x, y]) => x && y);
      for (const [a, b] of again) {
        for (const bpm of cfg('script.changeTemposBpm')) takes.push(changeTake(a, b, bpm, route, cfg('script.speakerComparisonSound'), true));
      }
    }
  }

  // ---- Speaker click with no playing, once with each click sound -----------------
  const soundText = {
    woodblock: { name: 'Woodblock click', why: 'This counts how often the woodblock by itself is mistaken for a strum.' },
    tick: { name: 'High tick', why: 'This is the short high click that sits above the strings\' range, recorded for comparison with the woodblock.' },
  };
  for (const sound of cfg('script.clickOnlySounds')) {
    for (const bpm of cfg('script.changeTemposBpm')) {
      const clicks = cfg('script.clickOnlyClicksPerTempo');
      takes.push({
        id: `clickonly-${bpm}-${sound}`,
        kind: 'click-only',
        block: 'click-only',
        blockTitle: 'Speaker click by itself',
        title: `${soundText[sound].name} only at ${bpm} bpm, no playing`,
        lines: [
          'Headphones unplugged. Hold the mandolin as usual but do not play, and stay quiet.',
          `The iPad plays ${clicks} clicks. ${soundText[sound].why}`,
        ],
        tempoBpm: bpm,
        clickRoute: 'speaker',
        clickSound: sound,
        plan: Array.from({ length: clicks }, (_, n) => ({ beat: n, role: 'click-only', segment: -1, chordId: null, chordName: null })),
        cues: [],
        durationSec: (clicks * 60) / bpm + cfg('script.tailSec') + 0.5,
      });
    }
  }

  takes.forEach((take, index) => {
    take.order = index;
    if (take.cues.length) take.cueIntervalSec = interval;
  });
  return takes;
}

/**
 * Which chord-change pairs the chosen chords can and cannot supply. A pair is
 * dropped from the script when either of its chords was not chosen, so setup
 * checks this first and refuses a choice that would lose change takes.
 * @returns {{kept: string[][], dropped: string[][], needed: string[]}} pairs by chord id or name
 */
export function changeCoverage(cfg, chords) {
  const has = (key) => chords.some((chord) => chord.id === key || chord.name === key);
  const all = [...cfg('script.changePairs'), ...cfg('script.speakerComparisonPairs')];
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const pair of all) {
    const key = pair.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    (has(pair[0]) && has(pair[1]) ? kept : dropped).push(pair);
  }
  return { kept, dropped, needed: [...new Set(all.flat())] };
}

/** Totals for the "how long will this take" line. */
export function scriptSummary(takes) {
  let seconds = 0;
  let strums = 0;
  for (const take of takes) {
    seconds += take.durationSec;
    if (take.kind === 'strums') strums += take.cues.length;
  }
  return { takes: takes.length, recordingSeconds: seconds, strums };
}
