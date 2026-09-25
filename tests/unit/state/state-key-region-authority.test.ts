/**
 * Issue [go-to-k/cdkd#3328](https://github.com/go-to-k/cdkd/issues/3328): the
 * S3 KEY a state record was read from is the authority on its region, not the
 * `region` field inside its body.
 *
 * Measured 2026-09-17 against the shipped binary: a well-formed, resource-less
 * record planted at `.../Cdkd3161RegionProbe2/us-east-1/state.json` whose body
 * carried `"region": "eu-west-1"` made
 * `cdkd state destroy ... --stack-region us-east-1` lock, save and
 * `deleteState` against `eu-west-1`, print `✓ State deleted`, and leave the
 * us-east-1 key standing. `parseStateBody` validates the root object and the
 * schema version and nothing inside, and the region-scoped read path had no
 * gate of its own — the legacy fallback was the only one that compared.
 *
 * Two layers, because a fix at one of them is not observable at the other:
 *
 * - `S3StateBackend.getState` NORMALIZES the loaded record's `region` to the
 *   key's, warns when a body disagreed, and reports the divergent value to the
 *   caller. Asserted on the RETURNED region LITERAL — a wrong region is as
 *   well-formed as a right one, so `toBeDefined` would pass under the defect.
 * - `runDestroyForStack` is driven over a record produced by that real read,
 *   so the end-to-end claim ("the destroy acts on the key's region") is proved
 *   rather than inferred from the normalization alone.
 *
 * The three regions in the destroy case are deliberately DISTINCT — key
 * `ap-northeast-1`, body `eu-west-1`, CLI base `us-west-2` — so the assertion
 * discriminates against both wrong answers at once: the body region (the
 * defect) and `ctx.baseRegion` (what `state.region ?? ctx.baseRegion` falls
 * back to). None of them is `us-east-1`, the repo's ambient default, which a
 * fixture pinning the expected value to it could not tell apart from a
 * fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { S3Client, NoSuchKey } from '@aws-sdk/client-s3';
import type { StateBackendConfig } from '../../../src/types/config.js';
import type { StackState } from '../../../src/types/state.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

// ONE logger object behind `getLogger()` AND `child()`: the backend logs
// through `getLogger().child('S3StateBackend')` while the runner logs through
// `getLogger()`, and both halves of this file read the same spies.
const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

// The client double below is standard-shaped, so `resolveExpectedBucketOwner`
// would otherwise issue a LIVE GetCallerIdentity.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn(async () => 'us-east-1') };
});

// The runner's cross-region switch is REACHED by the destroy case (its base
// region differs from the key's), so these stand in for the real clients and
// registry it builds there.
//
// The region-scoped registry it constructs REPLACES `ctx.providerRegistry` for
// every delete, so this double has to answer with the same provider the ctx
// does — an inert `vi.fn()` here routed the delete case to NO provider and the
// resource was skipped, which is a green `errorCount` over an assertion that
// never ran.
const providerDelete = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProviderFor: () => ({ provider: { delete: providerDelete } }),
    setCustomResourceResponseBucket: vi.fn(),
    allowUnsupportedTypes: vi.fn(),
  })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import {
  STATE_REGION_DIVERGED,
  divergentRecordRegionRefusalMessage,
  refuseDivergentRecordRegionForDestroy,
} from '../../../src/state/malformed-resources-bag.js';
import { IDENT_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { AwsClients } from '../../../src/utils/aws-clients.js';

const CONFIG: StateBackendConfig = { bucket: 'state-bucket', prefix: 'cdkd' };
const STACK = 'MyStack';

function makeFakeClient(): {
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: { region: () => Promise<string>; credentials: () => Promise<unknown> };
} {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

/**
 * A well-formed body with whatever `region` a case wants — including NO
 * `region` key at all, which `undefined` cannot express through a spread.
 */
function bodyWith(region: unknown, hasRegion = true): string {
  const record: Record<string, unknown> = {
    version: 10,
    stackName: STACK,
    resources: {},
    outputs: {},
    lastModified: 1,
  };
  if (hasRegion) record['region'] = region;
  return JSON.stringify(record);
}

