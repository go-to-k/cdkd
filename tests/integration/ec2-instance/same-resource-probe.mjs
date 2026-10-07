#!/usr/bin/env node
/**
 * Real-AWS probe for `EC2Provider.isSameResource` on `AWS::EC2::Instance`
 * (go-to-k/cdkd#4606).
 *
 * A successful deploy deletes a journaled failed-CREATE instance only when this
 * read answers 'different'. The fix-forward that journals such an instance
 * cannot be driven on real AWS (the create marks one only when its wiring AND
 * its cleanup terminate both fail), so this drives cdkd's OWN provider (from
 * `dist/`) against live instances instead. The unit suite mocks EC2, so it
 * cannot prove what only AWS settles: that a `terminated` instance still
 * describes (for about an hour) with that state, and which error a
 * well-formed id that never existed gets.
 *
 * Every case prints a receipt, so a probe that silently did not run cannot be
 * read as a pass.
 *
 * usage: node same-resource-probe.mjs <region> <live-id> <other-live-id> <terminated-id> <never-existed-id>
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [region, liveId, otherLiveId, terminatedId, neverId] = process.argv.slice(2);
if (!region || !liveId || !otherLiveId || !terminatedId || !neverId) {
  console.error(
    'usage: node same-resource-probe.mjs <region> <live-id> <other-live-id> <terminated-id> <never-existed-id>'
  );
  process.exit(2);
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

const TYPE = 'AWS::EC2::Instance';
const CTX = { expectedRegion: region };
let passed = 0;
let failed = 0;

async function expectVerdict(label, journaled, recorded, expected, ctx = CTX) {
  let got;
  try {
    got = await provider.isSameResource(journaled, { physicalId: recorded }, TYPE, ctx);
  } catch (err) {
    got = `threw ${err?.name ?? typeof err}: ${err?.message ?? String(err)}`;
  }
  if (got === expected) {
    passed += 1;
    console.log(`[probe] PASS ${passed}: ${label} -> ${got}`);
  } else {
    failed += 1;
    console.error(`[probe] FAIL: ${label} -> ${got} (expected ${expected})`);
  }
}

// (a) The deployed instance against its own record: the same resource.
await expectVerdict('own id vs its record', liveId, liveId, 'same');
// (b) Another live instance of the stack: both read back running, so the
// journaled one is a different resource.
await expectVerdict('other live instance vs the record', otherLiveId, liveId, 'different');
// (c) A terminated instance EC2 still describes: gone as a journaled id
// (different, the settle deletes it), and never proof as the record's.
await expectVerdict('terminated journaled instance vs a live record', terminatedId, liveId, 'different');
await expectVerdict('live journaled instance vs a terminated record', liveId, terminatedId, 'unknown');
// (d) An 8-hex id that never existed (verify.sh draws one EC2 answers
// InvalidInstanceID.NotFound; a synthetic 17-hex id answers Malformed, which
// the provider throws on, so the caller reads it unknown): not found, which is
// gone as a journaled id and never proof as the record's.
await expectVerdict('never-existed journaled id vs a live record', neverId, liveId, 'different');
await expectVerdict('live journaled instance vs a never-existed record', liveId, neverId, 'unknown');
// (e) A client in another region than the stack's proves nothing.
await expectVerdict('another region', otherLiveId, liveId, 'unknown', {
  expectedRegion: region === 'us-west-2' ? 'us-east-1' : 'us-west-2',
});

// (f) The settle's delete of a journaled instance that is already terminated
// completes rather than failing the deploy.
try {
  await provider.delete('ProbeOrphan', terminatedId, TYPE, {}, {
    expectedRegion: region,
    failedCreateOrphan: true,
  });
  passed += 1;
  console.log(`[probe] PASS ${passed}: delete of the terminated journaled instance completed`);
} catch (err) {
  failed += 1;
  console.error(
    `[probe] FAIL: delete of the terminated journaled instance threw ${err?.name}: ${err?.message}`
  );
}

// (g) The settle's delete of a journaled instance EC2 no longer lists
// (`InvalidInstanceID.NotFound`): completes, and names it once at info.
const infoLines = [];
const logger = provider.logger;
const originalInfo = logger?.info;
if (typeof originalInfo === 'function') {
  logger.info = (...args) => {
    infoLines.push(args.map(String).join(' '));
    return originalInfo.apply(logger, args);
  };
}
try {
  await provider.delete('ProbeOrphan', neverId, TYPE, {}, {
    expectedRegion: region,
    failedCreateOrphan: true,
  });
  if (typeof originalInfo === 'function') logger.info = originalInfo;
  const named = infoLines.filter((l) => l.includes(neverId) && l.includes('already gone'));
  if (named.length === 1) {
    passed += 1;
    console.log(`[probe] PASS ${passed}: delete of a never-existed journaled instance completed and was named once at info`);
  } else {
    failed += 1;
    console.error(
      `[probe] FAIL: delete of a never-existed journaled instance printed ${named.length} 'already gone' info line(s) naming it (expected 1): ${JSON.stringify(infoLines)}`
    );
  }
} catch (err) {
  if (typeof originalInfo === 'function') logger.info = originalInfo;
  failed += 1;
  console.error(
    `[probe] FAIL: delete of a never-existed journaled instance threw ${err?.name}: ${err?.message}`
  );
}

if (failed > 0) {
  console.error(`[probe] ${failed} case(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`[probe] ALL ${passed} PASSED`);
