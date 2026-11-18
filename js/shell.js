// Small helpers shared by every page: building DOM, describing the device,
// the service worker, the screen wake lock, and saving a file.
// Nothing here talks to the network beyond the app's own files.

/** Build a DOM element: h('button', {class: 'primary', onclick: fn}, 'Record') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Append children the way h() does: arrays are flattened, null and false are skipped. */
export function add(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** True when the page runs from the Home Screen icon instead of a Safari tab. */
export function isStandalone() {
  return (
    (globalThis.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
  );
}

/** How the page is running, in words. Says "Safari" only when the browser really is Safari. */
export function tabLabel() {
  const ua = navigator.userAgent || '';
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\//.test(ua);
  return safari ? 'Safari tab' : 'Browser tab';
}

export function modeLabel() {
  return isStandalone() ? 'Home Screen app' : tabLabel();
}

/**
 * The build code of the copy stored for offline use, read from the service
 * worker's cache name. Null when nothing is stored yet (or caches are unavailable).
 */
export async function offlineBuild() {
  try {
    if (!globalThis.caches) return null;
    const names = (await caches.keys()).filter((name) => name.startsWith('practice-shell-'));
    if (!names.length) return null;
    return names[names.length - 1].slice('practice-shell-'.length);
  } catch (error) {
    return null;
  }
}

/** What can be learned about the device without asking for anything. */
export function envInfo() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: isStandalone(),
    mode: isStandalone() ? 'home-screen' : 'browser-tab',
    online: navigator.onLine,
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio || 1 },
    viewport: { width: innerWidth, height: innerHeight },
    secureContext: globalThis.isSecureContext === true,
  };
}

/**
 * Note that a page of the site was opened, and keep the longest stretch between
 * visits. The device check uses this for "data survival after two weeks unused":
 * unused has to mean every page, not only the device-check page.
 */
export function noteVisit() {
  const LAST = 'practice-survival-last-visit';
  const LONGEST = 'practice-survival-longest-gap';
  const out = { previousVisitAt: null, gapDays: null, longest: null };
  try {
    const now = new Date();
    const last = localStorage.getItem(LAST);
    let longest = JSON.parse(localStorage.getItem(LONGEST) || 'null');
    if (last) {
      out.previousVisitAt = last;
      out.gapDays = (now.getTime() - new Date(last).getTime()) / 86400000;
      if (!longest || out.gapDays > longest.days) {
        longest = { days: out.gapDays, from: last, to: now.toISOString() };
        localStorage.setItem(LONGEST, JSON.stringify(longest));
      }
    }
    out.longest = longest;
    localStorage.setItem(LAST, now.toISOString());
  } catch (error) {
    out.error = String(error);
  }
  return out;
}

/** Register the service worker so the pages open with no connection. */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return { supported: false };
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    return { supported: true, scope: registration.scope, active: !!registration.active };
  } catch (error) {
    return { supported: true, error: String(error) };
  }
}

/** Keeps the screen on, and asks again whenever the app comes back to the front. */
export class WakeLock {
  constructor(onChange) {
    this.supported = 'wakeLock' in navigator;
    this.sentinel = null;
    this.wanted = false;
    this.onChange = onChange || (() => {});
    this.history = [];
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this.request();
    });
  }

  note(type, detail) {
    this.history.push({ at: new Date().toISOString(), type, detail: detail || null });
    this.onChange(this.state());
  }

  state() {
    return { supported: this.supported, held: !!this.sentinel && !this.sentinel.released, wanted: this.wanted };
  }

  async request() {
    this.wanted = true;
    if (!this.supported) {
      this.note('unsupported');
      return false;
    }
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => this.note('released'));
      this.note('acquired');
      return true;
    } catch (error) {
      this.note('failed', String(error));
      return false;
    }
  }

  async release() {
    this.wanted = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch (error) {
        // already released
      }
    }
    this.sentinel = null;
  }
}

/** Offer a file through the share sheet ("Save to Files"). */
export async function shareFile(blob, filename, mimeType) {
  if (!navigator.share || !navigator.canShare) return { ok: false, reason: 'The share sheet is not available here.' };
  const file = new File([blob], filename, { type: mimeType });
  if (!navigator.canShare({ files: [file] })) return { ok: false, reason: 'This browser will not share this kind of file.' };
  try {
    await navigator.share({ files: [file] });
    return { ok: true };
  } catch (error) {
    if (error && error.name === 'AbortError') return { ok: false, reason: 'cancelled', cancelled: true };
    return { ok: false, reason: String(error) };
  }
}

/** Save a file through the browser's ordinary download. */
export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.append(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 60000);
}

export function formatDb(linear) {
  if (!(linear > 0)) return '−∞ dB';
  return `${(20 * Math.log10(linear)).toFixed(1)} dB`;
}

export function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes} min ${String(rest).padStart(2, '0')} s` : `${rest} s`;
}

export function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
