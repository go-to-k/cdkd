import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd scrub` must REPAIR a cross-stack read name an older binary persisted in
 * plaintext (issue [#3337](https://github.com/go-to-k/cdkd/issues/3337)).
 *
 * go-to-k/cdkd#3289 closed the WRITE side: `imports[].exportName`,
 * `outputReads[].sourceStack` and `outputReads[].outputName` are redacted at the
 * persist choke point, so a name an `Fn::Sub` assembled around a resolved
 * `{{resolve:...}}` no longer reaches `state.json` in plaintext. It did NOT
 * close the repair side — both lists rode `scrubStack`'s `...carriedState`
 * spread untouched, so a record already on disk kept its plaintext and
 * `cdkd scrub --fail` reported it clean.
 *
 * SCOPE IS **NEVER-AGAIN**, and that is narrower than "everything written
 * before the fix". Of the four across-deploy cases the #3289 design doc
 * enumerates, SAME-VALUE self-repairs on the next deploy and DUPLICATE is
 * closed by the union normalizer. **ROTATED is NOT closed by this walk and no
 * case here claims it is**: scrub derives its needles by re-resolving the LIVE
 * template, so it holds the CURRENT secret value, while a rotated record holds
 * a value nothing in the run knows. The `rotated` case below pins that as the
 * declared residual rather than leaving it to be discovered as a silent miss.
 *
 * WHY THE FIELD SET IS THREE AND NOT SIX. `sourceRegion` is an AWS region, and
 * `imports[].sourceStack` is stored VERBATIM forever because
 * `scanActiveConsumers` matches destroy-time refusals on it — redacting it
 * would drop a destroy-blocking record. The write side leaves both alone for
 * the same reason, and the two sides must agree on the set or a scrub would
 * undo a deploy's deliberate decision. The `leaves the two verbatim fields
 * alone` case is what keeps them agreeing.
 */

interface FakeClientConfig {
  region?: string;
}

interface FakeSend {
  ctorRegion: string | undefined;
  command: string;
  input: unknown;
}

const { secretResponses, secretSends, ssmSends, cfnSends, makeFakeClientClass } = vi.hoisted(() => {
  const secretResponses = new Map<string, unknown>();

  const makeFakeClientClass = (sends: FakeSend[], serviceLabel: string): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
      }
      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        const name = command.constructor.name;
        sends.push({ ctorRegion: this.ctorConfig.region, command: name, input: command.input });
        const response = secretResponses.get(`${serviceLabel}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${name}`);
        }
        if (response instanceof Error) throw response;
        return response;
      }
      destroy(): void {}
    };

  return {
    secretResponses,
    secretSends: [] as FakeSend[],
    ssmSends: [] as FakeSend[],
    cfnSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, CloudFormationClient: makeFakeClientClass(cfnSends, 'cloudformation') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import { producerNameIsUnresolved } from '../../../../src/cli/commands/recreate-downstream-consumers.js';
import {
  redactSecretsForState,
  SECRET_MASK,
} from '../../../../src/deployment/secret-redaction.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const REGION = 'us-east-1';
const STACK = 'Consumer';
const SECRET_ID = 'prod/db';
const SECRET_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
/** The value the LIVE template resolves to — i.e. what this run learns. */
const PLAINTEXT = 'live-db-password-3337';
/** A value the reference used to resolve to, before a rotation. */
const ROTATED_AWAY = 'old-db-password-3337';
/**
 * The ARN form NAMES its region, so `classifyReplaySecretRegion` returns
 * `named-region` instead of `ambiguous` and scrub does not refuse a stack whose
 * recorded producer region differs from its own.
 */
const ARN_SECRET_EXPR =
  '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db:SecretString:password}}';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let stateBackend: {
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  listStacks: ReturnType<typeof vi.fn>;
};
let lockManager: {
  acquireLockWithRetry: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
};
let savedRegion: string | undefined;
let state: StackState;

/**
 * The resource property is the expression itself, so re-resolving today's
 * template records `PLAINTEXT -> SECRET_EXPR` as a needle. That is the ONLY
 * thing this run learns, which is exactly why ROTATED cannot be repaired.
 */
function makeState(extra: Partial<StackState>): StackState {
  return {
    version: 10,
    region: REGION,
    stackName: STACK,
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { MasterUserPassword: SECRET_EXPR },
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

function makeStackInfo(properties?: Record<string, unknown>): unknown {
  return {
    stackName: STACK,
    dependencyNames: [],
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: properties ?? { MasterUserPassword: SECRET_EXPR },
        },
      },
    } as CloudFormationTemplate,
  };
}

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  process.env['AWS_REGION'] = REGION;
  secretResponses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  cfnSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: REGION }));
  // The expression selects `:SecretString:password`, so the secret must be a
  // JSON document with that key -- a bare string resolves to nothing, records
  // no needle, and every case below then passes vacuously over an unscrubbed
  // record.
  secretResponses.set('secretsmanager|GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: PLAINTEXT }),
  });
  stateBackend = {
    getState: vi.fn().mockImplementation(() => Promise.resolve({ state, etag: 'c-1' })),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    listStacks: vi.fn().mockResolvedValue([]),
  };
  lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  resetAwsClients();
  clearRecordedSecretExpressions();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

async function scrub(
  opts?: { dryRun?: boolean },
  templateProperties?: Record<string, unknown>
): Promise<{ recordsChanged: number }> {
  return (await scrubStack(makeStackInfo(templateProperties) as never, REGION, stateBackend as never, lockManager as never, {
    dryRun: opts?.dryRun ?? false,
    logger: logger as never,
  })) as { recordsChanged: number };
}

function savedState(): StackState {
  expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
  return stateBackend.saveState.mock.calls[0]![2] as StackState;
}

describe('cdkd scrub repairs cross-stack read names (issue #3337)', () => {
  it('rewrites a plaintext imports[].exportName back to its expression', async () => {
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `prod-${PLAINTEXT}-export` },
      ],
    });

    const res = await scrub();

    expect(savedState().imports).toEqual([
      { sourceStack: 'Producer', sourceRegion: REGION, exportName: `prod-${SECRET_EXPR}-export` },
    ]);
    // EXACTLY one: the count is per changed ENTRY, not per changed field, and
    // `toBeGreaterThan(0)` cannot see a regression that counts per field.
    expect(res.recordsChanged).toBe(1);
  });

  it('rewrites both template-derived outputReads fields', async () => {
    state = makeState({
      outputReads: [
        {
          sourceStack: `stack-${PLAINTEXT}`,
          sourceRegion: REGION,
          outputName: `out-${PLAINTEXT}`,
        },
      ],
    });

    await scrub();

    expect(savedState().outputReads).toEqual([
      {
        sourceStack: `stack-${SECRET_EXPR}`,
        sourceRegion: REGION,
        outputName: `out-${SECRET_EXPR}`,
      },
    ]);
  });

  /**
   * THE FIELD SET MUST MATCH THE WRITE SIDE. `sourceRegion` is an AWS region and
   * `imports[].sourceStack` is the literal key `scanActiveConsumers` matches a
   * destroy-time refusal on, so redacting either drops a destroy-blocking
   * record. A scrub that "improved" on the write side here would silently undo
   * a deliberate decision.
   */
  it('leaves sourceRegion and imports[].sourceStack verbatim even when they carry the plaintext', async () => {
    // `sourceRegion` CARRIES the needle here on purpose. With a plain
    // `us-east-1` the assertion passes whether or not the walk touches the
    // field, so the claim that BOTH verbatim fields are fenced would have been
    // true of only one of them.
    //
    // THE ARN FORM IS REQUIRED TO REACH THIS STATE, and finding that out is
    // half the case. `producerRegionsFromState` reads `sourceRegion`, so a
    // value that is not this stack's region reads as a CROSS-REGION producer;
    // with a name-form reference scrub then refuses the stack outright
    // (`regionAmbiguousScrubSecretError`) before any walk runs, because a
    // same-named secret in two regions is two independent values. An ARN names
    // its own region, so the reference is resolved there and the refusal does
    // not apply -- which is what lets the verbatim claim be asserted at all.
    const region = `${REGION}-${PLAINTEXT}`;
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: ARN_SECRET_EXPR },
        },
      },
      imports: [
        {
          sourceStack: `producer-${PLAINTEXT}`,
          sourceRegion: region,
          exportName: `e-${PLAINTEXT}`,
        },
      ],
    });

    await scrub(undefined, { MasterUserPassword: ARN_SECRET_EXPR });

    const [entry] = savedState().imports!;
    expect(entry!.sourceStack).toBe(`producer-${PLAINTEXT}`);
    expect(entry!.sourceRegion).toBe(region);
    expect(entry!.exportName).toBe(`e-${ARN_SECRET_EXPR}`);
  });

  /**
   * THE DECLARED RESIDUAL. A rotated record holds a plaintext this run cannot
   * know: scrub's needles come from re-resolving the live template, which
   * returns the CURRENT value. The record is left untouched rather than
   * mangled, and this case exists so the limit is asserted rather than
   * discovered.
   */
  it('does NOT repair a ROTATED record — its plaintext is a value this run never sees', async () => {
    // A repairable leaf ELSEWHERE forces a save, so "the rotated name survived"
    // is observed on a record this run actually WROTE. Without it the run
    // changes nothing, `scrubStack` never saves, and the case would pass
    // whether or not the walk ran at all.
    // The REPAIRABLE sibling is what makes this case discriminate. Without it
    // the case passes with the write-back deleted AND with the redactor made
    // identity -- it would read as evidence for a feature that could be fully
    // reverted. With it, "the rotated name survived" is asserted on the same
    // saved list that PROVES the walk ran.
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `e-${ROTATED_AWAY}-x` },
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `live-${PLAINTEXT}` },
      ],
    });

    await scrub();

    const entries = savedState().imports!;
    expect(entries[0]!.exportName).toBe(`e-${ROTATED_AWAY}-x`);
    expect(entries[1]!.exportName).toBe(`live-${SECRET_EXPR}`);
  });

  /** A name carrying no secret is persisted verbatim — the control. */
  it('leaves a name that carries no secret alone', async () => {
    // Same reason as the ROTATED case: a repairable leaf elsewhere makes the
    // save happen, so the names are asserted on a written record.
    const imports = [
      { sourceStack: 'Producer', sourceRegion: REGION, exportName: 'Producer:PublicBucketName' },
    ];
    const outputReads = [{ sourceStack: 'Other', sourceRegion: REGION, outputName: 'BucketArn' }];
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
      imports,
      outputReads,
    });
    const expectedImports = structuredClone(imports);
    const expectedOutputReads = structuredClone(outputReads);

    const res = await scrub();

    // Cloned BEFORE the run: comparing against the same array objects the
    // fixture still holds makes an in-place mutation compare equal to itself,
    // so a mutant that rewrote entries in place passed this case while redding
    // every other one.
    expect(savedState().imports).toEqual(expectedImports);
    expect(savedState().outputReads).toEqual(expectedOutputReads);
    // ONE change -- the resource leaf. Without this pin, deleting the
    // `outputReads` unchanged-entry guard reds nothing: every entry would count
    // as changed, the state would be rewritten, and `--dry-run --fail` would
    // exit 1 over clean state.
    expect(res.recordsChanged).toBe(1);
  });

  /**
   * A state file that records no cross-stack reads must not GAIN the keys by
   * being scrubbed — both are optional in the schema, and materialising `[]`
   * is a write this command never intended. The `orphans` spread beside it
   * makes the same decision for the same reason.
   */
  it('does not add imports / outputReads keys to a record that had none', async () => {
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
    });

    await scrub();

    const saved = savedState();
    expect('imports' in saved).toBe(false);
    expect('outputReads' in saved).toBe(false);
  });

  /**
   * B1 (review): the change check is `sourceStack === ... && outputName === ...`.
   * Flipping that `&&` to `||` left every earlier case green while a
   * partially-secret entry kept its plaintext AND went uncounted -- i.e. scrub
   * reporting clean on exactly the record this exists to repair.
   */
  it('repairs an outputReads entry where only ONE field carries the secret', async () => {
    state = makeState({
      outputReads: [
        { sourceStack: `stack-${PLAINTEXT}`, sourceRegion: REGION, outputName: 'PlainOutput' },
      ],
    });

    const res = await scrub();

    expect(savedState().outputReads).toEqual([
      { sourceStack: `stack-${SECRET_EXPR}`, sourceRegion: REGION, outputName: 'PlainOutput' },
    ]);
    // ONE entry changed, not one per field.
    expect(res.recordsChanged).toBe(1);
  });

  it('counts a fully-changed outputReads entry once, not once per field', async () => {
    state = makeState({
      outputReads: [
        { sourceStack: `s-${PLAINTEXT}`, sourceRegion: REGION, outputName: `o-${PLAINTEXT}` },
      ],
    });

    const res = await scrub();

    expect(res.recordsChanged).toBe(1);
  });

  /**
   * An already-redacted entry beside a repairable one. This does NOT exercise
   * the token guard -- measured: disabling `strictlyInsideASpan` reds nothing
   * here, because the needle in this fixture does not occur inside the
   * persisted span. What it DOES fence is the imports unchanged-entry
   * early-return, which nothing else reds.
   *
   * The guard's own hazard -- a union needle occurring INSIDE an already-stored
   * expression, which would splice
   * `{{resolve:secretsmanager:{{resolve:...}}/db:...}}` -- is covered by the
   * case below.
   */
  it('leaves an already-redacted name alone while repairing its sibling', async () => {
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `live-${SECRET_EXPR}` },
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `fix-${PLAINTEXT}` },
      ],
    });

    const res = await scrub();

    const entries = savedState().imports!;
    // The already-redacted one is untouched...
    expect(entries[0]!.exportName).toBe(`live-${SECRET_EXPR}`);
    // ...and the repairable one produces the SAME spelling, so a second run
    // would change nothing.
    expect(entries[1]!.exportName).toBe(`fix-${SECRET_EXPR}`);
    expect(res.recordsChanged).toBe(1);
  });

  /**
   * The cross-file coupling go-to-k/cdkd#3337's verification plan asks for. A
   * repaired `outputReads[].sourceStack` is ALSO the literal key
   * `findDownstreamConsumers` matches on, and go-to-k/cdkd#3289 added a
   * reporting arm so such an entry is surfaced in the DATA-LOSS prompt rather
   * than silently dropped. The arm keys on `producerNameIsUnresolved`, so what
   * must hold is that every shape this walk can write is recognised by it.
   */
  it('writes a sourceStack the downstream-consumer reporter recognises as unnameable', async () => {
    state = makeState({
      outputReads: [
        { sourceStack: `stack-${PLAINTEXT}`, sourceRegion: REGION, outputName: 'Out' },
      ],
    });

    await scrub();

    const [entry] = savedState().outputReads!;
    // CALL THE REAL PREDICATE. An earlier revision asserted
    // `toContain('{{resolve:')` instead, which fences nothing about the
    // coupling and is STRICTER than the reporter: a MASK-ONLY needle redacts to
    // `***`, which `producerNameIsUnresolved` accepts and that assertion
    // rejects. Restating a predicate more narrowly than its owner is how a
    // consumer drifts from it.
    expect(producerNameIsUnresolved(entry!.sourceStack)).toBe(true);
    // ...and the control: an ordinary name is NOT reported, so the assertion
    // above is not satisfied by everything.
    expect(producerNameIsUnresolved('OrdinaryProducer')).toBe(false);
  });

  /**
   * THE MASK-ONLY OUTPUT SHAPE. A `RecordedSecretValues` bag can hold a needle
   * whose value is `SECRET_MASK` rather than an expression (the go-to-k/cdkd#2274
   * class, reachable into scrub's union through `recordMaskOnlyValue`), so the
   * walk can write `***` into a name. The reporter accepts that too; nothing
   * asserted it, and the assertion that used to stand here would have REJECTED
   * it.
   */
  it('a mask-only needle writes a name the reporter still recognises', () => {
    const masked = redactSecretsForState('stack-abc', new Map([['stack-abc', SECRET_MASK]]));
    expect(masked).toBe(SECRET_MASK);
    expect(producerNameIsUnresolved(masked as string)).toBe(true);
  });

  /**
   * THE TOKEN-GUARD HAZARD ITSELF. `SECRET_ID` (`prod/db`) occurs INSIDE the
   * persisted `{{resolve:secretsmanager:prod/db:...}}` span. Re-scanning it
   * with `prod/db` as a needle would splice a nested expression into the name
   * -- the corruption `redactUnaccountedOutputs` carries a blocker note about.
   * `redactSecretsForState` spares a needle lying strictly inside a complete
   * span, and this is what reds if that stops holding.
   */
  it('does not splice a needle that lies INSIDE an already-persisted expression', () => {
    const stored = `producer-${SECRET_EXPR}`;
    const spliced = redactSecretsForState(
      stored,
      new Map([[SECRET_ID, '{{resolve:ssm-secure:/other/param}}']])
    );
    expect(spliced).toBe(stored);
  });

  // NOTE: `[]` round-tripping is NOT fenced here. It survives via the
  // pre-existing `...carriedState` spread, so it stays green under every
  // mutation of the new code -- measured. The case is kept because the schema
  // distinguishes `[]` ("reads nothing") from an absent key ("pre-v8 record"),
  // and its sibling above IS the fence for the conditional spread.
  it('leaves outputReads[].sourceRegion verbatim even when it carries the plaintext', async () => {
    // Mirrors the imports case, and needs the ARN form for the same reason: a
    // needle-bearing region reads as a cross-region producer and would
    // otherwise refuse the stack before any walk runs.
    const region = `${REGION}-${PLAINTEXT}`;
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: ARN_SECRET_EXPR },
        },
      },
      outputReads: [
        { sourceStack: `s-${PLAINTEXT}`, sourceRegion: region, outputName: 'Out' },
      ],
    });

    await scrub(undefined, { MasterUserPassword: ARN_SECRET_EXPR });

    const [entry] = savedState().outputReads!;
    expect(entry!.sourceRegion).toBe(region);
    expect(entry!.sourceStack).toBe(`s-${ARN_SECRET_EXPR}`);
  });

  it('round-trips an EMPTY imports / outputReads list as [] rather than dropping it', async () => {
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
      imports: [],
      outputReads: [],
    });

    await scrub();

    const saved = savedState();
    expect(saved.imports).toEqual([]);
    expect(saved.outputReads).toEqual([]);
  });

  it('writes nothing under --dry-run', async () => {
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `e-${PLAINTEXT}` },
      ],
    });

    const res = await scrub({ dryRun: true });

    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // Still COUNTED, so `--dry-run --fail` reddens on a record a real run would
    // repair — which is what makes it usable as a standing CI gate. Pinned
    // exactly, like its three siblings.
    expect(res.recordsChanged).toBe(1);
  });
});