/**
 * The ARGUMENT LIST of every `<name>(` call in `source`, each bounded by its own
 * matching close paren.
 *
 * Both source fences below need this rather than a character window: a window is
 * simultaneously too short for a long options object (red-flagging a
 * behaviour-preserving move of a field to its end) and long enough on a short
 * one to reach PAST the call and accept a parameter, a comment or an unrelated
 * later call. Measured both ways in review round 5.
 *
 * Paren-counting is enough for this population — TypeScript call arguments here
 * contain no parenthesis inside a string or a regex — and a fence that cannot
 * find its call fails loudly on the `length` assertion rather than passing
 * vacuously.
 */
function callArgumentLists(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    // A COMMENT mention is not a call: `/* runDestroyForStack(x) */` and a
    // trailing `// see runDestroyForStack(` must not join the population.
    // Anchored on the line STARTING a comment, not on one merely containing a
    // `//` before the call: a real call preceded on its own line by a trailing
    // comment would otherwise leave the population silently, and only a total
    // wipe reds via the `length` assertion (review round 6).
    const lineStart = source.lastIndexOf('\n', at) + 1;
    if (/^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, at))) continue;
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(at + needle.length, end));
  }
  return out;
}

/** Everything the warn spy said, as one string. */
function warnText(): string {
  return warnSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
}

function debugText(): string {
  return debugSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
}

