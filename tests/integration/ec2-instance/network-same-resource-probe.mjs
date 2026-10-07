#!/usr/bin/env node
/**
 * Real-AWS probe for `EC2Provider.isSameResource` and the settle's delete on
 * `AWS::EC2::VPC`, `AWS::EC2::Subnet` and `AWS::EC2::SecurityGroup`
 * (go-to-k/cdkd#4606).
 *
 * A successful deploy deletes a journaled failed-CREATE VPC, subnet or
 * security group only when this read answers 'different'. The fix-forward
 * that journals one cannot be driven on real AWS (the create marks one only
 * when its wiring AND its cleanup delete both fail, and nothing makes a
 * delete of a just-created VPC, subnet or group fail on demand), so this
 * drives cdkd's OWN provider (from `dist/`) against live resources instead:
 * this stack's, a throwaway set `verify.sh` creates out of band (standing in
 * for the earlier attempt's orphans), and well-formed ids that never existed.
 * Phase `live` asks the reads and then runs the settle's delete
 * (`failedCreateOrphan`) on each throwaway; `verify.sh` then waits until EC2
 * answers `*.NotFound` for all three, and phase `gone` asks the reads and the
 * delete again. The unit suite mocks EC2, so
 * it cannot prove which errors AWS answers for a gone or never-existed id.
 *
 * Every case prints a receipt, and the run ends `[probe] ALL <n> PASSED` only
 * when every case the phase declares ran and passed.
 *
 * usage: node network-same-resource-probe.mjs <region> <live|gone> <ids.json>
 *   ids.json: { stack: {vpc, subnet, sg}, throwaway: {vpc, subnet, sg},
 *               never: {vpc, subnet, sg}, otherVpc, otherSg }
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [region, phase, idsFile] = process.argv.slice(2);
if (!region || (phase !== 'live' && phase !== 'gone') || !idsFile) {
  console.error('usage: node network-same-resource-probe.mjs <region> <live|gone> <ids.json>');
  process.exit(2);
}
const ids = JSON.parse(readFileSync(idsFile, 'utf8'));
const KEYS = ['vpc', 'subnet', 'sg'];
for (const group of ['stack', 'throwaway', 'never']) {
  for (const key of KEYS) {
    if (typeof ids[group]?.[key] !== 'string' || ids[group][key] === '') {
      console.error(`[probe] FAIL: ids.${group}.${key} is missing`);
      process.exit(2);
    }
  }
}
for (const key of ['otherVpc', 'otherSg']) {
  if (typeof ids[key] !== 'string' || ids[key] === '') {
    console.error(`[probe] FAIL: ids.${key} is missing`);
    process.exit(2);
  }
}

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
// The global client bag must be created with the stack's region BEFORE the
// provider's constructor reads it.
const { getAwsClients } = await import(pathToFileURL(join(dist, 'index.js')).href);
getAwsClients({ region });
// `EC2Provider` ships only in the provider-classes chunk, whose name carries a
// content hash: exactly one match, or the build is not the one expected.
const chunks = readdirSync(dist).filter((f) => /^provider-classes-[^.]+\.js$/.test(f));
if (chunks.length !== 1) {
  console.error(`[probe] FAIL: expected one dist/provider-classes-*.js chunk, found ${chunks.length}`);
  process.exit(1);
}
const { EC2Provider } = await import(pathToFileURL(join(dist, chunks[0])).href);
if (typeof EC2Provider !== 'function') {
  console.error(`[probe] FAIL: ${chunks[0]} does not export EC2Provider`);
  process.exit(1);
}
const provider = new EC2Provider();
if (typeof provider.isSameResource !== 'function') {
  console.error('[probe] FAIL: EC2Provider has no isSameResource');
  process.exit(1);
}

const TYPE = { vpc: 'AWS::EC2::VPC', subnet: 'AWS::EC2::Subnet', sg: 'AWS::EC2::SecurityGroup' };
const CTX = { expectedRegion: region };
const OTHER_REGION = region === 'us-west-2' ? 'us-east-1' : 'us-west-2';
let passed = 0;
let failed = 0;
let executed = 0;

function record(ok, label, detail) {
  executed += 1;
  if (ok) {
    passed += 1;
    console.log(`[probe] PASS ${passed}: ${label}${detail ? ` -> ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`[probe] FAIL: ${label} -> ${detail}`);
  }
}

async function expectVerdict(label, key, journaled, recorded, expected, ctx = CTX) {
  let got;
  try {
    got = await provider.isSameResource(journaled, { physicalId: recorded }, TYPE[key], ctx);
  } catch (err) {
    got = `threw ${err?.name ?? typeof err}: ${err?.message ?? String(err)}`;
  }
  record(got === expected, `${TYPE[key]}: ${label}`, got === expected ? got : `${got} (expected ${expected})`);
}

// The settle's delete, with the provider's info lines captured: `goneLines`
// is how many `already gone` lines must name the id (1 for an id AWS no
// longer lists, 0 for a live one the delete removes).
async function expectDelete(label, key, physicalId, goneLines) {
  const infoLines = [];
  const logger = provider.logger;
  const originalInfo = logger?.info;
  if (typeof originalInfo !== 'function') {
    record(false, `${TYPE[key]}: ${label}`, 'the provider has no logger.info to observe');
    return;
  }
  logger.info = (...args) => {
    infoLines.push(args.map(String).join(' '));
    return originalInfo.apply(logger, args);
  };
  try {
    await provider.delete('ProbeOrphan', physicalId, TYPE[key], {}, {
      expectedRegion: region,
      failedCreateOrphan: true,
    });
    const named = infoLines.filter((l) => l.includes(physicalId) && l.includes('already gone'));
    record(
      named.length === goneLines,
      `${TYPE[key]}: ${label}`,
      named.length === goneLines
        ? `completed, ${goneLines} 'already gone' line(s)`
        : `completed with ${named.length} 'already gone' line(s) naming it (expected ${goneLines}): ${JSON.stringify(infoLines)}`
    );
  } catch (err) {
    record(false, `${TYPE[key]}: ${label}`, `threw ${err?.name}: ${err?.message}`);
  } finally {
    logger.info = originalInfo;
  }
}

let declared;
if (phase === 'live') {
  // Every resource is live, except the never-existed ids.
  for (const key of KEYS) {
    const own = ids.stack[key];
    const thr = ids.throwaway[key];
    const never = ids.never[key];
    // (a) The stack's resource against its own record: the same resource.
    await expectVerdict('own id vs its record', key, own, own, 'same');
    // (b) The live throwaway (the earlier attempt's orphan) against the
    // stack's record, and the other way round: both read back, so different.
    await expectVerdict('live throwaway vs the record', key, thr, own, 'different');
    await expectVerdict('stack resource vs a live throwaway record', key, own, thr, 'different');
    // (c) A well-formed id that never existed (verify.sh drew one EC2 answers
    // `*.NotFound`, never `*.Malformed`): gone as a journaled id, and never
    // proof as the record's.
    await expectVerdict('never-existed journaled id vs the record', key, never, own, 'different');
    await expectVerdict('stack resource vs a never-existed record', key, own, never, 'unknown');
    // (d) A client in another region than the stack's proves nothing.
    await expectVerdict('another region', key, thr, own, 'unknown', {
      expectedRegion: OTHER_REGION,
    });
  }
  // (e) A second live resource outside the throwaway set: the default VPC,
  // and the stack's default-VPC security group.
  await expectVerdict('the default VPC vs the record', 'vpc', ids.otherVpc, ids.stack.vpc, 'different');
  await expectVerdict('the other stack group vs the record', 'sg', ids.otherSg, ids.stack.sg, 'different');
  // (f) The settle's delete of each live throwaway, dependents first (the
  // group and the subnet sit in the throwaway VPC).
  for (const key of ['sg', 'subnet', 'vpc']) {
    await expectDelete('delete of the live throwaway', key, ids.throwaway[key], 0);
  }
  declared = 6 * KEYS.length + 2 + KEYS.length;
} else {
  // verify.sh saw EC2 answer `*.NotFound` for every throwaway.
  for (const key of KEYS) {
    const own = ids.stack[key];
    const thr = ids.throwaway[key];
    // (g) The deleted throwaway: gone as a journaled id, never proof as the
    // record's.
    await expectVerdict('deleted throwaway vs the record', key, thr, own, 'different');
    await expectVerdict('stack resource vs a deleted throwaway record', key, own, thr, 'unknown');
    // (h) A journaled orphan already gone settles quietly but names it once.
    await expectDelete('delete of the already-deleted throwaway', key, thr, 1);
  }
  declared = 3 * KEYS.length;
}

if (executed !== declared) {
  console.error(`[probe] FAIL: ${executed} case(s) ran, ${declared} declared`);
  process.exit(1);
}
if (failed > 0) {
  console.error(`[probe] ${failed} case(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`[probe] ALL ${passed} PASSED`);
