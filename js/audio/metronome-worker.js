// A plain timer in a Web Worker (spec section 8, Metronome). It only wakes the
// scheduler; the clicks themselves are placed on the audio clock by the page.
// A worker timer keeps ticking when the page's own timers are slowed down.

let timerId = null;

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'start') {
    if (timerId !== null) clearInterval(timerId);
    timerId = setInterval(() => self.postMessage('tick'), message.intervalMs || 25);
  } else if (message.type === 'stop') {
    if (timerId !== null) clearInterval(timerId);
    timerId = null;
  }
};
