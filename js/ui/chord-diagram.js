// A small chord diagram drawn as SVG text. Pure function, no libraries.
// Frets read across the courses G, D, A, E; null means the course is not played.
//
// Extra marks the recording script needs, which a stock chord-chart library
// does not offer (see docs/DECISIONS.md):
//   moved:      a finger deliberately placed a fret off (shown in the accent colour,
//               with a dashed ring where it belongs)
//   damped:     a whole course to be damped
//   halfDamped: one string of a pair to be damped
//   buzz:       a course to be made to buzz

export const COURSE_NAMES = ['G', 'D', 'A', 'E'];

export function fretsText(frets) {
  return frets.map((f) => (f === null ? 'x' : String(f))).join('-');
}

/**
 * @param {(number|null)[]} frets
 * @param {{moved?: {course:number, from:number}[], damped?: number[], halfDamped?: number[], buzz?: number[], label?: string}} [marks]
 * @returns {string} SVG markup
 */
export function chordDiagram(frets, marks = {}) {
  const moved = marks.moved || [];
  const damped = marks.damped || [];
  const halfDamped = marks.halfDamped || [];
  const buzz = marks.buzz || [];

  const fretted = frets.filter((f) => f !== null && f > 0);
  const ghostFrets = moved.map((m) => m.from).filter((f) => f > 0);
  const highest = Math.max(0, ...fretted, ...ghostFrets);
  const lowest = Math.min(...(fretted.length ? [...fretted, ...ghostFrets] : [1]));
  const rows = 5;
  const firstFret = highest <= rows ? 1 : lowest;

  const left = 30;
  const top = 34;
  const colGap = 30;
  const rowGap = 26;
  const width = left * 2 + colGap * 3;
  const height = top + rowGap * rows + 40;
  const x = (course) => left + course * colGap;
  const y = (fret) => top + (fret - firstFret + 0.5) * rowGap;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="chord-diagram" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${marks.label || 'Chord shape ' + fretsText(frets)}">`
  );

  // Course names
  COURSE_NAMES.forEach((name, i) => {
    out.push(`<text class="cd-name" x="${x(i)}" y="12" text-anchor="middle">${name}</text>`);
  });

  // Open / not-played marks above the nut
  frets.forEach((f, i) => {
    if (f === 0) out.push(`<circle class="cd-open" cx="${x(i)}" cy="${top - 8}" r="4.5"/>`);
    if (f === null) out.push(`<text class="cd-mute" x="${x(i)}" y="${top - 3}" text-anchor="middle">×</text>`);
  });

  // Nut or position label
  if (firstFret === 1) {
    out.push(`<line class="cd-nut" x1="${x(0) - 5}" y1="${top}" x2="${x(3) + 5}" y2="${top}"/>`);
  } else {
    out.push(`<text class="cd-pos" x="${x(0) - 12}" y="${y(firstFret) + 4}" text-anchor="end">${firstFret}</text>`);
  }

  // Fret lines
  for (let r = 0; r <= rows; r++) {
    out.push(`<line class="cd-fret" x1="${x(0) - 4}" y1="${top + r * rowGap}" x2="${x(3) + 4}" y2="${top + r * rowGap}"/>`);
  }

  // Courses: two strings each
  for (let i = 0; i < 4; i++) {
    const isDamped = damped.includes(i);
    const isHalf = halfDamped.includes(i);
    const isBuzz = buzz.includes(i);
    const y1 = top;
    const y2 = top + rows * rowGap;
    const a = `<line class="cd-string${isDamped ? ' cd-damped' : ''}${isBuzz ? ' cd-buzz' : ''}" x1="${x(i) - 2}" y1="${y1}" x2="${x(i) - 2}" y2="${y2}"/>`;
    const b = `<line class="cd-string${isDamped || isHalf ? ' cd-damped' : ''}${isBuzz ? ' cd-buzz' : ''}" x1="${x(i) + 2}" y1="${y1}" x2="${x(i) + 2}" y2="${y2}"/>`;
    out.push(a, b);
  }

  // Where a moved finger belongs (dashed ring)
  for (const m of moved) {
    if (m.from > 0 && m.from >= firstFret && m.from < firstFret + rows) {
      out.push(`<circle class="cd-ghost" cx="${x(m.course)}" cy="${y(m.from)}" r="9"/>`);
    }
  }

  // Fingers
  frets.forEach((f, i) => {
    if (f === null || f === 0) return;
    const isMoved = moved.some((m) => m.course === i);
    out.push(`<circle class="cd-dot${isMoved ? ' cd-moved' : ''}" cx="${x(i)}" cy="${y(f)}" r="9"/>`);
    out.push(`<text class="cd-dot-text" x="${x(i)}" y="${y(f) + 4}" text-anchor="middle">${f}</text>`);
  });

  // Fret numbers and fault labels under the diagram
  const baseY = top + rows * rowGap + 16;
  frets.forEach((f, i) => {
    out.push(`<text class="cd-num" x="${x(i)}" y="${baseY}" text-anchor="middle">${f === null ? 'x' : f}</text>`);
    let fault = '';
    if (damped.includes(i)) fault = 'damp';
    else if (halfDamped.includes(i)) fault = 'half';
    else if (buzz.includes(i)) fault = 'buzz';
    else if (moved.some((m) => m.course === i)) fault = 'off';
    if (fault) out.push(`<text class="cd-fault" x="${x(i)}" y="${baseY + 15}" text-anchor="middle">${fault}</text>`);
  });

  out.push('</svg>');
  return out.join('');
}
