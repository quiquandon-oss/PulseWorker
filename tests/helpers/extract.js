// Extracts named function source directly from the real worker.js at test
// time — same rationale as CryptoPulse/tests/helpers/extract.js: a test can
// never pass against code that isn't what's actually deployed, because
// there's no separately-maintained copy for it to drift from.
//
// Simpler than the CryptoPulse frontend version: worker.js is a plain JS
// module, not HTML with inline <script> tags, so no script-block stripping
// is needed — just read the file directly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_JS_PATH = join(__dirname, '..', '..', 'worker.js');

let _cachedSrc = null;
function getSource() {
  if (_cachedSrc === null) _cachedSrc = readFileSync(WORKER_JS_PATH, 'utf8');
  return _cachedSrc;
}

// Extracts one or more named function declarations by exact name, in the
// order given. Handles both top-level and nested function declarations
// (some of this file's functions, like isValidTxsPayload, are declared
// inside the main fetch handler) — the extraction only cares about finding
// `function name(` and matching its balanced closing brace, not where in
// the file it lives.
export function extractFunctions(...names) {
  const src = getSource();
  const pieces = [];
  for (const name of names) {
    const startMatch = src.match(new RegExp(`function\\s+${name}\\s*\\(`));
    if (!startMatch) throw new Error(`Could not find "function ${name}(" in worker.js -- was it renamed, removed, or turned into an arrow function?`);
    const startIdx = startMatch.index;
    const braceStart = src.indexOf('{', startIdx);
    if (braceStart === -1) throw new Error(`Could not find opening brace for ${name}`);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    pieces.push(src.slice(startIdx, i));
  }
  return pieces.join('\n\n');
}

export function evalInScope(source, extraGlobals = {}) {
  const sandbox = { console, ...extraGlobals };
  const keys = Object.keys(sandbox);
  const names = [...source.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  const fn = new Function(...keys, `${source}\nreturn { ${names.join(',')} };`);
  return fn(...keys.map(k => sandbox[k]));
}