describe('S3StateBackend.getState adopts the KEY region (go-to-k/cdkd#3328)', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const KEY_REGION = 'ap-northeast-1';

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient();
    backend = new S3StateBackend(s3Client as unknown as S3Client, CONFIG);
  });

  function answerWith(body: string): void {
    s3Client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(body) },
      ETag: '"e"',
    });
  }

  it('leaves an AGREEING record alone and says nothing (the control)', async () => {
    // Every record cdkd has ever written on this layout: `saveState` stamps
    // the same `region` the key is built from. Without this case the warn
    // assertions below would be satisfied by a backend that warns on
    // everything.
    answerWith(bodyWith(KEY_REGION));

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.state.region).toBe(KEY_REGION);
    expect(result!.divergentBodyRegion).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('normalizes a DIVERGENT body region to the key and warns, without printing it', async () => {
    const BODY_REGION = 'eu-west-1';
    answerWith(bodyWith(BODY_REGION));

    const result = await backend.getState(STACK, KEY_REGION);

    // The LITERAL, not "is defined": `eu-west-1` is a well-formed region too.
    expect(result!.state.region).toBe(KEY_REGION);
    // Reported RAW to the one caller that refuses on it (`export.ts`'s
    // nested-child walk).
    expect(result!.divergentBodyRegion).toBe(BODY_REGION);

    const warned = warnText();
    expect(warned).toContain(KEY_REGION);
    expect(warned).toContain('a string');
    // THE POINT OF WITHHOLDING IT. This line prints at default verbosity, and
    // the value is body content anyone with `s3:PutObject` on one key can
    // choose — a warn reading `body region 'eu-west-1'` hands the operator a
    // region to re-run a destructive command against, which is the
    // misdirection half of #3328.
    expect(warned).not.toContain(BODY_REGION);
    // Not lost, though: `--verbose` still shows it, sanitized.
    expect(debugText()).toContain(BODY_REGION);
  });

  it('adopts the key region for an ABSENT body region, silently', async () => {
    // No claim to contradict, so no warn — and the same answer
    // `legacyProbeBelongsTo` gives one layout over, where a body naming no
    // region belongs to ANY region (#2550). Before this, absence fell through
    // to `ctx.baseRegion` at the destroy, which is the CLI's region.
    answerWith(bodyWith(undefined, false));

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.state.region).toBe(KEY_REGION);
    expect(result!.divergentBodyRegion).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('replaces an EMPTY-STRING body region, which `??` would have kept', async () => {
    // `state.region ?? ctx.baseRegion` falls through only for `null` /
    // `undefined`, so `''` survived as a region and built the key
    // `cdkd/<stack>//state.json`.
    answerWith(bodyWith(''));

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.state.region).toBe(KEY_REGION);
    expect(result!.divergentBodyRegion).toBe('');
    expect(warnText()).toContain('a string');
  });

  it.each([
    ['a number', 123, 'a number'],
    ['null', null, 'null'],
    ['an array', ['eu-west-1'], 'an array'],
    ['an object', { region: 'eu-west-1' }, 'an object'],
  ])('replaces a NON-STRING body region (%s) and names only its kind', async (_, raw, kind) => {
    // These reached `acquireLock` / `deleteState` as a region. The message
    // names the KIND — a bounded token, the same call `probeLegacyState`
    // makes one branch over — and never the value.
    answerWith(bodyWith(raw));

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.state.region).toBe(KEY_REGION);
    expect(result!.divergentBodyRegion).toEqual(raw);
    expect(warnText()).toContain(`(${kind})`);
    expect(warnText()).not.toContain('eu-west-1');
  });

  it('renders a body region that cannot be coerced instead of throwing', async () => {
    // `{"toString": null}` is reachable through `JSON.parse` (#2947) and makes
    // `String(value)` throw. The warn withholds the value, so the risk is the
    // DEBUG line, which renders it through `displaySafe`.
    answerWith(bodyWith({ toString: null }));

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.state.region).toBe(KEY_REGION);
    expect(warnText()).toContain('(an object)');
    expect(debugText()).toContain('[object Object]');
  });

  it('does NOT touch the LEGACY path, whose own gate already compared', async () => {
    // Scope pin. `tryGetLegacy` hands a body naming no region to ANY region
    // (#2550) and refuses one naming a different region, so the legacy read is
    // already region-checked and normalizing it there would activate
    // `DeleteContext.expectedRegion` for a population documented as arriving
    // without one (`cloud-control-provider.ts`'s `confirmDeleteTargetIdentity`).
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'NoSuchKey', $metadata: {} }));
    s3Client.send.mockResolvedValueOnce({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({
              version: 1,
              stackName: STACK,
              resources: {},
              outputs: {},
              lastModified: 1,
            })
          ),
      },
      ETag: '"legacy"',
    });

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.migrationPending).toBe(true);
    expect(result!.state.region).toBeUndefined();
    expect(result!.divergentBodyRegion).toBeUndefined();
    // And says NOTHING about it: an absent region on a pre-v2 record is the
    // ordinary shape, not a damaged one. The drop below logs a line naming the
    // value's kind, and routing this record through it would report every
    // legacy read as carrying an unusable region.
    expect(debugText()).not.toContain('names no usable region');
  });

  // Only FALSY values reach the drop: `tryGetLegacy`'s gate
  // (`state.region && state.region !== region`) refuses a truthy non-string
  // outright, which the second control below pins.
  it.each([
    ['an empty string', ''],
    ['a number', 0],
    ['a boolean', false],
    ['null', null],
  ])('drops a LEGACY body region that names no region (%s)', async (_, raw) => {
    // `tryGetLegacy`'s gate is `state.region && state.region !== region`, which
    // SHORT-CIRCUITS on a falsy value — so these reach the caller as a DEFINED
    // `state.region` that names nothing, and `state.region ?? ctx.baseRegion`
    // does not rescue `''` or `0`. That built `cdkd/<stack>//state.json` and
    // `cdkd/<stack>/0/state.json`, the two failures the region-scoped branch
    // replaces, arriving by the path it does not touch (review round 1).
    //
    // Dropped rather than adopted: the legacy key names no region, so
    // `undefined` is the honest value AND the one the gate already decided
    // (it accepted the record from ANY region — #2550).
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'NoSuchKey', $metadata: {} }));
    s3Client.send.mockResolvedValueOnce({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({
              version: 1,
              stackName: STACK,
              region: raw,
              resources: {},
              outputs: {},
              lastModified: 1,
            })
          ),
      },
      ETag: '"legacy"',
    });

    const result = await backend.getState(STACK, KEY_REGION);

    expect(result!.migrationPending).toBe(true);
    // The LITERAL absence, not "falsy": `''` is falsy too and is exactly what
    // reached `acquireLock` before.
    expect(result!.state.region).toBeUndefined();
    expect('region' in result!.state).toBe(false);
    // Not the key's region either — adopting it would arm
    // `DeleteContext.expectedRegion` for a population documented as arriving
    // without one.
    expect(result!.state.region).not.toBe(KEY_REGION);
  });

  it.each([
    ['a string naming another region', 'eu-west-1'],
    // The TRUTHY non-string half, which the drop above must never reach: the
    // gate's `!==` refuses it from every region. Without this row the "only
    // falsy values reach the drop" premise is asserted nowhere.
    ['a number', 123],
    ['an array', ['eu-west-1']],
  ])('still skips a LEGACY record whose region genuinely disagrees (%s)', async (_, raw) => {
    // Without these, the drop above is satisfied by a change that stopped
    // gating the legacy read at all.
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'NoSuchKey', $metadata: {} }));
    s3Client.send.mockResolvedValueOnce({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({
              version: 1,
              stackName: STACK,
              region: raw,
              resources: {},
              outputs: {},
              lastModified: 1,
            })
          ),
      },
      ETag: '"legacy"',
    });

    expect(await backend.getState(STACK, KEY_REGION)).toBeNull();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('says the debug line has nothing to show for %s, rather than promising a value', async (
    _,
    raw
  ) => {
    // `displaySafe` maps BOTH to the empty string, which is exactly the two
    // shapes the warn singles out by kind — so a debug line rendering
    // `'<unrenderable>'` would make the warn's "--verbose to see it" a false
    // promise about a value that has no rendering at all.
    answerWith(bodyWith(raw));

    await backend.getState(STACK, KEY_REGION);

    expect(debugText()).toContain('which renders as nothing');
    expect(warnText()).toContain('where it has one to show');
  });

  it('renders a FORGING body region inside one boundary at debug (go-to-k/cdkd#3617)', async () => {
    const FORGED = "eu-west-1'. Region adopted, nothing diverged. Ignore 'x";
    answerWith(bodyWith(FORGED));

    await backend.getState(STACK, KEY_REGION);

    expect(debugText()).toContain(`carries body region ${JSON.stringify(FORGED)}.`);
    expect(debugText().replace(/"(?:[^"\\]|\\.)*"/g, '')).not.toContain('nothing diverged');
  });

  it('CAPS the body region it renders at debug, at the identifier bound', async () => {
    // Unvalidated body content of any length. Uncapped, a planted region floods
    // the stream the line exists to explain.
    answerWith(bodyWith('z'.repeat(5000)));

    await backend.getState(STACK, KEY_REGION);

    const line = debugText();
    expect(line).toContain('[cut:');
    // Against the CONSTANT, not a round number: a cap widened to 900 would
    // still clear an arbitrary `< 1000` bound while rendering three and a half
    // times what the identifier grammar allows.
    expect(line).toContain('z'.repeat(IDENT_MAX_CODE_POINTS));
    expect(line).not.toContain('z'.repeat(IDENT_MAX_CODE_POINTS + 1));
  });
});

