// Loads the one config file (app/config.json). Every threshold and rule number
// the pages use comes through here, so nothing is hard-coded elsewhere.

let cached = null;

/** Wrap the parsed JSON in a small getter: cfg('onset.hopMs') -> 10. */
export function makeConfig(json) {
  const values = json.values;
  const get = (key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    return values[key].value;
  };
  get.entry = (key) => values[key];
  get.keys = () => Object.keys(values);
  get.version = json.configVersion;
  /** A plain {key: value} copy, for storing beside a recording. */
  get.snapshot = (prefixes = null) => {
    const out = {};
    for (const key of Object.keys(values)) {
      if (!prefixes || prefixes.some((p) => key.startsWith(p))) out[key] = values[key].value;
    }
    return out;
  };
  return get;
}

export async function loadConfig() {
  if (cached) return cached;
  const response = await fetch(new URL('../config.json', import.meta.url));
  if (!response.ok) throw new Error(`Could not load config.json (${response.status})`);
  cached = makeConfig(await response.json());
  return cached;
}
