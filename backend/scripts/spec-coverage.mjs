import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEBHOOK_ROUTES = { receivePaystackEvent: { method: 'post', path: '/v1/webhooks/paystack' } };

function operations(specText) {
  const ops = [];
  let path = null;
  let method = null;
  let inWebhooks = false;
  for (const line of specText.split(/\r?\n/)) {
    if (/^webhooks:/.test(line)) inWebhooks = true;
    else if (/^\S/.test(line)) inWebhooks = false;
    const p = /^  (\/\S+):\s*$/.exec(line);
    if (p && !inWebhooks) path = p[1];
    const m = /^    (get|post|put|patch|delete):\s*$/.exec(line);
    if (m) method = m[1];
    const o = /^\s+operationId:\s*(\w+)/.exec(line);
    if (o) {
      const route = inWebhooks ? WEBHOOK_ROUTES[o[1]] : { method, path };
      if (!route) throw new Error(`No route mapping for webhook ${o[1]}`);
      ops.push({ id: o[1], ...route });
    }
  }
  return ops;
}

function requests(dir) {
  const calls = [];
  const literals = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/\.(get|post|put|patch|delete)\(\s*([`'"])((?:\/v1|\/internal)[^`'"]*)\2/g)) {
      calls.push({ method: m[1], url: m[3] });
    }
    for (const m of src.matchAll(/([`'"])((?:\/v1|\/internal)\/[^`'"]*)\1/g)) literals.push(m[2]);
  }
  return { calls, literals };
}

function matcher(path) {
  const pattern = path.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/?]+');
  return new RegExp(`^${pattern}(\\?.*)?$`);
}

const normalise = (url) => url.replace(/\$\{[^}]*\}/g, 'X');

const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
const ops = operations(spec);
const { calls, literals } = requests(new URL('../test/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const missing = ops.filter((op) => {
  const re = matcher(op.path);
  if (calls.some((c) => c.method === op.method && re.test(normalise(c.url)))) return false;
  return !(op.method === 'get' && literals.some((l) => re.test(normalise(l))));
});

if (ops.length === 0) throw new Error('No operations found in openapi.yaml');
if (missing.length > 0) {
  console.error(`Spec coverage: ${missing.length} of ${ops.length} operations have no test request:`);
  for (const op of missing) console.error(`  ${op.id}  ${op.method.toUpperCase()} ${op.path}`);
  process.exit(1);
}
console.log(`Spec coverage: all ${ops.length} operations are exercised by test/.`);
