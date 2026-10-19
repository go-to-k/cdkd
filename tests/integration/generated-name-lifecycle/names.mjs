// The names cdkd GENERATES (issue #5064), recomputed independently of cdkd so
// verify.sh can assert them: a transcription of `generateResourceName`
// (src/provisioning/resource-name.ts) for a stack with a stack instance id.
//
//   node names.mjs expected <state.json> <stackName> <logicalId> <generation> <kind>
//       prints the name cdkd generates; the id is read from <state.json> and
//       NEVER printed.
//   node names.mjs held <kind> <physicalId>
//       prints the name a physical id carries (a queue URL's last segment, an
//       ARN's name segment).
//
// <kind> fixes the type's generation options, as each provider passes them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KINDS = {
  table: { maxLength: 255 },
  queue: { maxLength: 80 },
  topic: { maxLength: 256 },
  role: { maxLength: 64 },
  fn: { maxLength: 64 },
  rule: { maxLength: 64 },
  bucket: { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g },
  loggroup: { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g, prefix: '/cdkd/' },
  tg: { maxLength: 32 },
  alb: { maxLength: 32 },
};

function suffix(id, logicalId, generation) {
  const hash = createHash('sha256').update(id).update('\u0000').update(logicalId);
  if (generation !== 0) hash.update('\u0000').update(String(generation));
  return hash.digest('hex').substring(0, 12);
}

function expected(id, stackName, logicalId, generation, kind) {
  const o = KINDS[kind];
  if (o === undefined) throw new Error(`unknown kind ${kind}`);
  let s = `${stackName}-${logicalId}`;
  if (o.lowercase) s = s.toLowerCase();
  s = s.replace(o.allowedPattern ?? /[^a-zA-Z0-9-]/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const sfx = suffix(id, logicalId, generation);
  const base = s.substring(0, o.maxLength - sfx.length - 1).replace(/-+$/, '');
  return `${o.prefix ?? ''}${base === '' ? sfx : `${base}-${sfx}`}`;
}

function held(kind, physicalId) {
  switch (kind) {
    case 'queue':
      return physicalId.split('/').pop();
    case 'topic':
      return physicalId.split(':').pop();
    case 'rule':
      // The EventBridge rule provider records the rule ARN (`rule/<name>`).
      return physicalId.split('/').pop();
    case 'tg': {
      const m = /:targetgroup\/([^/]+)\//.exec(physicalId);
      return m ? m[1] : '';
    }
    case 'alb': {
      const m = /:loadbalancer\/(?:app|net|gwy)\/([^/]+)\//.exec(physicalId);
      return m ? m[1] : '';
    }
    default:
      return physicalId;
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'expected') {
  const [stateFile, stackName, logicalId, generation, kind] = args;
  const id = JSON.parse(readFileSync(stateFile, 'utf8')).stackInstanceId;
  if (typeof id !== 'string' || id === '') {
    process.stderr.write('names.mjs: the state file carries no stackInstanceId\n');
    process.exit(2);
  }
  process.stdout.write(expected(id, stackName, logicalId, Number(generation), kind));
} else if (mode === 'held') {
  process.stdout.write(held(args[0], args[1] ?? ''));
} else {
  process.stderr.write('usage: names.mjs expected|held ...\n');
  process.exit(2);
}