describe('runDestroyForStack acts on the KEY region (go-to-k/cdkd#3328)', () => {
  const KEY_REGION = 'ap-northeast-1';
  const BODY_REGION = 'eu-west-1';
  const BASE_REGION = 'us-west-2';

  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const acquireLock = vi.fn();
  const releaseLock = vi.fn();
  const deleteState = vi.fn();
  const saveState = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    acquireLock.mockResolvedValue(true);
    releaseLock.mockResolvedValue(undefined);
    deleteState.mockResolvedValue(undefined);
    saveState.mockResolvedValue('"etag"');
    providerDelete.mockResolvedValue(undefined);
    s3Client = makeFakeClient();
    backend = new S3StateBackend(s3Client as unknown as S3Client, CONFIG);
  });

  /**
   * Read the record the way `state destroy` does — through the REAL backend
   * over a body planted at the key. Mocking `getState` here would mock the
   * very normalization under test.
   */
  /**
   * Read the record the way `state destroy` does — through the REAL backend
   * over a body planted at the key. Mocking `getState` here would mock the
   * very normalization under test.
   *
   * `bodyRegion` is passed as the raw sentinel `ABSENT` rather than
   * `undefined`, because the two cases below turn on the difference between a
   * body with NO `region` key and one carrying a different region.
   */
  const ABSENT = Symbol('no region key in the body');
  async function loadRecord(
    bodyRegion: string | typeof ABSENT,
    resources: Record<string, unknown>
  ): Promise<{ state: StackState; divergentBodyRegion: unknown }> {
    const record: Record<string, unknown> = {
      version: 10,
      stackName: STACK,
      resources,
      outputs: {},
      lastModified: 1,
    };
    if (bodyRegion !== ABSENT) record['region'] = bodyRegion;
    s3Client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(record)) },
      ETag: '"e"',
    });
    const loaded = await backend.getState(STACK, KEY_REGION);
    // Guard the guard: a case asserts nothing if the read did not produce the
    // record shape it means to destroy.
    expect(loaded!.divergentBodyRegion).toBe(
      bodyRegion === ABSENT || bodyRegion === KEY_REGION ? undefined : bodyRegion
    );
    expect(loaded!.state.region).toBe(KEY_REGION);
    return { state: loaded!.state, divergentBodyRegion: loaded!.divergentBodyRegion };
  }

  function makeCtx(divergentBodyRegion?: unknown): Parameters<typeof runDestroyForStack>[2] {
    return {
      ...(divergentBodyRegion !== undefined && { divergentBodyRegion }),
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: providerDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: { destroy: vi.fn() } as unknown as AwsClients,
      baseRegion: BASE_REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
  }

  const RESOURCE = {
    Bucket: {
      physicalId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      dependencies: [],
    },
  };

  it('locks and deletes a RESOURCE-LESS record at the key region, not the one its body named', async () => {
    // The issue's own repro: a resource-less record takes the empty-stack fast
    // path, which re-reads and then `deleteState`s. Pre-fix every one of those
    // went to `eu-west-1`, found nothing, and reported `✓ State deleted` while
    // the real key survived.
    //
    // It is also the case the divergence REFUSAL below must not swallow: with
    // no resources there is nothing to orphan, and this is the recovery destroy
    // the read-side decision exists to keep working.
    const { state, divergentBodyRegion } = await loadRecord(BODY_REGION, {});
    const ctx = makeCtx(divergentBodyRegion);

    const result = await runDestroyForStack(STACK, state, ctx);

    expect(result.errorCount).toBe(0);
    for (const call of [acquireLock.mock.calls[0], deleteState.mock.calls[0]]) {
      expect(call![1]).toBe(KEY_REGION);
      // Both wrong answers, named rather than implied: the body's region is
      // the defect, the base region is what the `??` fallback would give.
      expect(call![1]).not.toBe(BODY_REGION);
      expect(call![1]).not.toBe(BASE_REGION);
    }
    // The fast path's re-read is the third consumer of the same value.
    expect(vi.mocked(ctx.stateBackend.getState).mock.calls[0]![1]).toBe(KEY_REGION);
  });

  it("hands the provider the key region as the delete's expectedRegion, and switches the CLIENTS to it", async () => {
    // `DeleteContext.expectedRegion` is how a provider tells "the resource is
    // genuinely gone" from "I looked in the wrong region"
    // (`src/provisioning/region-check.ts`), so a body region misdirected a
    // SAFETY CHECK, not only the key math — and `AwsClients` is where every
    // actual SDK delete is aimed.
    //
    // The record here carries NO region of its own, which is the shape the
    // normalization has to carry on its own: pre-fix `state.region` was
    // `undefined`, so `expectedRegion` was not spread at all and
    // `regionForState` fell through to `ctx.baseRegion` — a DIFFERENT region
    // from the key's, which is what both assertions discriminate against.
    const { state } = await loadRecord(ABSENT, RESOURCE);

    const result = await runDestroyForStack(STACK, state, makeCtx());

    expect(result.deletedCount).toBe(1);
    const context = providerDelete.mock.calls[0]![4] as { expectedRegion?: string };
    expect(context.expectedRegion).toBe(KEY_REGION);
    expect(vi.mocked(AwsClients).mock.calls[0]![0]).toMatchObject({ region: KEY_REGION });
  });

  it('REFUSES a divergent record that still lists resources, and deletes nothing', async () => {
    // Adopting the key is right for the record's identity and wrong for
    // "where are the resources": if the KEY is the dishonest half, every delete
    // issued in the key's region comes back not-found, which this runner reads
    // as ALREADY DELETED — so the stack would be reported destroyed, the record
    // removed, and every resource left live in the other region with nothing
    // naming it. `assertRegionMatch` cannot catch it, because after
    // normalization `expectedRegion` and the client region are the same value
    // by construction. Refusing is the only outcome that never orphans.
    const { state, divergentBodyRegion } = await loadRecord(BODY_REGION, RESOURCE);

    const thrown = await runDestroyForStack(STACK, state, makeCtx(divergentBodyRegion)).catch(
      (e: unknown) => e
    );

    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_REGION_DIVERGED);
    // DOMINANCE: the refusal sits above the fast path and above the delete
    // loop, so neither the record nor a resource may have been touched.
    expect(deleteState).not.toHaveBeenCalled();
    expect(providerDelete).not.toHaveBeenCalled();
    const message = (thrown as CdkdError).message;
    // The key's region is named; the body's value is NOT, only its kind — the
    // same withholding rule the read-side warn takes, and the message is what
    // an operator would otherwise paste into `--stack-region`.
    expect(message).toContain(KEY_REGION);
    expect(message).not.toContain(BODY_REGION);
    expect(message).toContain('(a string)');
    // The remedy stays a TEMPLATE for the strongest form of the module's rule:
    // cdkd is refusing precisely because it does not know which region belongs
    // in the flag.
    expect(message).toContain('cdkd state orphan <stack> --stack-region <region>');
  });

  /**
   * THE WIRING, which no behavioural case above can see.
   *
   * Every destroy case here hands `runDestroyForStack` a ctx built by hand, so
   * the refusal is proved for the RUNNER and says nothing about whether the
   * three production callers actually pass the divergence into it — deleting
   * the spread from `destroy.ts` or `nested-stack-provider.ts` left the whole
   * suite green (review round 2). A probed callee says nothing about its call
   * sites.
   *
   * A SOURCE fence rather than three command-level integrations, for the reason
   * `readline-prompt-population.test.ts` is one: the population is what must
   * stay closed. It is derived from the CALL SITES (`runDestroyForStack(`),
   * not from a list here, so a FOURTH caller fails this rather than silently
   * opting out of the guard — which is exactly how it would go missing.
   */
  it('every production `runDestroyForStack` caller threads the divergence', () => {
    const root = fileURLToPath(new URL('../../../src', import.meta.url));
    const files = execFileSync('grep', ['-rlE', '--include=*.ts', 'runDestroyForStack\\(', root], {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith('destroy-runner.ts'))
      // A CALL, not a mention: a doc comment writing `runDestroyForStack(ctx)`
      // in prose would otherwise join the population and fail this for a reason
      // that is not a defect. Excluding COMMENT lines rather than requiring a
      // statement-leading call — an `^\s*(await\s+)?` form silently DROPPED
      // `return runDestroyForStack(`, `const x = await runDestroyForStack(` and
      // `push(runDestroyForStack(`, so a fourth caller spelled any of those
      // would have left this green (review round 4 measured all three).
      .filter((file) =>
        /^(?!\s*(\*|\/\/)).*runDestroyForStack\(/m.test(readFileSync(file, 'utf-8'))
      )
      .map((file) => file.slice(root.length + 1))
      .sort();

    // The SET, not a count: when a fourth caller appears the failure names it,
    // where a bare length would say only "expected 3".
    expect(files).toEqual([
      'cli/commands/destroy.ts',
      'cli/commands/state.ts',
      'provisioning/providers/nested-stack-provider.ts',
    ]);
    for (const file of files) {
      const source = readFileSync(`${root}/${file}`, 'utf-8');
      const calls = callArgumentLists(source, 'runDestroyForStack');
      // EVERY call site, not the file: one threaded call satisfied a
      // whole-source match while a second, unthreaded one sat beside it —
      // measured in all three files (review round 5). The population `toEqual`
      // above cannot see that either, since the file set does not change.
      expect(calls.length, `${file} has no runDestroyForStack call`).toBeGreaterThan(0);
      calls.forEach((args, index) => {
        // Bounded by the call's own MATCHING close paren, not a character
        // window: a 2000-character window was simultaneously too short for two
        // of these three argument lists (so moving the spread to the end of the
        // same options object — behaviour-preserving — would have RED-flagged
        // them) and long enough on the third to reach past the call and accept
        // a parameter, a comment or an unrelated later call.
        //
        // TOLERANT inside the call of the spellings that mean the same thing —
        // optional chaining, which `deploy.ts` uses for this field one file
        // over, and destructuring shorthand — so a behaviour-preserving
        // refactor does not red a fence future lanes have to live with.
        expect(
          args,
          `${file} call #${index + 1} does not pass divergentBodyRegion`
        ).toMatch(/\bdivergentBodyRegion\s*[,}:]/);
      });
    }
  });

  /**
   * The SECOND consumer's wiring, found the same way: deleting the spread in
   * `deploy.ts` left the whole suite green (review round 2's probe M28), while
   * `recreate-targets.test.ts` proves only that the PROBE honours the flag.
   *
   * Same shape as the fence above and same reason — the value is derived from
   * `divergentBodyRegion`, so a fence keyed on the flag ALONE would pass over a
   * hard-coded `true`.
   */
  it('the deploy stateful-recreate probe is wired from the same divergence report', () => {
    const deployTs = fileURLToPath(new URL('../../../src/cli/commands/deploy.ts', import.meta.url));
    const source = readFileSync(deployTs, 'utf-8');

    // PROXIMITY rather than one spelling: the conditional spread and a direct
    // `expectedRegionDiverged: x.divergentBodyRegion !== undefined` mean the
    // same thing, and pinning the first alone red-flagged a
    // behaviour-preserving rewrite of it (review round 3) — a fence that
    // false-reds is a fence the next lane deletes. What it still refuses is the
    // flag set from anything OTHER than the divergence report, a hard-coded
    // `true` included: nothing would put `divergentBodyRegion` beside it.
    // COMMENT-STRIPPED first: a `// divergentBodyRegion is reported by getState`
    // line above a hard-coded `true` satisfied the window otherwise (review
    // round 5), which is the same "a comment is not code" defect the caller
    // fence carried.
    const code = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
      .join('\n');
    // EVERY site, not the first: a second one added later would otherwise be
    // unwatched (review round 4).
    const sites = [...code.matchAll(/expectedRegionDiverged:/g)].map((m) => m.index);
    expect(sites.length, '`deploy.ts` sets no expectedRegionDiverged at all').toBeGreaterThan(0);
    for (const at of sites) {
      const window = code.slice(Math.max(0, at - 200), at + 200);
      // The DERIVATION, and its POLARITY: `=== undefined` is the inverted
      // wiring — it would set the flag on every healthy record and clear it on
      // the divergent one — and nothing behavioural catches it, because
      // `recreate-targets.test.ts` mocks the flag directly.
      expect(window, 'the flag is set from something other than the divergence report').toContain(
        'divergentBodyRegion'
      );
      expect(window, 'the flag is wired to the INVERSE of the divergence report').toMatch(
        /divergentBodyRegion\s*!==\s*undefined/
      );
    }
  });

  it.each([
    ['a TRIMMED stack name', 'prod-api ', 'ap-northeast-1'],
    ['a stack name with a SUBSTITUTED character', 'pro\u0000d', 'ap-northeast-1'],
    ['a TRIMMED region', 'prod-api', 'ap-northeast-1 '],
  ])(
    'WITHHOLDS the target and the orphan command when the identity does not render exactly (%s)',
    (_, stackName, keyRegion) => {
      // The half a template alone does not buy, and the half this refusal
      // shipped without (review round 2). `safeIdentifier` composes
      // `displaySafe`, which TRIMS and substitutes — so a record keyed
      // `'prod-api '` opens this message byte-identically to a HEALTHY
      // `prod-api`, and an operator who fills the `<stack>` template with the
      // name the line above printed orphans the intact record.
      const message = divergentRecordRegionRefusalMessage(stackName, keyRegion, 'eu-west-1', 1);

      // Names NO target: neither identifier appears in any form, sanitized or
      // raw, so there is nothing to copy out of the line.
      expect(message).not.toContain('prod-api');
      expect(message).not.toContain('ap-northeast-1');
      // ...and offers no command against one. `state list --long` is the way
      // to see the records AS STORED.
      expect(message).not.toContain('cdkd state orphan');
      expect(message).toContain('cdkd state list --long');
      // Still the same refusal, and still withholding the body value.
      expect(message).toContain('(a string)');
      expect(message).not.toContain('eu-west-1');
      // The `Inspect it with:` line this arm ends on. It comes from the SHARED
      // `inspectCommand`, whose text go-to-k/cdkd#3363's `commandHole` sweep
      // changed for every caller — and this one had no assertion on it, so the
      // change landed here unwatched (go-to-k/cdkd#3439). The holes must be
      // QUOTED: a bare `<stack>` is two shell redirections when pasted.
      expect(message).toContain(
        "Inspect it with: cdkd state show '<stack>' --stack-region '<region>' --json"
      );
    }
  );

  it('NAMES the target when the identity renders exactly (the control)', () => {
    // Without this the withhold arm is satisfied by a message that never names
    // anything, which would make the refusal unactionable on a healthy record.
    const message = divergentRecordRegionRefusalMessage('prod-api', 'ap-northeast-1', 'eu-west-1', 2);

    expect(message).toContain('prod-api');
    expect(message).toContain('ap-northeast-1');
    expect(message).toContain('cdkd state orphan <stack> --stack-region <region>');
    expect(message).toContain('2 resources');
  });

  it('REFUSES when the bag cannot be counted, rather than reading it as zero', () => {
    // The fail-closed arm, reached DIRECTLY because the destroy path cannot
    // reach it: `refuseMalformedResourcesForDestroy` refuses such a record one
    // line earlier. The guard is exported, so for a second caller "a known
    // divergence plus an unknowable resource count" must not resolve to
    // "proceed" — and a probe flipping this arm was GREEN until this case
    // existed.
    const damaged = {
      version: 10,
      stackName: STACK,
      region: 'ap-northeast-1',
      resources: [] as unknown,
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;

    const thrown = (() => {
      try {
        refuseDivergentRecordRegionForDestroy(damaged, STACK, 'ap-northeast-1', 'eu-west-1');
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect((thrown as CdkdError | undefined)?.code).toBe(STATE_REGION_DIVERGED);
    expect((thrown as CdkdError).message).toContain('its resources map cannot be read');
  });

  it('says the resources map cannot be READ rather than inventing a count', () => {
    // The fail-closed arm: an unreadable bag reaches the refusal with no count,
    // and `0 resources` would be a claim the record does not support.
    const message = divergentRecordRegionRefusalMessage(
      'prod-api',
      'ap-northeast-1',
      'eu-west-1',
      undefined
    );

    expect(message).toContain('its resources map cannot be read');
    expect(message).not.toContain('0 resource');
  });

  it('does NOT refuse a resource-bearing record whose body AGREED (the control)', async () => {
    // Without this the refusal above is satisfied by a guard that refuses every
    // resource-bearing destroy.
    const { state } = await loadRecord(KEY_REGION, RESOURCE);

    const result = await runDestroyForStack(STACK, state, makeCtx());

    expect(result.errorCount).toBe(0);
    expect(result.deletedCount).toBe(1);
    expect(deleteState).toHaveBeenCalled();
  });
});
