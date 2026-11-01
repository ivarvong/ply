// One pushTree under the heap the parent asks for. Prints one JSON line.
import { validateTreeSpec } from '../src/tree.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT, LIMIT_PUSH_BYTES } from '../src/limits.js';

const kind = process.argv[2];
const MIB = 1024 * 1024;
const author = { name: 'sweep', email: 'sweep@example.com' };
const specOf = files => ({ files, author, message: 'm\n', time: 1_700_000_000 });
const rss = () => Math.round(process.resourceUsage().maxRSS / 1024);

const report = (body) => {
  process.stdout.write(`${JSON.stringify({ ...body, rss: rss() })}\n`);
};

try {
  if (kind === 'one') {
    const data = new Uint8Array(LIMIT_OBJECT);
    data.fill(7);
    const plan = validateTreeSpec(specOf({ 'big.bin': data }), DEFAULT_LIMITS);
    const blob = [...plan.built.blobs.keys()];
    report({ status: 'ok', root: plan.built.root, blob: blob[0], files: plan.files });
  } else if (kind === 'three') {
    const n = 48 * MIB;
    const files = {
      'a.bin': new Uint8Array(n),
      'b.bin': new Uint8Array(n),
      'c.bin': new Uint8Array(n),
    };
    files['a.bin'].fill(1);
    files['b.bin'].fill(2);
    files['c.bin'].fill(3);
    validateTreeSpec(specOf(files), DEFAULT_LIMITS);
    report({ status: 'ok', unexpected: true });
  } else {
    report({ status: 'err', message: `unknown kind ${kind}` });
  }
} catch (e) {
  report({ status: 'err', code: e.code, message: e.message, got: e.got, max: e.max, what: e.what, cap: LIMIT_PUSH_BYTES });
}
