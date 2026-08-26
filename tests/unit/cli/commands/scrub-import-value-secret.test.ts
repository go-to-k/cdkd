import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd scrub` must be able to resolve a CROSS-STACK read, and must REFUSE when
 * it cannot (issue [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * scrub learns which plaintexts to look for by RE-RESOLVING today's template.
 * None of the three resolve contexts it built supplied `stateBackend`, which
 * both `Fn::ImportValue` and `Fn::GetStackOutput` require — so every cross-stack
 * read threw, the throw landed in scrub's per-item best-effort
 * `catch { logger.debug(...) }`, and the leaf was silently treated as
 * unresolvable: no plaintext, therefore no needle, therefore nothing for the
 * value scan to find, therefore "no plaintext secrets found" over a state file
 * that may still hold it.
 *
 * WHY THIS FILE USES THE REAL RESOLVER and fakes only the leaf SDK clients (the
 * choice `scrub-cross-region-secret.test.ts` makes for its own question): the
 * subject is whether the cross-stack READ actually happens, and a resolver
 * double has no state backend to be asked for. The fake `stateBackend` is what
 * makes "which call did the stub receive" observable at all.
 *
 * The producer's export holds the `{{resolve:...}}` EXPRESSION rather than a
 * plaintext, which is what issue #1934 persists for a secret-bearing export —
 * so resolving the import means re-resolving that expression, which is the step
 * that records the needle.
 */

interface FakeClientConfig {
  region?: string;
}

interface FakeSend {
  ctorRegion: string | undefined;
  command: string;
  input: unknown;
}

const { secretResponses, secretSends, cfnSends, makeFakeClientClass } = vi.hoisted(() => {
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
    cfnSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

// The `Fn::ImportValue` miss path falls back to CloudFormation `ListExports`
// (`cfnFallback` defaults to true). Nothing is primed for it, so the fake throws
// and `lookupCfnExport` degrades to "not found" — which is the shape the refusal
// case needs, and which keeps a real network call out of the unit suite.
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
import {
  clearRecordedSecretExpressions,
  SECRET_MASK,
} from '../../../../src/deployment/secret-redaction.js';
import {
  scrubStack,
  orderScrubTargets,
  producerPublishesSecretExpression,
  buildExportOwnerIndex,
  scrubRefusalWording,
} from '../../../../src/cli/commands/scrub.js';
import { IntrinsicFunctionResolver } from '../../../../src/deployment/intrinsic-function-resolver.js';
import {
  CrossAccountSecretRefusalError,
  IntrinsicResolutionRefusalError,
} from '../../../../src/utils/error-handler.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const REGION = 'us-east-1';
const CONSUMER = 'Consumer';
const PRODUCER = 'Producer';
const EXPORT_NAME = 'Producer:DbSecret';
const OUTPUT_NAME = 'DbSecret';
const SECRET_ID = 'prod/db/cred';
const SECRET_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
/** The plaintext an older binary resolved and stored in the CONSUMER's record. */
const PLAINTEXT = 'imported-db-password-2133';

const logger = {
  debug: (...a: unknown[]): void => void logLines.push(`debug ${a.map(String).join(' ')}`),
  info: (...a: unknown[]): void => void logLines.push(`info ${a.map(String).join(' ')}`),
  warn: (...a: unknown[]): void => void logLines.push(`warn ${a.map(String).join(' ')}`),
  error: (...a: unknown[]): void => void logLines.push(`error ${a.map(String).join(' ')}`),
} as never;

function makeStackInfo(
  properties: Record<string, unknown>,
  extra?: { outputs?: Record<string, unknown>; conditions?: Record<string, unknown> }
): {
  stackName: string;
  displayName: string;
  artifactId: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return {
    stackName: CONSUMER,
    displayName: CONSUMER,
    artifactId: CONSUMER,
    dependencyNames: [],
    template: {
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: properties },
      },
      ...(extra?.conditions && { Conditions: extra.conditions }),
      ...(extra?.outputs && { Outputs: extra.outputs }),
    } as CloudFormationTemplate,
  };
}

/**
 * The consumer's record as an older binary wrote it: the imported secret's
 * PLAINTEXT at both leaves. `MasterUsername` is the load-bearing one — its
 * template side is the public literal `admin`, so no position pass can reach it
 * and only a NEEDLE can, which is exactly what the cross-stack read produces.
 */
function makeConsumerState(
  properties: Record<string, unknown> = { MasterUserPassword: PLAINTEXT, MasterUsername: PLAINTEXT },
  outputs: Record<string, unknown> = {}
): StackState {
  return {
    version: 8,
    region: REGION,
    stackName: CONSUMER,
    resources: {
      Db: { physicalId: 'db-1', resourceType: 'AWS::RDS::DBInstance', properties },
    },
    outputs,
    lastModified: 0,
  };
}

function makeProducerState(outputs: Record<string, unknown>): StackState {
  return {
    version: 8,
    region: REGION,
    stackName: PRODUCER,
    resources: {},
    outputs,
    lastModified: 0,
  };
}

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

/** Wire the fake backend so the producer's state carries `outputs`. */
function useProducerOutputs(outputs: Record<string, unknown> | undefined): void {
  stateBackend.listStacks.mockResolvedValue(
    outputs ? [{ stackName: PRODUCER, region: REGION }] : []
  );
  stateBackend.getState.mockImplementation((stackName: string) => {
    if (stackName === PRODUCER) {
      return Promise.resolve(outputs ? { state: makeProducerState(outputs), etag: 'p-1' } : null);
    }
    return Promise.resolve({ state: consumerState, etag: 'c-1' });
  });
}

let consumerState: StackState;

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  process.env['AWS_REGION'] = REGION;
  secretResponses.clear();
  secretSends.length = 0;
  cfnSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: REGION }));
  secretResponses.set('secretsmanager|GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: PLAINTEXT }),
  });
  consumerState = makeConsumerState();
  stateBackend = {
    getState: vi.fn(),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    listStacks: vi.fn().mockResolvedValue([]),
  };
  lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });
});

afterEach(() => {
  resetAwsClients();
  clearRecordedSecretExpressions();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

/**
 * The PRODUCER as the synthesized app carries it. `scrubStack` reads only its
 * `Outputs`, and only to answer "does this export come from a
 * `{{resolve:...}}` expression" — the discriminator that keeps the
 * plaintext-producer refusal off every ordinary import.
 */
function makeProducerStackInfo(outputs: Record<string, unknown>): {
  stackName: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return {
    stackName: PRODUCER,
    dependencyNames: [],
    template: { Resources: {}, Outputs: outputs } as CloudFormationTemplate,
  };
}

/** The producer template shape that DOES publish a secret: an output whose value is the expression. */
const SECRET_PRODUCER_OUTPUTS = {
  [OUTPUT_NAME]: { Value: SECRET_EXPR, Export: { Name: EXPORT_NAME } },
};
/** The producer template shape that publishes an ORDINARY value. */
const PUBLIC_PRODUCER_OUTPUTS = {
  [OUTPUT_NAME]: { Value: { Ref: 'Bucket' }, Export: { Name: EXPORT_NAME } },
};

async function scrub(
  properties: Record<string, unknown>,
  extra?: {
    outputs?: Record<string, unknown>;
    conditions?: Record<string, unknown>;
    appStacks?: readonly unknown[];
    dryRun?: boolean;
  }
): Promise<{
  recordsChanged: number;
  secretsFound: number;
  secretBearingKeys: number;
  unverifiableReads: number;
}> {
  return await scrubStack(
    makeStackInfo(properties, extra) as never,
    REGION,
    stateBackend as never,
    lockManager as never,
    {
      dryRun: extra?.dryRun ?? false,
      logger,
      ...(extra?.appStacks && { appStacks: extra.appStacks as never }),
    }
  );
}

function savedState(): StackState {
  expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
  return stateBackend.saveState.mock.calls[0]![2] as StackState;
}

describe('cdkd scrub resolves a cross-stack read (issue #2133)', () => {
  it('Fn::ImportValue: the producer state IS read, the imported secret becomes a needle, and the plaintext is scrubbed', async () => {
    const res = await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: 'admin',
    });

    // The read actually happened — the positive marker only the wired path can
    // emit. Before the fix `resolveImportValue` threw for want of a state
    // backend, so the producer's record was never asked for.
    expect(stateBackend.listStacks).toHaveBeenCalled();
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    // ... and the export's `{{resolve:...}}` expression was re-resolved, which
    // is the step that RECORDS the needle.
    expect(secretSends.map((s) => s.command)).toEqual(['GetSecretValueCommand']);
    expect((secretSends[0]!.input as { SecretId?: string }).SecretId).toBe(SECRET_ID);

    const saved = savedState();
    // THE discriminator: this leaf's template side is the public literal
    // `admin`, so no position pass can reach it. Only the needle the cross-stack
    // read produced can, and without it the plaintext survives while the command
    // reports the stack clean.
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
    expect(res.recordsChanged).toBe(1);
  });

  it('Fn::GetStackOutput: the named producer stack IS read and its secret becomes a needle', async () => {
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(
        stackName === PRODUCER
          ? { state: makeProducerState({ [OUTPUT_NAME]: SECRET_EXPR }), etag: 'p-1' }
          : { state: consumerState, etag: 'c-1' }
      )
    );

    await scrub({
      MasterUserPassword: {
        'Fn::GetStackOutput': { StackName: PRODUCER, OutputName: OUTPUT_NAME },
      },
      MasterUsername: 'admin',
    });

    // `getSameAccountStackState` reads the producer directly — no `listStacks`
    // scan on this route, which is what tells the two intrinsics apart.
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('an OUTPUT that re-publishes an imported secret has its stored plaintext scrubbed', async () => {
    consumerState = makeConsumerState(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { DbUrl: PLAINTEXT }
    );
    useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });

    await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { outputs: { DbUrl: { Value: { 'Fn::ImportValue': EXPORT_NAME } } } }
    );

    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    expect(savedState().outputs['DbUrl']).toBe(SECRET_EXPR);
  });
});

describe('cdkd scrub REFUSES a cross-stack read it cannot perform (issue #2133)', () => {
  it('an unreadable Fn::ImportValue refuses the stack instead of reporting it clean', async () => {
    useProducerOutputs(undefined);

    const err = await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Fn::ImportValue');
    expect(message).toContain("resource 'Db'");
    expect(message).toContain('MasterUserPassword');
    // A `CdkdError` with a code is what maps to a NON-ZERO exit rather than a
    // debug line under a "nothing to scrub" summary.
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    // Exit 2 ("error"), not the `--fail` code 1 ("plaintext found").
    expect((err as { exitCode?: number }).exitCode).toBe(2);

    // Nothing is written for a stack scrub could not examine, and the lock is
    // still released (the refusal is raised inside the try/finally).
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('an unreadable import in an OUTPUT VALUE refuses too — each resolve context is guarded, not just the resource one', async () => {
    useProducerOutputs(undefined);

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { outputs: { DbUrl: { Value: { 'Fn::ImportValue': 'no-such-export' } } } }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("output 'DbUrl'");
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('an unreadable import in an intrinsic EXPORT NAME refuses too — the third context', async () => {
    useProducerOutputs(undefined);

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      {
        outputs: {
          DbUrl: { Value: 'public', Export: { Name: { 'Fn::ImportValue': 'no-such-export' } } },
        },
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("Export.Name of output 'DbUrl'");
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: an unresolvable Ref is still swallowed by the best-effort catch, and the rest of the resource is scrubbed', async () => {
    // No cross-stack read at all. The secret resolves, then the `Ref` throws —
    // exactly the partially-resolvable template the catch exists for. A refusal
    // that fired on any resolution failure would fail this case, which is what
    // makes the refusal above a statement about cross-stack reads rather than
    // about failure in general.
    const res = await scrub({
      MasterUserPassword: SECRET_EXPR,
      MasterUsername: 'admin',
      DBSubnetGroupName: { Ref: 'NotInState' },
    });

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(logLines.some((l) => l.includes('during scrub was partial'))).toBe(true);
  });

  it('NEGATIVE CONTROL: a RESOLVABLE import beside an unresolvable Ref does not refuse — the scope is the cross-stack read, not the bag', async () => {
    const res = await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: 'admin',
      DBSubnetGroupName: { Ref: 'NotInState' },
    });

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('NEGATIVE CONTROL: an import in the NOT-TAKEN Fn::If branch is never read, so an unreadable one does not refuse', async () => {
    // `resolveIf` resolves only the selected branch (and assumes FALSE for an
    // unknown condition), so a reference the main resolution would never touch
    // must not refuse the stack. Without that mirror, every conditional import
    // of a not-yet-deployed producer would make `cdkd scrub` unusable.
    stateBackend.listStacks.mockResolvedValue([]);
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(stackName === PRODUCER ? null : { state: consumerState, etag: 'c-1' })
    );

    const res = await scrub(
      {
        MasterUserPassword: {
          'Fn::If': ['IsProd', { 'Fn::ImportValue': 'no-such-export' }, SECRET_EXPR],
        },
        MasterUsername: 'admin',
      },
      { conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } } }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    // The unreadable export was never looked for.
    expect(stateBackend.listStacks).not.toHaveBeenCalled();
  });
});

describe('the pre-pass walks what the RESOLVER walks (issue #2133 review)', () => {
  it('REFUSES an unreadable import nested inside an ARRAY — the commonest real import shape', async () => {
    // `{"Fn::Join": ["", [{"Fn::ImportValue": ...}]]}` is what CDK emits for an
    // imported value spliced into a string, and the pre-pass reaches it only
    // through its array arm. No earlier fixture put a cross-stack read inside an
    // array at all, so deleting `if (Array.isArray(v)) ...` left every case
    // green.
    //
    // The assertion is the REFUSAL rather than the resolved needle, and that is
    // the whole point: a needle is produced by the MAIN resolution too, so a
    // resolve-positive fixture stays green with the pre-pass's array arm
    // deleted — measured doing exactly that. Only the refusal is the pre-pass's
    // alone.
    useProducerOutputs(undefined);

    const err = await scrub({
      MasterUserPassword: { 'Fn::Join': ['', [{ 'Fn::ImportValue': 'no-such-export' }]] },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("resource 'Db'");
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('and a READABLE import inside an array still becomes a needle', async () => {
    // The other polarity, so the refusal above is a statement about
    // unreadability rather than about arrays.
    const res = await scrub({
      MasterUserPassword: { 'Fn::Join': ['', [{ 'Fn::ImportValue': EXPORT_NAME }]] },
      MasterUsername: 'admin',
    });

    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(res.recordsChanged).toBe(1);
  });

  it('a HIGHER-precedence sibling key suppresses the read, because the resolver never reaches it', async () => {
    // `resolveValue` tests `Ref` long before `Fn::ImportValue`, so this node
    // resolves as a `Ref` and the import is never performed. A pre-pass that
    // tested the cross-stack keys FIRST performed a read the main resolution
    // does not — and an unreadable one then refused the stack over a reference
    // the deploy never made.
    useProducerOutputs(undefined);

    // `MasterUsername` FIRST: the main resolution walks properties in order and
    // the `Ref` below throws, so a secret declared after it would never be
    // recorded and `recordsChanged` would be 0 for a reason unrelated to the
    // property under test.
    const res = await scrub({
      MasterUsername: SECRET_EXPR,
      MasterUserPassword: { Ref: 'NotInState', 'Fn::ImportValue': 'no-such-export' },
    });

    expect(res.recordsChanged).toBe(1);
    // POSITIVE marker: the export was never looked for at all.
    expect(stateBackend.listStacks).not.toHaveBeenCalled();
  });

  it('a LOWER-precedence sibling key does NOT suppress it — the other half of the same rule', async () => {
    // `Fn::FindInMap` comes AFTER `Fn::ImportValue` in the resolver's dispatch,
    // so this node IS an import and an unreadable one must still refuse. Without
    // this half, "never read anything with a sibling" would pass the test above
    // while silently reintroducing the original silent success.
    useProducerOutputs(undefined);

    const err = await scrub({
      MasterUserPassword: {
        'Fn::ImportValue': 'no-such-export',
        'Fn::FindInMap': ['M', 'a', 'b'],
      },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect(stateBackend.listStacks).toHaveBeenCalled();
  });

  it("the pre-pass's precedence list matches the resolver's dispatch order", () => {
    // A source-level fence rather than a behavioural one, because the failure it
    // guards is a FUTURE intrinsic added to the resolver and not to the copy in
    // `scrub.ts` — there is no input that exercises a key nobody has written
    // yet. Fenced the way `cross-cutting-list-sync.test.ts` fences its own
    // duplicated lists.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const resolverSrc = readFileSync(
      `${here}../../../../src/deployment/intrinsic-function-resolver.ts`,
      'utf8'
    );
    const scrubSrc = readFileSync(`${here}../../../../src/cli/commands/scrub.ts`, 'utf8');

    const dispatch = resolverSrc.slice(
      resolverSrc.indexOf('private async resolveValue('),
      resolverSrc.indexOf('private async resolveRef(')
    );
    const resolverOrder = [...dispatch.matchAll(/if \('([A-Za-z:]+)' in obj\)/g)]
      .map((m) => m[1] as string)
      // `Condition` is gated on `context.conditionResolver`, which no context
      // the pre-pass runs under supplies.
      .filter((k) => k !== 'Condition');

    const listStart = scrubSrc.indexOf('const RESOLVER_INTRINSIC_PRECEDENCE = [');
    const listBody = scrubSrc.slice(listStart, scrubSrc.indexOf('] as const;', listStart));
    const scrubOrder = [...listBody.matchAll(/'([A-Za-z:]+)'/g)].map((m) => m[1] as string);

    expect(resolverOrder.length).toBeGreaterThan(10);
    expect(scrubOrder).toEqual(resolverOrder);
  });
});

describe('every cross-stack resolve context is guarded (issue #2133)', () => {
  it('Fn::GetStackOutput refuses too, not only Fn::ImportValue', async () => {
    // Only the RESOLVE half of `Fn::GetStackOutput` was fenced, so shrinking
    // `CROSS_STACK_INTRINSIC_KEYS` to `['Fn::ImportValue']` stayed green.
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(stackName === PRODUCER ? null : { state: consumerState, etag: 'c-1' })
    );

    const err = await scrub({
      MasterUserPassword: {
        'Fn::GetStackOutput': { StackName: PRODUCER, OutputName: OUTPUT_NAME },
      },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain('Fn::GetStackOutput');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('the TAKEN Fn::If branch refuses — the ifTrue arm, whose twin negative control only covers ifFalse', async () => {
    // The existing negative control's condition evaluates FALSE, so swapping
    // `ifTrue`/`ifFalse` in the mirror left it green: the unreadable import sat
    // in the arm that was skipped either way.
    useProducerOutputs(undefined);

    const err = await scrub(
      {
        MasterUserPassword: {
          'Fn::If': ['IsProd', { 'Fn::ImportValue': 'no-such-export' }, 'fallback'],
        },
        MasterUsername: 'admin',
      },
      { conditions: { IsProd: { 'Fn::Equals': ['a', 'a'] } } }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect(stateBackend.listStacks).toHaveBeenCalled();
  });

  it('a MALFORMED Fn::If cannot refuse — which branch is live is unknowable', async () => {
    // A two-element `Fn::If` used to fall through to the plain object walk, so
    // an unreadable import in what may be the UNTAKEN branch refused the whole
    // stack: exactly the hazard the selected-branch mirror exists to prevent.
    useProducerOutputs(undefined);

    const res = await scrub({
      MasterUserPassword: { 'Fn::If': ['IsProd', { 'Fn::ImportValue': 'no-such-export' }] },
      MasterUsername: SECRET_EXPR,
    });

    // The rest of the resource is still scrubbed...
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    // ...and the read was still ATTEMPTED for its needle, only disarmed.
    expect(stateBackend.listStacks).toHaveBeenCalled();
  });
});

describe('the refusal message is masked against what the pass recorded (issue #2133)', () => {
  it('a plaintext echoed by the resolver error never reaches the refusal message', async () => {
    // The import's ARGUMENT is a secret reference, so the resolver resolves it
    // to the PLAINTEXT (recording the needle), then reports
    // `export '<plaintext>' not found`. No earlier refusal fixture's error
    // carried a recorded plaintext at all, so this whole property was unfenced.
    //
    // TWO INDEPENDENT GUARDS hold it, and measuring that is the reason this
    // note exists: `unresolvableCrossStackReadError`'s own `maskSecretsInText`,
    // AND `maskSecretsInError` at `scrubStack`'s boundary — which can only see
    // this resource's needles because the map is registered BEFORE the throw
    // (the hoist the structural test below fences). Each alone suffices, so a
    // single-mutation probe of either is GREEN and says nothing; removing BOTH
    // reds this test, which is how it was verified. Do not read a green
    // single-guard probe here as "unfenced".
    useProducerOutputs(undefined);

    const err = await scrub({
      MasterUserPassword: { 'Fn::ImportValue': SECRET_EXPR },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    // POSITIVE: the message really did quote the resolver's cause (else "no
    // plaintext" is satisfied by a message that quotes nothing)...
    expect((err as Error).message).toContain('not found in any stack');
    expect((err as Error).message).toContain('***');
    // ...and the plaintext is not in it, nor anywhere the run logged.
    expect((err as Error).message).not.toContain(PLAINTEXT);
    expect(logLines.join('\n')).not.toContain(PLAINTEXT);
  });
});

describe('a state backend that THROWS refuses at every site (issue #2133)', () => {
  const accessDenied = (): Error => {
    const err = new Error('User is not authorized to perform: s3:ListBucket');
    err.name = 'AccessDenied';
    return err;
  };

  it('resource properties: listStacks rejecting refuses rather than degrading', async () => {
    // The fake backend only ever RESOLVED (to `null`) before, so a throwing
    // backend — an expired credential, a denied bucket — was untested at every
    // site, and the resolver's own per-stack catch makes it easy to swallow.
    stateBackend.listStacks.mockRejectedValue(accessDenied());

    const err = await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("resource 'Db'");
    expect((err as Error).message).toContain('s3:ListBucket');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('output VALUE: listStacks rejecting refuses', async () => {
    stateBackend.listStacks.mockRejectedValue(accessDenied());

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { outputs: { DbUrl: { Value: { 'Fn::ImportValue': EXPORT_NAME } } } }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("output 'DbUrl'");
  });

  it('intrinsic Export.Name: listStacks rejecting refuses', async () => {
    stateBackend.listStacks.mockRejectedValue(accessDenied());

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      {
        outputs: {
          DbUrl: { Value: 'public', Export: { Name: { 'Fn::ImportValue': EXPORT_NAME } } },
        },
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain("Export.Name of output 'DbUrl'");
  });

  it('Fn::GetStackOutput: getState rejecting refuses', async () => {
    stateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === PRODUCER) return Promise.reject(accessDenied());
      return Promise.resolve({ state: consumerState, etag: 'c-1' });
    });

    const err = await scrub({
      MasterUserPassword: {
        'Fn::GetStackOutput': { StackName: PRODUCER, OutputName: OUTPUT_NAME },
      },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain('s3:ListBucket');
  });
});

describe('a CROSS-REGION producer is read in ITS region (issues #2109 + #2133)', () => {
  it("the producer's secret is fetched from the producer's region, not the consumer's", async () => {
    // This PR is what makes `Fn::ImportValue` resolvable from scrub at all, so
    // #2109's region selection had ZERO coverage for this input — every earlier
    // fixture was same-region, and passing `undefined` for the producer region
    // to `reresolveCrossStackValue` left them all green.
    const PRODUCER_REGION = 'eu-west-1';
    stateBackend.listStacks.mockResolvedValue([{ stackName: PRODUCER, region: PRODUCER_REGION }]);
    stateBackend.getState.mockImplementation((stackName: string, stateRegion: string) => {
      if (stackName === PRODUCER && stateRegion === PRODUCER_REGION) {
        return Promise.resolve({
          state: makeProducerState({ [EXPORT_NAME]: SECRET_EXPR }),
          etag: 'p-1',
        });
      }
      if (stackName === PRODUCER) return Promise.resolve(null);
      return Promise.resolve({ state: consumerState, etag: 'c-1' });
    });

    await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: 'admin',
    });

    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, PRODUCER_REGION]);
    // THE marker: which region's client answered for the secret.
    expect(secretSends).toHaveLength(1);
    expect(secretSends[0]!.ctorRegion).toBe(PRODUCER_REGION);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });
});

describe('scrub supplies NO exports index (issue #2133)', () => {
  it('every resolve context carries a stateBackend and no exportIndex', async () => {
    // The index is a performance hint whose scan arm PATCHES it — an S3 write
    // from a command documented to perform no AWS mutation, `--dry-run`
    // included. Nothing red if a future edit supplied one, so read the context
    // the command actually builds.
    const contexts: Array<Record<string, unknown>> = [];
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(async function (
        this: IntrinsicFunctionResolver,
        value: unknown,
        ctx: unknown
      ) {
        contexts.push(ctx as Record<string, unknown>);
        return await original.call(this, value, ctx as never);
      } as never);
    try {
      await scrub({
        MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
        MasterUsername: 'admin',
      });
    } finally {
      spy.mockRestore();
    }

    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      expect(ctx['stateBackend']).toBeDefined();
      expect('exportIndex' in ctx).toBe(false);
    }
  });
});

describe('a RESOLVED but PLAINTEXT producer is refused, not reported clean (issue #2133)', () => {
  it('REFUSES when the producer publishes a secret but its own state still holds the plaintext', async () => {
    // The read SUCCEEDS, so the unresolvable-read refusal never fires; but a
    // needle is recorded only by resolving a `{{resolve:...}}` expression, so
    // nothing lands in `recordedSecretValues`, `totalSecrets` is 0, and the
    // command reported "No plaintext secrets found" over a record still holding
    // it — the same silent success the issue exists to kill, one step later.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    // ACTIONABLE: it names the producer and the remedy that actually works.
    expect((err as Error).message).toContain(PRODUCER);
    expect((err as Error).message).toContain(`cdkd scrub ${PRODUCER}`);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // ISSUE #2133 BLOCKER 1, end to end: the producer's stored PLAINTEXT was
    // read on this path, and the resolver's own `Resolved Fn::ImportValue` line
    // must not have printed it. It used to, at default verbosity.
    expect(logLines.some((l) => l.includes('Resolved Fn::ImportValue'))).toBe(true);
    expect(logLines.join('\n')).not.toContain(PLAINTEXT);
  });

  it('refuses in --dry-run too, which is where ordering cannot save it', async () => {
    // `--all` now scrubs producers first, so a REAL run resolves the expression
    // and never reaches this refusal. A dry run writes nothing, so the producer
    // is never rewritten and the consumer can never get a needle — the CI gate
    // would otherwise exit 0 on a stack the real run would scrub.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)], dryRun: true }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
  });

  it('Fn::GetStackOutput has the same polarity', async () => {
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(
        stackName === PRODUCER
          ? { state: makeProducerState({ [OUTPUT_NAME]: PLAINTEXT }), etag: 'p-1' }
          : { state: consumerState, etag: 'c-1' }
      )
    );

    const err = await scrub(
      {
        MasterUserPassword: {
          'Fn::GetStackOutput': { StackName: PRODUCER, OutputName: OUTPUT_NAME },
        },
        MasterUsername: 'admin',
      },
      { appStacks: [makeProducerStackInfo({ [OUTPUT_NAME]: { Value: SECRET_EXPR } })] }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain(OUTPUT_NAME);
  });

  it('NEGATIVE CONTROL: an ORDINARY import resolving to a plain string does not refuse', async () => {
    // Without the producer-template discriminator this refusal would fire on
    // every multi-stack app: a bucket name and a leaked password are both bare
    // strings from the consumer's side.
    useProducerOutputs({ [EXPORT_NAME]: 'my-bucket-name' });

    const res = await scrub(
      {
        MasterUserPassword: SECRET_EXPR,
        MasterUsername: 'admin',
        DBSubnetGroupName: { 'Fn::ImportValue': EXPORT_NAME },
      },
      { appStacks: [makeProducerStackInfo(PUBLIC_PRODUCER_OUTPUTS)] }
    );

    expect(res.recordsChanged).toBe(1);
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    expect(savedState().resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
  });

  it('NEGATIVE CONTROL: a producer OUTSIDE this app cannot be classified, so it does not refuse', async () => {
    // Documented residual: with no producer template in hand there is no way to
    // tell a stored secret from a stored bucket name, and refusing on the guess
    // would make scrub unusable against any app whose producer lives elsewhere.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const res = await scrub({
      MasterUserPassword: SECRET_EXPR,
      MasterUsername: 'admin',
      DBSubnetGroupName: { 'Fn::ImportValue': EXPORT_NAME },
    });

    expect(res.recordsChanged).toBe(1);
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
  });
});

describe('THE EMPTY CELL: a secret-publishing producer whose state holds the EXPRESSION (issue #2133)', () => {
  // WHY THIS BLOCK EXISTS. Across the rest of this file the two signals that
  // reach the plaintext-producer refusal are perfectly CORRELATED: every
  // healthy case stores the EXPRESSION but passes NO `appStacks` (so
  // `producerTemplates` is empty and the `if (!producerTemplate) return;`
  // above the guard short-circuits it), and every refusal case stores the
  // PLAINTEXT and DOES pass `appStacks`. The cell "producer state holds the
  // expression AND `appStacks` is supplied" was therefore never occupied by
  // any test — and that cell is what EVERY real CLI invocation is, because
  // `scrubCommand` always passes `appStacks: allStacks`.
  //
  // An earlier revision discriminated on the producer's TEMPLATE
  // (`producerPublishesSecretExpression`), which is true in BOTH cases, so it
  // refused this cell too — i.e. every consumer of a secret-bearing export,
  // the entire population the issue exists to serve. All 39 tests here stayed
  // green; a real-AWS run failed with `exited 2 (expected 0)` one log line
  // under the resolver's own `redacted dynamic reference` note.
  it('does NOT refuse, and rewrites the consumer leaf, when the producer state holds the expression AND appStacks is supplied', async () => {
    // The healthy producer: its state carries the `{{resolve:...}}` EXPRESSION
    // (what issue #1934 persists), and its TEMPLATE publishes that expression —
    // so `producerPublishesSecretExpression` returns TRUE here exactly as it
    // does in the refusal case. Only the recorded needle tells the two apart.
    useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });

    const res = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    );

    // POSITIVE MARKERS, not "it did not throw" — an early return anywhere above
    // the guard satisfies that, which is how the correlated matrix stayed green.
    // `MasterUsername`'s template side is the public literal `admin`, so no
    // position pass can reach it: this leaf changes ONLY if the cross-stack read
    // resolved the producer's expression and recorded the needle.
    const saved = savedState();
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(res.recordsChanged).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
  });

  it('the SECOND reference to the same export is saved by the needle already on hand, not by a new one', async () => {
    // The `secrets.has(resolved)` arm of the discriminator. The needle map is
    // keyed by the RESOLVED VALUE (`recordedSecretValues.set(resolved,
    // fullMatch)`), so re-recording the same export's plaintext overwrites the
    // same key and `secrets.size` does NOT grow — the `size > needlesBefore`
    // clause is FALSE for every reference after the first. Both leaves here are
    // the same export, so the second one refuses the whole stack unless the
    // `has` arm catches it.
    useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
        MasterUsername: { 'Fn::ImportValue': EXPORT_NAME },
      },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    );

    const saved = savedState();
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(res.recordsChanged).toBe(1);
  });
});

describe('a read cdkd DECLINES BY DESIGN is a finding, not a stack refusal (issue #2133 review)', () => {
  it('scrubs the rest of the stack and reports the read as unverifiable', async () => {
    // The subject here is how the pre-pass CLASSIFIES the error, not how the
    // resolver produces it: the real producer is `resolveGetStackOutput`'s
    // cross-account arm, which needs an assumed role and a second state bucket.
    // So the error is injected at the resolver boundary and everything else runs
    // for real.
    //
    // Refusing the whole stack over it — which the first cut did, converting it
    // into `SCRUB_CROSS_STACK_READ_UNRESOLVED` with the remedy "deploy the
    // producer stack", which cannot fix a cross-account refusal — stranded every
    // OTHER secret in the stack permanently, with no bypass flag.
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(async function (
        this: IntrinsicFunctionResolver,
        value: unknown,
        ctx: unknown
      ) {
        const node = value as Record<string, unknown>;
        if (
          node &&
          typeof node === 'object' &&
          Object.keys(node).length === 1 &&
          'Fn::GetStackOutput' in node
        ) {
          // The SUBCLASS, which is what `resolveGetStackOutput`'s cross-account
          // arm really throws. The base class is NOT interchangeable here — see
          // the sibling describe below, where a base-class refusal must REFUSE.
          throw new CrossAccountSecretRefusalError(
            "Fn::GetStackOutput: output 'DbSecret' of stack 'Producer' is a redacted dynamic " +
              'reference, and this is a CROSS-ACCOUNT reference'
          );
        }
        return await original.call(this, value, ctx as never);
      } as never);

    let res;
    try {
      res = await scrub({
        MasterUsername: SECRET_EXPR,
        MasterUserPassword: {
          'Fn::GetStackOutput': {
            StackName: PRODUCER,
            OutputName: OUTPUT_NAME,
            RoleArn: 'arn:aws:iam::999999999999:role/Reader',
          },
        },
      });
    } finally {
      spy.mockRestore();
    }

    // NOT a refusal — the stack was still scrubbed for its other secret...
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    // ...and the read is REPORTED, so no summary can call this stack clean.
    expect(res.unverifiableReads).toBe(1);
    expect(logLines.some((l) => l.startsWith('warn') && l.includes('cannot verify'))).toBe(true);
  });

  it('NEGATIVE CONTROL: an ordinary error at the same site still refuses', async () => {
    // Otherwise "treat a refusal as a finding" could quietly become "treat every
    // failure as a finding", which is the silent success this issue is about.
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(stackName === PRODUCER ? null : { state: consumerState, etag: 'c-1' })
    );

    const err = await scrub({
      MasterUserPassword: {
        'Fn::GetStackOutput': { StackName: PRODUCER, OutputName: OUTPUT_NAME },
      },
      MasterUsername: 'admin',
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
  });
});

describe('only the PERMANENT refusal is a finding — a user-fixable one refuses (issue #2133 review)', () => {
  /**
   * Install a resolver that throws `err` for the cross-stack node and runs the
   * real resolver for everything else. The shape the sibling describe uses; the
   * only variable here is WHICH error class arrives at the pre-pass.
   */
  const withInjectedRefusal = async (
    err: Error,
    run: () => Promise<unknown>
  ): Promise<unknown> => {
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(async function (
        this: IntrinsicFunctionResolver,
        value: unknown,
        ctx: unknown
      ) {
        const node = value as Record<string, unknown>;
        if (
          node &&
          typeof node === 'object' &&
          Object.keys(node).length === 1 &&
          'Fn::ImportValue' in node
        ) {
          throw err;
        }
        return await original.call(this, value, ctx as never);
      } as never);
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  };

  const IMPORT_THROUGH_SUB = {
    // The security reviewer's scenario, verbatim: the export NAME is built by an
    // `Fn::Sub` whose variable is an `Fn::GetAtt`, so a `rejectPlaceholderArnAttribute`
    // / fabricated-account / `--strict-getatt` refusal is re-raised by
    // `resolveSub` and reaches the pre-pass as an `IntrinsicResolutionRefusalError`.
    MasterUserPassword: {
      'Fn::ImportValue': {
        'Fn::Sub': ['${P}-DbSecret', { P: { 'Fn::GetAtt': ['Legacy', 'Arn'] } }],
      },
    },
    MasterUsername: 'admin',
  };

  /**
   * The same bag with a SECOND, independently scrubbable secret — used by the
   * finding cases, whose point is that the rest of the stack is still scrubbed.
   *
   * `MasterUsername` comes FIRST deliberately: `resolveValue` walks a plain
   * object's entries SEQUENTIALLY and `await`s each, so the unresolvable import
   * aborts the bag and anything after it never records a needle.
   */
  const SECRET_BESIDE_IMPORT_THROUGH_SUB = {
    MasterUsername: SECRET_EXPR,
    MasterUserPassword: IMPORT_THROUGH_SUB.MasterUserPassword,
  };

  it('a USER-FIXABLE IntrinsicResolutionRefusalError REFUSES the stack, it is not downgraded to a finding', async () => {
    // BLOCKER: `isByDesignRefusal` matched the whole class, so this refusal was
    // recorded as "cdkd declines this read by design, so no re-run can change
    // it" — false for all five user-fixable sites — and scrub then printed
    // `No plaintext secrets found in Consumer` and exited 0 without `--fail`
    // while the consumer's state.json still held the imported plaintext.
    const err = (await withInjectedRefusal(
      new IntrinsicResolutionRefusalError(
        "Fn::GetAtt: refusing to build a value from the placeholder ARN of 'Legacy'"
      ),
      () => scrub(IMPORT_THROUGH_SUB).catch((e: unknown) => e)
    )) as { code?: string; exitCode?: number; message?: string };

    // POSITIVE MARKER: the stack-level refusal with its own code, not merely
    // "something threw" — and the resolver's message is carried through, so the
    // user is told the actual, fixable cause.
    expect(err.code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('placeholder ARN');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // ...and the false "no re-run can change it" claim is NOT made about it.
    expect(logLines.join('\n')).not.toContain('cannot verify');
  });

  it('the PERMANENT refusal is still a finding at the same site — the two are told apart by CLASS', async () => {
    // The twin of the case above with only the error class changed, so a
    // predicate that stopped discriminating fails one of the two.
    const res = (await withInjectedRefusal(
      new CrossAccountSecretRefusalError(
        "Fn::GetStackOutput: output 'DbSecret' of stack 'Producer' is a redacted dynamic " +
          'reference, and this is a CROSS-ACCOUNT reference'
      ),
      () => scrub(SECRET_BESIDE_IMPORT_THROUGH_SUB)
    )) as { unverifiableReads: number; recordsChanged: number };

    expect(res.unverifiableReads).toBe(1);
    expect(res.recordsChanged).toBe(1);
    expect(logLines.some((l) => l.startsWith('warn') && l.includes('cannot verify'))).toBe(true);
  });

  it('the permanent refusal is recognised through a CAUSE CHAIN, not only as the top link', async () => {
    // `resolver.resolve` wraps in several places, so a top-link-only
    // `instanceof` reclassifies a wrapped permanent refusal as user-fixable and
    // refuses the whole stack over something no user can fix.
    const wrapped = new Error('Failed to resolve resource properties', {
      cause: new CrossAccountSecretRefusalError(
        "Fn::GetStackOutput: output 'DbSecret' of stack 'Producer' is a redacted dynamic reference"
      ),
    });

    const res = (await withInjectedRefusal(wrapped, () =>
      scrub(SECRET_BESIDE_IMPORT_THROUGH_SUB)
    )) as { unverifiableReads: number; recordsChanged: number };

    expect(res.unverifiableReads).toBe(1);
    expect(res.recordsChanged).toBe(1);
  });

  it('a position that CANNOT refuse does not record a finding either', async () => {
    // The by-design branch used to run BEFORE the `!nodeCanRefuse` check, so a
    // condition-suppressed output turned a declined read into a PERMANENT
    // exit-1 finding — over a read the deploy never made, for an output that
    // wrote no `state.outputs` key. That is precisely what `isOutputSuppressed`
    // exists to spare it.
    useProducerOutputs(undefined);

    const res = (await withInjectedRefusal(
      new CrossAccountSecretRefusalError(
        "Fn::GetStackOutput: output 'DbSecret' of stack 'Producer' is a redacted dynamic reference"
      ),
      () =>
        scrub(
          { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
          {
            conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
            outputs: {
              DbUrl: { Condition: 'IsProd', Value: { 'Fn::ImportValue': 'ProdOnlyExport' } },
            },
          }
        )
    )) as { unverifiableReads: number; recordsChanged: number };

    expect(res.unverifiableReads).toBe(0);
    // POSITIVE MARKERS: the read WAS attempted and declined at that position
    // (else zero findings is satisfied by never reaching it), and the rest of
    // the stack was still scrubbed.
    expect(
      logLines.some((l) => l.startsWith('debug') && l.includes('this position cannot refuse'))
    ).toBe(true);
    expect(res.recordsChanged).toBe(1);
    expect(logLines.join('\n')).not.toContain('cannot verify');
  });

  it("the resolver's cross-account arm really constructs the SUBCLASS", () => {
    // Every case above INJECTS the error, so none of them proves that the one
    // permanent site still throws the class the pre-pass matches. Fold it back
    // to the base class and scrub refuses the whole stack over a refusal no
    // user can fix — the reachability regression the finding treatment exists
    // to prevent — while every injected test stays green.
    //
    // Source-read, the technique `intrinsic-refusal-non-retryable.test.ts` uses
    // for the same reason: the real path needs an assumed role and a second
    // state bucket.
    const source = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../src/deployment/intrinsic-function-resolver.ts',
          import.meta.url
        )
      ),
      'utf8'
    );
    const arm = source.slice(source.indexOf('is a ' + 'CROSS-ACCOUNT reference (RoleArn'));
    expect(arm).not.toBe('');
    // The construction is the ~4 lines ABOVE the message, so search backwards
    // from it rather than forwards.
    const upTo = source.slice(0, source.indexOf('is a ' + 'CROSS-ACCOUNT reference (RoleArn'));
    const lastConstruction = upTo.lastIndexOf('RefusalError(');
    expect(upTo.slice(lastConstruction - 40, lastConstruction + 13)).toContain(
      'new CrossAccountSecretRefusalError('
    );
  });

  it('the by-design FINDING is masked against what the pass recorded', async () => {
    // The `detail` string goes into BOTH a `findings.unverifiable` entry and a
    // default-verbosity `logger.warn`, so it is a disclosure path. Every earlier
    // fixture injected a refusal whose message carried no plaintext at all, so
    // the mask was satisfied by having nothing to mask.
    //
    // Here the ARGUMENT is a secret reference: the real resolver resolves it,
    // records `PLAINTEXT -> SECRET_EXPR` into this resource's map, and only THEN
    // is the refusal injected — carrying that plaintext in its message, exactly
    // as an AWS error quoting the offending value would.
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(async function (
        this: IntrinsicFunctionResolver,
        value: unknown,
        ctx: unknown
      ) {
        const node = value as Record<string, unknown>;
        if (
          node &&
          typeof node === 'object' &&
          Object.keys(node).length === 1 &&
          'Fn::ImportValue' in node
        ) {
          // Let the REAL resolver record the needle from the argument first; it
          // then fails to find the export, which is not what we are testing.
          await original.call(this, value, ctx as never).catch(() => undefined);
          throw new CrossAccountSecretRefusalError(
            `Fn::GetStackOutput: cross-account read of '${PLAINTEXT}' declined`
          );
        }
        return await original.call(this, value, ctx as never);
      } as never);

    let res;
    try {
      res = await scrub({
        MasterUserPassword: { 'Fn::ImportValue': SECRET_EXPR },
        MasterUsername: 'admin',
      });
    } finally {
      spy.mockRestore();
    }

    expect(res.unverifiableReads).toBe(1);
    const warnLine = logLines.find((l) => l.startsWith('warn') && l.includes('cannot verify'));
    // POSITIVE: the warning really did quote the refusal's message (else "no
    // plaintext" is satisfied by a line that quotes nothing)...
    expect(warnLine).toContain('cross-account read of');
    expect(warnLine).toContain('***');
    // ...and the plaintext reaches neither that line nor anywhere else.
    expect(logLines.join('\n')).not.toContain(PLAINTEXT);
  });
});

describe('THE DISCRIMINATOR reads the PRODUCER STATE, not the needle count (issue #2133 review)', () => {
  // The four shapes the needle-count predicate got wrong. Each of these reds
  // under it: the first three by REFUSING a healthy producer, the last by
  // reporting a broken one clean.
  //
  // The needle map is keyed by the RESOLVED SECRET SUBSTRING and the guard
  // tested `secrets.has(resolved)` — the whole leaf — so it agreed with the map
  // only for the degenerate case where the export IS the bare secret.

  it('a COMPOSITE export (a URI embedding the secret) does not refuse on the SECOND reference', async () => {
    // `secretValueFromJson` / `Fn::Join` produce exactly this: the producer
    // publishes `postgres://u:{{resolve:...}}@h`, so the needle is the embedded
    // PASSWORD while `resolved` is the whole URI. The first reference grows the
    // map; the second re-records the same key so `size` does not grow, and
    // `has(<whole URI>)` is false — the old predicate refused a producer whose
    // state holds the expression and told the user to scrub something clean.
    const COMPOSITE_EXPR = `postgres://admin:${SECRET_EXPR}@db.example.com:5432/app`;
    const COMPOSITE_PLAINTEXT = `postgres://admin:${PLAINTEXT}@db.example.com:5432/app`;
    consumerState = makeConsumerState({
      MasterUserPassword: COMPOSITE_PLAINTEXT,
      MasterUsername: PLAINTEXT,
    });
    useProducerOutputs({ [EXPORT_NAME]: COMPOSITE_EXPR });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
        MasterUsername: { 'Fn::ImportValue': EXPORT_NAME },
      },
      {
        appStacks: [
          makeProducerStackInfo({
            [OUTPUT_NAME]: { Value: COMPOSITE_EXPR, Export: { Name: EXPORT_NAME } },
          }),
        ],
      }
    );

    // POSITIVE MARKERS: the needle really was recorded and really did rewrite
    // the embedded plaintext. `MasterUsername`'s stored value is the bare
    // password, reachable only by the substring needle.
    const saved = savedState();
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
    expect(res.recordsChanged).toBe(1);
  });

  it('a NON-STRING resolved value does not refuse on the SECOND reference', async () => {
    // `reresolveCrossStackValue` walks arrays and objects, so a list-valued
    // export comes back as an array. `typeof resolved === 'string'` is false, so
    // the `has` arm could not even be consulted and the second reference refused.
    useProducerOutputs({ [EXPORT_NAME]: [SECRET_EXPR] });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
        MasterUsername: { 'Fn::ImportValue': EXPORT_NAME },
      },
      {
        appStacks: [
          makeProducerStackInfo({
            [OUTPUT_NAME]: { Value: [SECRET_EXPR], Export: { Name: EXPORT_NAME } },
          }),
        ],
      }
    );

    const saved = savedState();
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(res.recordsChanged).toBe(1);
  });

  it('a needle recorded by the reference ARGUMENT does not suppress a real refusal', async () => {
    // The FALSE-CLEAN direction. `resolveImportValue` resolves its argument
    // first, so an export name assembled from a `{{resolve:...}}` records a
    // needle of its own — which satisfied `secrets.size > needlesBefore` and
    // made the pass conclude the PRODUCER had published an expression. It had
    // not: its state holds a bare plaintext, and the consumer was reported clean.
    const ARG_EXPORT_NAME = `${PLAINTEXT}-Export`;
    useProducerOutputs({ [ARG_EXPORT_NAME]: 'producer-still-holds-this-plaintext' });

    const err = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': { 'Fn::Join': ['', [SECRET_EXPR, '-Export']] } },
        MasterUsername: 'admin',
      },
      {
        appStacks: [
          makeProducerStackInfo({
            [OUTPUT_NAME]: { Value: SECRET_EXPR, Export: { Name: ARG_EXPORT_NAME } },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('an UNRESOLVABLE producer expression (ssm-secure) does not refuse — the stored value still carries it', async () => {
    // cdkd resolves `ssm-secure` for nobody (CloudFormation resolves it
    // server-side), so the read returns the expression untouched and NO needle
    // is ever recorded for this population. The old code was saved by an early
    // `carriesDynamicReference(resolved)` return that no test fenced; the direct
    // read subsumes it, since a resolved value can only carry an expression when
    // the STORED one did.
    const SSM_SECURE_EXPR = '{{resolve:ssm-secure:/prod/db/password:1}}';
    useProducerOutputs({ [EXPORT_NAME]: SSM_SECURE_EXPR });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          makeProducerStackInfo({
            [OUTPUT_NAME]: { Value: SSM_SECURE_EXPR, Export: { Name: EXPORT_NAME } },
          }),
        ],
      }
    );

    // POSITIVE MARKER: the stack was scrubbed for its OWN secret, so the run
    // really did reach the rewrite rather than merely not throwing.
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('a CROSS-REGION producer is classified from ITS region, with appStacks supplied', async () => {
    // The direct read takes the producer's region off the recorded entry. Read
    // in the CONSUMER's region the record is absent, which classifies as
    // "cannot tell" and silently stops refusing — so this pins the region the
    // classification read uses, in the cell (`appStacks` supplied) every real
    // CLI invocation occupies and the pre-existing cross-region test does not.
    const PRODUCER_REGION = 'eu-west-1';
    stateBackend.listStacks.mockResolvedValue([{ stackName: PRODUCER, region: PRODUCER_REGION }]);
    stateBackend.getState.mockImplementation((stackName: string, stateRegion: string) => {
      if (stackName === PRODUCER && stateRegion === PRODUCER_REGION) {
        return Promise.resolve({
          state: makeProducerState({ [EXPORT_NAME]: SECRET_EXPR }),
          etag: 'p-1',
        });
      }
      if (stackName === PRODUCER) return Promise.resolve(null);
      return Promise.resolve({ state: consumerState, etag: 'c-1' });
    });

    const res = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    );

    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, PRODUCER_REGION]);
    expect(secretSends[0]!.ctorRegion).toBe(PRODUCER_REGION);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(res.recordsChanged).toBe(1);
  });

  it('names the OUTER read, not one its ARGUMENT performed', async () => {
    // `resolveImportValue` / `resolveGetStackOutput` resolve their ARGUMENTS
    // before recording their own read, so a cross-stack read nested inside the
    // argument is recorded FIRST — and lands in the OTHER family's bag. Reading
    // `recordedImports?.[0]` first classified this `Fn::GetStackOutput` against
    // the DIRECTORY stack its `StackName` was imported from, whose template
    // publishes nothing secret, and the unscrubbed producer went unreported.
    const DIRECTORY = 'Directory';
    stateBackend.listStacks.mockResolvedValue([
      { stackName: DIRECTORY, region: REGION },
      { stackName: PRODUCER, region: REGION },
    ]);
    stateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === DIRECTORY) {
        return Promise.resolve({
          state: {
            version: 8,
            region: REGION,
            stackName: DIRECTORY,
            resources: {},
            outputs: { ProducerNameExport: PRODUCER },
            lastModified: 0,
          },
          etag: 'd-1',
        });
      }
      if (stackName === PRODUCER) {
        return Promise.resolve({
          state: makeProducerState({ [OUTPUT_NAME]: PLAINTEXT }),
          etag: 'p-1',
        });
      }
      return Promise.resolve({ state: consumerState, etag: 'c-1' });
    });

    const err = await scrub(
      {
        MasterUserPassword: {
          'Fn::GetStackOutput': {
            StackName: { 'Fn::ImportValue': 'ProducerNameExport' },
            OutputName: OUTPUT_NAME,
          },
        },
        MasterUsername: 'admin',
      },
      {
        appStacks: [
          {
            stackName: DIRECTORY,
            dependencyNames: [],
            template: {
              Resources: {},
              // Ordinary, non-secret — which is why the inner producer cleared
              // the check and suppressed the refusal.
              Outputs: {
                ProducerName: { Value: { Ref: 'Thing' }, Export: { Name: 'ProducerNameExport' } },
              },
            },
          },
          makeProducerStackInfo({ [OUTPUT_NAME]: { Value: SECRET_EXPR } }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    // POSITIVE: it names the OUTER producer and the OUTER key.
    expect((err as Error).message).toContain(`producer stack '${PRODUCER}'`);
    expect((err as Error).message).toContain(OUTPUT_NAME);
  });

  it('a CloudFormation-sourced export records no producer, so it is never classified', async () => {
    // `resolveImportValue`'s `ListExports` fallback deliberately records
    // nothing — a CFn-managed producer is a weak reference whose value cdkd
    // never redacted — so there is no producer to read and nothing to refuse.
    // The fake CFn client threw for every command in every other test, so this
    // arm had never once executed.
    useProducerOutputs({ SomeOtherExport: 'unrelated' });
    secretResponses.set('cloudformation|ListExportsCommand', {
      Exports: [{ Name: EXPORT_NAME, Value: 'value-cfn-holds', ExportingStackId: 'arn:cfn:stack' }],
    });

    const res = await scrub(
      {
        MasterUserPassword: SECRET_EXPR,
        MasterUsername: 'admin',
        DBSubnetGroupName: { 'Fn::ImportValue': EXPORT_NAME },
      },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    );

    // POSITIVE MARKERS: the fallback really ran, and the stack was still
    // scrubbed for its own secret.
    expect(cfnSends.map((s) => s.command)).toContain('ListExportsCommand');
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
  });
});

describe('the refusal message never over-claims what the template says (issue #2133 review)', () => {
  it('names the KEY when an output matched it', async () => {
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    ).catch((e: unknown) => e);

    expect((err as Error).message).toContain(`declares '${EXPORT_NAME}' from a {{resolve:...}}`);
  });

  it('says so instead when the verdict came from the WIDENED scan', async () => {
    // The producer's `Export.Name` is an INTRINSIC, which scrub cannot
    // reproduce, so no output matches the key the read returned and the test
    // widens to every output. That over-approximates in the safe direction —
    // but the message asserted the producer "declares '<key>' from a
    // {{resolve:...}} expression", which the code never checked for this key.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      {
        appStacks: [
          makeProducerStackInfo({
            [OUTPUT_NAME]: {
              Value: SECRET_EXPR,
              Export: { Name: { 'Fn::Sub': '${AWS::StackName}-DbSecret' } },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    // POSITIVE MARKERS: it still refuses (the widening is what makes it fire at
    // all) AND it does not claim the unchecked thing.
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain('could not match');
    expect((err as Error).message).not.toContain(`declares '${EXPORT_NAME}'`);
  });
});

describe('the plaintext-producer refusal respects POSITION (issue #2133 review)', () => {
  it('refuses from an OUTPUT VALUE, not only from a resource property', async () => {
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      {
        outputs: { DbUrl: { Value: { 'Fn::ImportValue': EXPORT_NAME } } },
        appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain("output 'DbUrl'");
  });

  it('does NOT refuse from an output value when the producer state holds the expression', async () => {
    // The same position, other polarity — so a mutation that made the output
    // path unconditionally refuse (or unconditionally pass) fails one of the two.
    useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });
    consumerState = makeConsumerState(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { DbUrl: PLAINTEXT }
    );

    await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      {
        outputs: { DbUrl: { Value: { 'Fn::ImportValue': EXPORT_NAME } } },
        appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)],
      }
    );

    expect(savedState().outputs['DbUrl']).toBe(SECRET_EXPR);
  });

  it('a CONDITION-SUPPRESSED output cannot raise the plaintext-producer refusal either', async () => {
    // The `!nodeCanRefuse` arm of THIS refusal (its twin on the unresolvable-read
    // refusal was already fenced). A prod-only output importing from a producer
    // whose state is still unscrubbed would otherwise refuse the whole stack
    // over a read the deploy never made — and it wrote no `state.outputs` key,
    // so there is nothing at risk behind it.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const res = await scrub(
      { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
      {
        conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
        outputs: {
          DbUrl: { Condition: 'IsProd', Value: { 'Fn::ImportValue': EXPORT_NAME } },
        },
        appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
  });

  it('STATE overrules the condition: an output the deploy DID write can still refuse', async () => {
    // `conditions` is evaluated from TEMPLATE PARAMETER DEFAULTS (scrub takes no
    // `--parameters`) and degrades to `{}` when evaluation throws, so a stack
    // deployed with non-default parameters read as suppressed and the refusal
    // was silently disarmed. `state.outputs` is the record of what was actually
    // written, and it carries this key.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });
    consumerState = makeConsumerState(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      { DbUrl: PLAINTEXT }
    );

    const err = await scrub(
      { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' },
      {
        conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
        outputs: {
          DbUrl: { Condition: 'IsProd', Value: { 'Fn::ImportValue': EXPORT_NAME } },
        },
        appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
  });
});

describe('a CONDITION-SUPPRESSED output cannot refuse the stack (issue #2133 review)', () => {
  it('a prod-only output importing a prod-only export does not refuse in dev', async () => {
    useProducerOutputs(undefined);

    const res = await scrub(
      { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
      {
        conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
        outputs: {
          DbUrl: { Condition: 'IsProd', Value: { 'Fn::ImportValue': 'ProdOnlyExport' } },
        },
      }
    );

    expect(res.recordsChanged).toBe(1);
    // Still RESOLVED for its needles — only the refusal is disarmed, which is
    // the half the existing "ignore Condition" rationale actually argues for.
    expect(stateBackend.listStacks).toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the same output WITHOUT a Condition still refuses', async () => {
    useProducerOutputs(undefined);

    const err = await scrub(
      { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
      { outputs: { DbUrl: { Value: { 'Fn::ImportValue': 'ProdOnlyExport' } } } }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
  });
});

describe('scrub --all orders producers before consumers (issue #2133 review)', () => {
  const stackOf = (
    stackName: string,
    extra?: { dependencyNames?: string[]; template?: unknown }
  ): { stackName: string; dependencyNames: string[]; template: CloudFormationTemplate } => ({
    stackName,
    dependencyNames: extra?.dependencyNames ?? [],
    template: (extra?.template ?? { Resources: {} }) as CloudFormationTemplate,
  });

  it("reorders on CDK's own manifest dependency", () => {
    const ordered = orderScrubTargets([
      stackOf(CONSUMER, { dependencyNames: [PRODUCER] }),
      stackOf(PRODUCER),
    ]);
    expect(ordered.map((s) => s.stackName)).toEqual([PRODUCER, CONSUMER]);
  });

  it('reorders on a RAW Fn::ImportValue, for which CDK emits no manifest dependency', () => {
    const ordered = orderScrubTargets([
      stackOf(CONSUMER, {
        template: {
          Resources: {
            Db: {
              Type: 'AWS::RDS::DBInstance',
              Properties: { P: { 'Fn::ImportValue': EXPORT_NAME } },
            },
          },
        },
      }),
      stackOf(PRODUCER, {
        template: { Resources: {}, Outputs: { O: { Value: 'v', Export: { Name: EXPORT_NAME } } } },
      }),
    ]);
    expect(ordered.map((s) => s.stackName)).toEqual([PRODUCER, CONSUMER]);
  });

  it('a CYCLE neither hangs nor drops a stack', () => {
    const ordered = orderScrubTargets([
      stackOf('A', { dependencyNames: ['B'] }),
      stackOf('B', { dependencyNames: ['A'] }),
    ]);
    expect(ordered.map((s) => s.stackName).sort()).toEqual(['A', 'B']);
  });

  it('leaves an independent set in INPUT order, so an app with no imports is unaffected', () => {
    const ordered = orderScrubTargets([stackOf('Z'), stackOf('Y'), stackOf('X')]);
    expect(ordered.map((s) => s.stackName)).toEqual(['Z', 'Y', 'X']);
  });
});

describe("a resource's secret map is registered BEFORE anything can throw (issue #2133 review)", () => {
  it('scrubStack registers perResourceSecrets above the cross-region pin', () => {
    // STRUCTURAL, and deliberately so. The window is between
    // `pinCrossRegionSecrets` recording a foreign plaintext and the map
    // becoming visible to `maskSecretsInError` at the function boundary. That
    // ordering DOES have a behavioural signature — it is the second of the two
    // guards the masking test above measures — but only in conjunction with the
    // per-site mask, so no single-mutation probe can isolate it. This test
    // isolates it, and the conjunction is recorded on the other one.
    //
    // What the ordering buys beyond that per-site mask is the OBJECT rendering:
    // `formatError`'s `Caused by:` and the top-level `console.error`'s
    // `util.inspect` walk the whole cause chain and every link's `stack`, which
    // a per-site mask provably cannot reach.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = readFileSync(`${here}../../../../src/cli/commands/scrub.ts`, 'utf8');
    const body = src.slice(src.indexOf('for (const logicalId of Object.keys(state.resources))'));
    const register = body.indexOf('perResourceSecrets.set(logicalId, recordedSecretValues)');
    const pin = body.indexOf('await pinCrossRegionSecrets(');
    expect(register).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(-1);
    expect(register).toBeLessThan(pin);
  });
});

describe('the producer state is read ONCE per scrub (issue #2133 review)', () => {
  it('two references to the same export cost one listStacks and one getState', async () => {
    // `resolveImportValue` has no lookup cache, and scrub resolves every
    // cross-stack reference twice (pre-pass, then main resolution). Without the
    // memoizing backend view a template with k imports paid 2k full scans; this
    // is the positive marker for the view actually being the one wired into the
    // resolver context.
    await scrub({
      MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME },
      MasterUsername: { 'Fn::ImportValue': EXPORT_NAME },
    });

    expect(stateBackend.listStacks).toHaveBeenCalledTimes(1);
    expect(
      stateBackend.getState.mock.calls.filter((c: unknown[]) => c[0] === PRODUCER)
    ).toHaveLength(1);
    // ...while the SECRET is still fetched (the read cache must not become a
    // resolve cache, or the second reference would record no needle).
    expect(secretSends.length).toBeGreaterThan(0);
  });
});

describe('a CONDITION that imports a secret does not print it (issue #2133 review)', () => {
  /**
   * The disclosure this fences. `resolveEquals` rendered BOTH resolved operands
   * unmasked, and that line was unreachable from `cdkd scrub` until this issue
   * gave the CONDITION context a `stateBackend`: an `Fn::ImportValue` inside a
   * condition used to throw for want of one. Now it resolves the producer's
   * export, `reresolveCrossStackValue` hands back the PLAINTEXT, and
   * `cdkd scrub --dry-run --verbose` printed it into a CI log — inside the
   * command whose whole purpose is removing that plaintext from state.
   *
   * The resource properties here are deliberately secret-free, so the CONDITION
   * is the ONLY thing in the run that can reach a producer or a secret. That is
   * what makes the producer `getState` and the `GetSecretValue` send positive
   * markers for the condition pass specifically, rather than for the resource
   * pass beside it.
   */
  const CONDITIONS = {
    ImportedIsProd: { 'Fn::Equals': [{ 'Fn::ImportValue': EXPORT_NAME }, 'x'] },
  };
  const PUBLIC_PROPS = { MasterUserPassword: 'not-a-secret', MasterUsername: 'admin' };
  /** What the masked line must read once both operands have been rendered. */
  const MASKED_EQUALS = 'Resolved Fn::Equals: "***" === "x" -> false';

  beforeEach(() => {
    consumerState = makeConsumerState(PUBLIC_PROPS);
    useProducerOutputs({ [EXPORT_NAME]: SECRET_EXPR });
  });

  it('--dry-run: Fn::Equals over an imported secret logs the MASK, not the plaintext', async () => {
    await scrub(PUBLIC_PROPS, { conditions: CONDITIONS, dryRun: true });

    // POSITIVE MARKERS FIRST — absence of the plaintext is a confluence point
    // that a run which never evaluated the condition satisfies just as well.
    // 1. The condition pass really performed the cross-stack read...
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    // 2. ...and really re-resolved the export's expression, which is the step
    //    that PRODUCES the plaintext (and records the needle to mask against).
    expect(secretSends.map((s) => s.command)).toEqual(['GetSecretValueCommand']);
    // 3. ...and `resolveEquals` really ran and rendered its operands.
    const equalsLines = logLines.filter((l) => l.includes('Resolved Fn::Equals:'));
    expect(equalsLines).toHaveLength(1);
    // 4. THE assertion: the operand it rendered is the MASK. The right-hand
    //    literal survives untouched, which is what tells a masked line apart
    //    from one that simply never carried the value.
    expect(equalsLines[0]).toContain(MASKED_EQUALS);

    // ...and nothing anywhere else in the run leaked it either.
    expect(logLines.join('\n')).not.toContain(PLAINTEXT);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('the same holds on an ordinary (non-dry-run) scrub', async () => {
    await scrub(PUBLIC_PROPS, { conditions: CONDITIONS });

    const equalsLines = logLines.filter((l) => l.includes('Resolved Fn::Equals:'));
    expect(equalsLines).toHaveLength(1);
    expect(equalsLines[0]).toContain(MASKED_EQUALS);
    expect(logLines.join('\n')).not.toContain(PLAINTEXT);
  });

  it('the needle map handed to the condition pass starts EMPTY and is filled BY that pass', async () => {
    // The empty-map doubt, measured rather than argued. `scrub.ts` declares
    // `outputSecrets` as an empty `Map` and passes THAT in, and a masker over
    // an empty map is a no-op that reads as safe in a diff. What makes it real
    // is that the map is a MUTABLE REFERENCE the resolver fills in place as it
    // resolves, and the `Fn::Equals` log runs AFTER both operands resolve — so
    // by logging time the needle is present. This measures both ends.
    let sizeBefore: number | undefined;
    let sizeAfter: number | undefined;
    let recorded: Map<string, string> | undefined;
    const original = IntrinsicFunctionResolver.prototype.evaluateConditions;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'evaluateConditions')
      .mockImplementation(async function (this: IntrinsicFunctionResolver, ctx: unknown) {
        recorded = (ctx as { recordedSecretValues?: Map<string, string> }).recordedSecretValues;
        sizeBefore = recorded?.size;
        try {
          return await original.call(this, ctx as never);
        } finally {
          sizeAfter = recorded?.size;
        }
      } as never);
    try {
      await scrub(PUBLIC_PROPS, { conditions: CONDITIONS, dryRun: true });
    } finally {
      spy.mockRestore();
    }

    // A map WAS supplied — `resolverContext`'s
    // `...(recordedSecretValues && { recordedSecretValues })` spread drops the
    // key entirely when it is not, which is the pre-fix shape.
    expect(recorded).toBeInstanceOf(Map);
    // It went in empty — the state in which the mask would be a no-op...
    expect(sizeBefore).toBe(0);
    // ...and the condition pass itself filled it, before the log line ran.
    expect(sizeAfter).toBeGreaterThan(0);
    expect(recorded!.get(PLAINTEXT)).toBe(SECRET_EXPR);
  });
});

describe('the cross-stack pre-pass MASKS the export name it declines (issue #2163 review)', () => {
  /**
   * The disclosure this fences, and it is the same one
   * {@link crossStackProducerPlaintextError} already masks against on the
   * REFUSAL path — arriving through a `logger.debug` line instead, which has no
   * boundary net at all.
   *
   * `producer.key` is `recordedImports.at(-1).exportName`, i.e. the
   * POST-resolution name: `resolveImportValue` sets it from
   * `resolveValue(importValueArg)`, which runs an `Fn::Sub` / `Fn::Join` / a
   * bare `{{resolve:...}}` string through. So an export name ASSEMBLED FROM A
   * SECRET is a resolved secret verbatim, and the five arms that name the
   * export while declining would have printed it into a
   * `cdkd scrub --verbose` CI log — inside the command whose whole purpose is
   * removing that plaintext from state.
   *
   * `maskSecretsInError` at `scrubStack`'s boundary is not a substitute even
   * for the throwing arms, and reaches none of these: it masks against
   * `allRecordedSecrets`, which DROPS every needle below `MIN_NEEDLE_LENGTH`,
   * while the whole-value arm of `maskSecretsInText` matches at any length.
   */
  /** The plaintext the producer's secret holds — and, here, the export NAME. */
  const SECRET_EXPORT = 'Producer:export-name-from-a-secret-2163';
  /** The template leaf: an import whose NAME is a dynamic reference. */
  const EXPORT_NAME_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:exportname}}`;
  const PROPS = {
    MasterUsername: { 'Fn::ImportValue': EXPORT_NAME_EXPR },
    MasterUserPassword: 'not-a-secret',
  };

  beforeEach(() => {
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PLAINTEXT, exportname: SECRET_EXPORT }),
    });
    consumerState = makeConsumerState({
      MasterUsername: 'admin',
      MasterUserPassword: 'not-a-secret',
    });
    useProducerOutputs({ [SECRET_EXPORT]: 'an-ordinary-exported-value' });
  });

  it('the `no verdict` decline names the export as the MASK, never the plaintext', async () => {
    // The producer's template declares this export from a plain `Ref`, so the
    // verdict is `no` and the pre-pass declines — printing the export name.
    await scrub(PROPS, {
      appStacks: [makeProducerStackInfo({ Out: { Value: { Ref: 'B' }, Export: { Name: SECRET_EXPORT } } })],
    });

    // POSITIVE MARKERS FIRST — the `not.toContain` below is satisfied just as
    // well by a run that never resolved the export name at all.
    // 1. The secret really was fetched, which is what MAKES the export name a
    //    resolved secret and records the needle to mask against.
    expect(secretSends.map((s) => s.command)).toContain('GetSecretValueCommand');
    // 2. The read really went through the producer's state record...
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    // 3. ...and the declining arm really ran and rendered the export name.
    const line = logLines.find((l) => l.includes('declares no {{resolve:...}} expression for'));
    expect(line).toBeDefined();

    // 4. THE assertion: what it rendered is the MASK. The producer STACK beside
    //    it is untouched HERE because this fixture's producer name is an
    //    ordinary one, not because the name can never be a secret — it can, and
    //    the sibling describe below fences that. Asserting it survives is what
    //    tells a masked line apart from one that simply never carried the name.
    expect(line).toContain(`expression for '${SECRET_MASK}'`);
    expect(line).toContain(`producer '${PRODUCER}'`);
    expect(logLines.join('\n')).not.toContain(SECRET_EXPORT);
  });

  it('the same holds on the arm that declines for a producer OUTSIDE the app', async () => {
    // A second arm, because the mask is per-site: passing no `appStacks` takes
    // the `producerTemplates` miss, which names the export for a different
    // reason and used to interpolate it just as raw.
    await scrub(PROPS, { appStacks: [] });

    const line = logLines.find((l) => l.includes('which is not a stack of this app'));
    expect(line).toBeDefined();
    expect(line).toContain(`classify export '${SECRET_MASK}' with`);
    expect(logLines.join('\n')).not.toContain(SECRET_EXPORT);
  });

  it('and on the HEALTHY arm, which declines for the one reason that is not a problem', async () => {
    // The third site, and the one a reader is least likely to suspect: the
    // producer is SCRUBBED, nothing is wrong, and the line says so — while
    // still naming the export. A decline that reports good news is exactly the
    // one whose masking nobody re-checks, so it gets its own fence rather than
    // riding on the two above.
    useProducerOutputs({ [SECRET_EXPORT]: SECRET_EXPR });

    await scrub(PROPS, {
      appStacks: [
        makeProducerStackInfo({
          Out: { Value: SECRET_EXPR, Export: { Name: SECRET_EXPORT } },
        }),
      ],
    });

    const line = logLines.find((l) =>
      l.includes('already carries a {{resolve:...}} expression')
    );
    expect(line).toBeDefined();
    expect(line).toContain(`stored value for '${SECRET_MASK}'`);
    expect(logLines.join('\n')).not.toContain(SECRET_EXPORT);
  });
});

describe('the pre-pass masks the PRODUCER STACK NAME too, which is reachable (issue #2163 review)', () => {
  /**
   * The sibling of the export-name fence above, and the one whose rationale
   * this branch had to correct before the test could be written at all.
   *
   * An earlier revision justified masking `producer.stack` as UNIFORMITY, on
   * the reasoning that a producer name comes from a state record and is never a
   * resolved value. That holds for `Fn::ImportValue`, whose producer name comes
   * from the state-bucket listing (`recordImport` is handed `entry.producerStack`
   * / `refStack`). It is FALSE for `Fn::GetStackOutput`:
   * `recordOutputRead(context, stackName, ...)` is fed
   * `await this.resolveValue(args['StackName'], context)`, so a `StackName`
   * that is itself a `{{resolve:...}}` reference — or an `Fn::Sub` / `Fn::Join`
   * assembling one — makes the RECORDED producer name a resolved secret,
   * exactly the way the export name can be.
   *
   * Nothing leaked: the mask was there throughout. What was missing was any
   * test that would notice if it went away, and the wrong rationale beside it
   * read as licence to remove it. Measured before this case existed: replacing
   * `loggedStack` with `producer.stack` left every test in this directory
   * green.
   */
  /** The plaintext the producer's secret holds — and, here, the STACK NAME. */
  const SECRET_STACK = 'ProducerNamedFromASecret2163';
  /** The template leaf: a `StackName` that is a dynamic reference. */
  const STACK_NAME_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:stackname}}`;
  const PROPS = {
    MasterUsername: {
      'Fn::GetStackOutput': { StackName: STACK_NAME_EXPR, OutputName: OUTPUT_NAME },
    },
    MasterUserPassword: 'not-a-secret',
  };

  beforeEach(() => {
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PLAINTEXT, stackname: SECRET_STACK }),
    });
    consumerState = makeConsumerState({
      MasterUsername: 'admin',
      MasterUserPassword: 'not-a-secret',
    });
    stateBackend.listStacks.mockResolvedValue([{ stackName: SECRET_STACK, region: REGION }]);
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(
        stackName === SECRET_STACK
          ? {
              state: {
                version: 8,
                region: REGION,
                stackName: SECRET_STACK,
                resources: {},
                outputs: { [OUTPUT_NAME]: 'an-ordinary-exported-value' },
                lastModified: 0,
              } as StackState,
              etag: 'p-1',
            }
          : { state: consumerState, etag: 'c-1' }
      )
    );
  });

  it('the decline for a producer OUTSIDE the app names the stack as the MASK, never the plaintext', async () => {
    await scrub(PROPS, { appStacks: [] });

    // POSITIVE MARKERS FIRST — `not.toContain` is satisfied just as well by a
    // run that never resolved the stack name at all.
    // 1. The secret really was fetched, which is what MAKES the stack name a
    //    resolved secret and records the needle to mask against.
    expect(secretSends.map((s) => s.command)).toContain('GetSecretValueCommand');
    // 2. The read really went to the stack the SECRET named — this is the step
    //    the old rationale said could not happen.
    expect(stateBackend.getState.mock.calls).toContainEqual([SECRET_STACK, REGION]);
    // 3. ...and the declining arm really ran.
    const line = logLines.find((l) => l.includes('which is not a stack of this app'));
    expect(line).toBeDefined();

    // 4. THE assertion, both polarities. The export name beside it is an
    //    ordinary one here, so it survives — which is what distinguishes a
    //    masked stack name from a line that masked everything indiscriminately.
    expect(line).toContain(`producer '${SECRET_MASK}'`);
    expect(line).toContain(`classify export '${OUTPUT_NAME}' with`);
    expect(logLines.join('\n')).not.toContain(SECRET_STACK);
  });

  it('and the REFUSAL path masks it too, which only a SHORT name can prove', async () => {
    // The throwing sibling, `plaintextProducerCrossStackReadError`, whose
    // comment carried the identical wrong rationale and had done since issue
    // #2133.
    //
    // THE STACK NAME IS THREE CHARACTERS, and that is the whole test rather
    // than an aesthetic choice. The refusal, unlike a `logger.debug` line,
    // passes through `maskSecretsInError` at `scrubStack`'s boundary on its way
    // out — so with a needle of ordinary length the boundary masks it and the
    // builder's own call is unfalsifiable. Measured: with a 28-character name,
    // removing the builder's mask left this suite GREEN. `allRecordedSecrets`
    // filters to `MIN_NEEDLE_LENGTH` (4), while the whole-value arm of
    // `maskSecretsInText` matches at ANY length — which is exactly the
    // asymmetry the comment beside the mask claims, so this case is what makes
    // that claim falsifiable instead of decorative.
    const SHORT_STACK = 'Zq7';
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PLAINTEXT, stackname: SHORT_STACK }),
    });
    stateBackend.listStacks.mockResolvedValue([{ stackName: SHORT_STACK, region: REGION }]);
    stateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve(
        stackName === SHORT_STACK
          ? {
              state: {
                version: 8,
                region: REGION,
                stackName: SHORT_STACK,
                resources: {},
                // The pre-#1899 plaintext still in the producer's own record —
                // the shape that makes this a refusal rather than a decline.
                outputs: { [OUTPUT_NAME]: PLAINTEXT },
                lastModified: 0,
              } as StackState,
              etag: 'p-1',
            }
          : { state: consumerState, etag: 'c-1' }
      )
    );

    const err = await scrub(PROPS, {
      appStacks: [
        {
          stackName: SHORT_STACK,
          dependencyNames: [],
          template: {
            Resources: {},
            Outputs: { [OUTPUT_NAME]: { Value: SECRET_EXPR } },
          } as unknown as CloudFormationTemplate,
        },
      ],
    }).catch((e: unknown) => e);

    // The refusal really is the plaintext-producer one, not some other failure.
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    // THE assertion: the message names the producer as the mask...
    expect((err as Error).message).toContain(`producer stack '${SECRET_MASK}'`);
    // ...and the plaintext appears nowhere in it, nor in the debug trail.
    expect((err as Error).message).not.toContain(`'${SHORT_STACK}'`);
    expect(logLines.join('\n')).not.toContain(`'${SHORT_STACK}'`);
  });
});

describe('a stored value carrying no text is not a plaintext producer (issue #2133 review)', () => {
  /**
   * The `widened` verdict fires when the producer publishes SOME secret-bearing
   * output but this key matched no declared one — an intrinsic `Export.Name`
   * scrub cannot reproduce. `carriesDynamicReference` is false for `null`, `''`
   * and every non-string scalar, so such a key used to raise
   * `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` claiming the read "resolved to a
   * PLAINTEXT value" over a value holding nothing — and the remedy that
   * refusal prescribes (scrub the producer, re-run) cannot clear it, because
   * scrubbing cannot turn an empty value into an expression.
   *
   * The producer's TEMPLATE below declares its secret output under
   * `EXPORT_NAME`, while the consumer imports `OTHER_EXPORT` — which is what
   * makes the verdict `widened` rather than `declared`.
   */
  const OTHER_EXPORT = 'Producer:OtherExport';
  const PROPS = { MasterUserPassword: { 'Fn::ImportValue': OTHER_EXPORT }, MasterUsername: 'admin' };
  const scrubWithStored = async (stored: unknown): Promise<unknown> => {
    useProducerOutputs({ [OTHER_EXPORT]: stored });
    return await scrub(PROPS, { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }).catch(
      (e: unknown) => e
    );
  };

  it('POSITIVE CONTROL: a real stored plaintext under the SAME widened verdict still refuses', async () => {
    // Without this the two cases below would pass just as well if the widened
    // arm were unreachable from this fixture at all.
    const err = await scrubWithStored(PLAINTEXT);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    // ...and the message takes the `widened` wording, so the verdict really is
    // the one these cases are about.
    expect((err as Error).message).toContain('could not ');
    expect((err as Error).message).toContain('publishes at least one output');
  });

  it('a stored null does not refuse', async () => {
    const res = await scrubWithStored(null);

    expect(res).not.toBeInstanceOf(Error);
    // The read really happened — otherwise "did not refuse" is satisfied by a
    // run that never reached the discriminator.
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
    expect(
      logLines.some((l) => l.startsWith('debug') && l.includes('carries no ')),
      'the classifier should say why it declined to refuse'
    ).toBe(true);
  });

  it('a stored empty string does not refuse either', async () => {
    const res = await scrubWithStored('');

    expect(res).not.toBeInstanceOf(Error);
    expect(stateBackend.getState.mock.calls).toContainEqual([PRODUCER, REGION]);
  });
});

describe('the plaintext-producer refusal masks its export key (issue #2133 review)', () => {
  /**
   * `exportKey` is a RESOLVED export name, so an `Fn::ImportValue` over a
   * `{{resolve:...}}` string makes it a resolved secret verbatim — and this
   * builder used to interpolate it RAW while its sibling
   * `unresolvableCrossStackReadError` masked.
   *
   * THE FIXTURE IS DELIBERATELY SUB-THRESHOLD, and that is what makes this test
   * discriminating rather than vacuous. `maskSecretsInError` at `scrubStack`'s
   * boundary would mask an ordinary needle whatever this builder did, because
   * it re-masks the whole message on the way out. But it masks through
   * `allRecordedSecrets`, which DROPS every needle shorter than
   * `MIN_NEEDLE_LENGTH` (4), while the whole-value arm of `maskSecretsInText`
   * matches at ANY length. So a 3-character secret is reached by the local mask
   * and by nothing else, and the assertion below fails if the local mask is
   * removed.
   */
  const SHORT_SECRET = 'q7z';
  const SHORT_SECRET_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:short}}';

  it('a secret-valued export NAME appears masked, not verbatim', async () => {
    // One primed response serves both JSON keys, so `:password` still resolves
    // to PLAINTEXT while `:short` resolves to the sub-threshold secret.
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PLAINTEXT, short: SHORT_SECRET }),
    });
    // The producer's state carries the RESOLVED export name as its key, holding
    // an ordinary stored plaintext — so the read succeeds and the refusal fires.
    useProducerOutputs({ [SHORT_SECRET]: 'producer-stored-plaintext' });

    const err = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': SHORT_SECRET_EXPR },
        MasterUsername: 'admin',
      },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    ).catch((e: unknown) => e);

    // POSITIVE MARKER: the refusal this test is about really fired, so the
    // absence assertion below is not satisfied by some other code path.
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    const message = (err as Error).message;
    // ...and it rendered the MASK where the export name goes.
    expect(message).toContain('***');
    // THE assertion: the resolved secret is not in the message at all.
    expect(message).not.toContain(SHORT_SECRET);
    // Nor anywhere in the run's log output.
    expect(logLines.join('\n')).not.toContain(SHORT_SECRET);
  });
});

/**
 * A RE-EXPORT chain must not defeat the plaintext-producer refusal (issue
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146)).
 *
 * The #2133 gate asked ONE template — the direct producer's — for a literal
 * `{{resolve:`. A middle stack that merely re-exports someone else's export has
 * none, so the verdict was `no`, the pre-pass returned early, and `cdkd scrub
 * <the consumer>` printed `No plaintext secrets found` and exited 0 while the
 * consumer's record still held the imported plaintext. That is the #2133 silent
 * success reached through a re-export instead of a direct import.
 *
 * `cdkd scrub --all` hides it (`orderScrubTargets` scrubs producers first), so
 * every case here scrubs ONE stack, which is what a user does when told to
 * scrub a named stack.
 */
describe('cdkd scrub follows a RE-EXPORT chain (issue #2146)', () => {
  const ROOT = 'RootProducer';
  const ROOT_EXPORT = 'RootProducer:DbSecret';
  const MID = 'MidReexporter';
  const MID_EXPORT = 'MidReexporter:DbSecret';
  const SECOND_MID = 'SecondReexporter';
  const SECOND_MID_EXPORT = 'SecondReexporter:DbSecret';
  const THIRD_MID = 'ThirdReexporter';
  const THIRD_MID_EXPORT = 'ThirdReexporter:DbSecret';
  /** A stack whose export is ORDINARY, for the Fn::If branch that must not refuse. */
  const PLAIN_STACK = 'PlainPublisher';
  const PLAIN_EXPORT = 'PlainPublisher:BucketName';

  /** Every stack's STATE outputs, keyed by stack name; anything absent has no record. */
  function useChainState(states: Record<string, Record<string, unknown>>): void {
    stateBackend.listStacks.mockResolvedValue(
      Object.keys(states).map((stackName) => ({ stackName, region: REGION }))
    );
    stateBackend.getState.mockImplementation((stackName: string) => {
      const outputs = states[stackName];
      if (outputs) {
        return Promise.resolve({
          state: {
            version: 8,
            region: REGION,
            stackName,
            resources: {},
            outputs,
            lastModified: 0,
          } as StackState,
          etag: `${stackName}-1`,
        });
      }
      if (stackName === CONSUMER) return Promise.resolve({ state: consumerState, etag: 'c-1' });
      return Promise.resolve(null);
    });
  }

  function chainStack(
    stackName: string,
    outputs: Record<string, unknown>
  ): { stackName: string; template: CloudFormationTemplate; dependencyNames: string[] } {
    return {
      stackName,
      dependencyNames: [],
      template: { Resources: {}, Outputs: outputs } as CloudFormationTemplate,
    };
  }

  /** The root of every chain below: the only stack whose template holds a literal expression. */
  const rootStack = chainStack(ROOT, {
    DbSecret: { Value: SECRET_EXPR, Export: { Name: ROOT_EXPORT } },
  });

  it('REFUSES when the middle stack re-exports a secret and its own state still holds the plaintext', async () => {
    // The #2146 shape exactly: MID's template declares no `{{resolve:` — its
    // output IS the import — so the single-template gate returned `no` here and
    // the consumer was reported clean over the plaintext below.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    const message = (err as Error).message;
    // It names the DIRECT producer (whose state holds the plaintext) ...
    expect(message).toContain(`producer stack '${MID}'`);
    // ... says the evidence came through a re-export rather than claiming MID
    // declares an expression it does not ...
    expect(message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
    // ... and prescribes the order that actually clears it: MID cannot store
    // the expression until ROOT has been scrubbed down to one.
    expect(message).toContain(`'cdkd scrub ${ROOT}', then 'cdkd scrub ${MID}'`);
    // Nothing is written for a stack scrub could not redact.
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('RESOLVES instead when the middle stack HAS been scrubbed — the chain is not a blanket refusal', async () => {
    // Same three templates, other polarity: MID's state holds the EXPRESSION,
    // so the read re-resolves it, that records the needle, and the consumer's
    // stored plaintext is rewritten. A mutation that refuses on every `chained`
    // verdict passes the case above and fails this one.
    useChainState({
      [MID]: { [MID_EXPORT]: SECRET_EXPR },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const res = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    const saved = savedState();
    // THE discriminator: `MasterUsername`'s template side is the public literal
    // `admin`, so only the needle the cross-stack read produced can reach it.
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
    expect(res.recordsChanged).toBe(1);
  });

  it('follows a chain TWO hops deep and names every stack in scrub order', async () => {
    // Consumer -> MID -> SECOND_MID -> ROOT. Pins the ORDER of the walk's
    // `via`, which is what the remedy is built from: reversed, head first.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [SECOND_MID]: { [SECOND_MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(SECOND_MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: SECOND_MID_EXPORT },
            },
          }),
          chainStack(MID, {
            // WRAPPED in an `Fn::Join`, the shape a re-export actually takes
            // when a stack builds a connection string out of an imported
            // secret — so the hop is found by walking the whole value, not just
            // its top level.
            DbSecret: {
              Value: { 'Fn::Join': ['', ['prefix-', { 'Fn::ImportValue': SECOND_MID_EXPORT }]] },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    const message = (err as Error).message;
    expect(message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
    expect(message).toContain(`(through '${SECOND_MID}')`);
    expect(message).toContain(
      `'cdkd scrub ${ROOT}', then 'cdkd scrub ${SECOND_MID}', then 'cdkd scrub ${MID}'`
    );
  });

  it('TERMINATES on a cycle in the export graph and still finds the secret behind it', async () => {
    // MID re-exports BOTH a cycle partner and the root; the partner re-exports
    // MID's own export. What this case pins is the COMMAND's answer over a
    // cyclic graph — it refuses, and for the right reason. TERMINATION itself is
    // pinned by the BUDGETED walk cases below, not here (issue #2146 review):
    // the walk is synchronous, so removing its visited set wedges this test
    // instead of failing it, and a hang is a CI job timeout rather than a
    // named defect.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(SECOND_MID, {
            // Straight back to MID: the cycle.
            DbSecret: {
              Value: { 'Fn::ImportValue': MID_EXPORT },
              Export: { Name: SECOND_MID_EXPORT },
            },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: {
                'Fn::Join': [
                  '',
                  [
                    { 'Fn::ImportValue': SECOND_MID_EXPORT },
                    ':',
                    { 'Fn::ImportValue': ROOT_EXPORT },
                  ],
                ],
              },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    // It came back at all (a non-terminating walk times this test out), and it
    // came back with the RIGHT answer rather than by giving up.
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
  });

  it('TERMINATES on a cycle with no secret anywhere, and does not refuse over it', async () => {
    // The over-approximation polarity of the case above: two stacks re-exporting
    // each other, nothing secret-bearing in the whole graph, and the command
    // must scrub the stack normally rather than refuse over the cycle. As above,
    // the BOUND that makes termination a fast red assertion lives in the
    // budgeted walk cases below.
    useChainState({ [MID]: { [MID_EXPORT]: 'an-ordinary-bucket-name' } });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        // The stack's OWN secret, so a completed run is observable.
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(SECOND_MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': MID_EXPORT },
              Export: { Name: SECOND_MID_EXPORT },
            },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': SECOND_MID_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    // POSITIVE MARKER: the run reached the rewrite rather than merely not
    // throwing.
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('a DIRECT import is still classified `declared`, not chained', async () => {
    // The unchanged polarity, asserted from the NEW branch's side: the walk must
    // not relabel a producer that declares the expression itself, or the message
    // would name a chain it never crossed and prescribe a scrub order with an
    // extra stack in it.
    useProducerOutputs({ [EXPORT_NAME]: PLAINTEXT });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': EXPORT_NAME }, MasterUsername: 'admin' },
      { appStacks: [makeProducerStackInfo(SECRET_PRODUCER_OUTPUTS)] }
    ).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain(`declares '${EXPORT_NAME}' from a {{resolve:...}}`);
    expect(message).not.toContain('RE-EXPORTING');
    expect(message).toContain(`Scrub the producer first ('cdkd scrub ${PRODUCER}')`);
  });

  it('a WIDENED root keeps the widened claim even when the expression was found up the chain', async () => {
    // MID's `Export.Name` is an intrinsic scrub cannot reproduce, so the read's
    // key matches no declared output and the test widens to all of them. The
    // expression is then found one hop up — but the claim must stay the widened
    // one, because nothing checked that THIS key is the output that re-exports it.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: { 'Fn::Sub': '${AWS::StackName}-DbSecret' } },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    // It still refuses (the widening is what makes it fire at all) ...
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    const message = (err as Error).message;
    // ... with BOTH halves of the widened claim: this key matched no declared
    // output, and the run cannot say which output is the secret-bearing one.
    expect(message).toContain('publishes at least one output');
    expect(message).toContain('could not match');
    // ... and it does NOT claim the producer publishes an output FROM an
    // expression, which is the one thing the walk proved false about it — it
    // says the output RE-EXPORTS one, and names the stack that declares it
    // (issue #2146 review; the first cut dropped `via` on the widened verdict
    // and asserted exactly the falsified claim).
    expect(message).toContain(
      `publishes at least one output that RE-EXPORTS a value '${ROOT}' declares from a ` +
        `{{resolve:...}} expression`
    );
    expect(message).not.toContain('output from a {{resolve:...}} expression');
    // ... and the remedy is the whole chain, not the single command that would
    // land the user in a second refusal.
    expect(message).toContain(`'cdkd scrub ${ROOT}', then 'cdkd scrub ${MID}'`);
  });

  it('an upstream export produced OUTSIDE the app is the documented residual, not a refusal', async () => {
    // The boundary of the walk: MID re-exports an export no stack in the
    // assembly declares, so there is no template to follow into. Refusing here
    // would be unclearable — no `cdkd scrub` of anything can turn a foreign
    // export into an expression — so the pre-#2133 outcome is kept for it.
    useChainState({ [MID]: { [MID_EXPORT]: 'value-from-outside-the-app' } });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': 'SomeForeignStack:Export' },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('a producer DECLARING the expression in the UNTAKEN Fn::If branch does not refuse (#2150)', async () => {
    // THE #2150 SHAPE, and the half issue #2146 deliberately left alone: the
    // producer does not RE-EXPORT anything, it DECLARES the expression itself,
    // in the TRUE arm of an `Fn::If`. That arm is answered by the literal
    // `{{resolve:` scan rather than by the hop walk, and the scan used to
    // `JSON.stringify` the whole node -- so it saw both arms, verdicted
    // `declared`, and the discriminator then read the DEPLOYED value `plain`,
    // which carries no expression. The result was `SCRUB_CROSS_STACK_PRODUCER_
    // PLAINTEXT`: an UNCLEARABLE refusal, because no `cdkd scrub` of the
    // producer can turn `plain` into an expression and there is no bypass flag,
    // so every other secret in this consumer stack was stranded with it.
    //
    // The scan now applies the SAME branch selection the hop walk does.
    useChainState({
      [MID]: { [MID_EXPORT]: 'plain' },
    });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        // The stack's OWN secret: the POSITIVE MARKER that the run reached the
        // rewrite. Without it "did not throw" is also what a run that died
        // early produces.
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::If': ['IsProd', SECRET_EXPR, 'plain'] },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('a producer declaring the expression in the TAKEN Fn::If branch STILL refuses (#2150)', async () => {
    // The negative control for the case above, and the reason #2150 is a
    // NARROWING rather than a removal: put the same expression in the FALSE arm
    // -- the branch scrub selects -- and the refusal fires exactly as it does
    // without the `Fn::If` at all. A fix that stopped looking inside `Fn::If`
    // altogether passes the case above and fails this one.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::If': ['IsProd', 'plain', SECRET_EXPR] },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain(`producer stack '${MID}'`);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a MALFORMED Fn::If in the producer\'s output claims NO branch (#2150)', async () => {
    // Args that are not a 3-tuple: which branch is live is unknowable, so
    // neither a hop nor a `{{resolve:` sighting may be claimed from it. Asserted
    // on the SCAN side here -- its twin on the hop side is the `a MALFORMED
    // Fn::If cannot refuse` case above -- because the two now share one
    // selection and a regression in it would surface on whichever side is
    // tested. CloudFormation rejects such a template, so a producer carrying one
    // cannot have been deployed.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
    });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::If': ['IsProd', SECRET_EXPR] },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('the Fn::If selection descends into an ARRAY, not only the top level (#2150)', async () => {
    // The array arm of `selectTakenConditionalBranches` was UNFENCED by the
    // whole suite until the #2157/#2150 review measured it: making that arm
    // return the node unchanged left every test green. The shape is ordinary --
    // `Fn::Join`-ing a conditional import into a URL is what the live fixture
    // one file over does -- so the gap was coverage, not reachability.
    //
    // Unpruned, the array's `Fn::If` reaches the scan whole and its TRUE arm's
    // expression is seen: verdict `declared`, stored value `plain`, unclearable
    // refusal. Pruned, the FALSE branch leaves nothing to see.
    useChainState({
      [MID]: { [MID_EXPORT]: 'plain' },
    });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::Join': ['', [{ 'Fn::If': ['IsProd', SECRET_EXPR, 'plain'] }]] },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('the Fn::If selection RECURSES into the branch it selects (#2150)', async () => {
    // Also unfenced before the review: dropping the recursion (returning
    // `args[2]` raw instead of walking it) left 100/100 green. A nested `Fn::If`
    // then reaches the scan as a whole node, so the INNER conditional's TRUE arm
    // is seen and the refusal fires over a producer whose deployed value is the
    // doubly-false `plain`.
    useChainState({
      [MID]: { [MID_EXPORT]: 'plain' },
    });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: {
                'Fn::If': [
                  'IsProd',
                  SECRET_EXPR,
                  { 'Fn::If': ['IsStaging', SECRET_EXPR, 'plain'] },
                ],
              },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('an OWN __proto__ key survives the selection, so a secret under it is still seen (#2150)', async () => {
    // FAIL-OPEN HAZARD, and the direction is what makes it worth a case: a
    // template is JSON-parsed, so `__proto__` arrives as an OWN key. Rebuilding
    // the pruned node onto an object LITERAL walks the prototype setter instead
    // of defining the key, so the key -- and the `{{resolve:` under it -- would
    // vanish and the producer would look plaintext-free. `Object.create(null)`
    // is what the three sibling walks in this file already use.
    //
    // Built with `JSON.parse` deliberately: an object literal spelled
    // `{'__proto__': ...}` sets the PROTOTYPE and creates no own key at all, so
    // it would not reproduce the shape under test.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          chainStack(MID, {
            DbSecret: {
              Value: JSON.parse(`{"__proto__": {"Nested": ${JSON.stringify(SECRET_EXPR)}}}`) as unknown,
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('an Fn::If in the producer\'s output does NOT refuse over the UNTAKEN branch', async () => {
    // THE UNCLEARABLE-REFUSAL CLASS, end to end (issue #2146 review). The middle
    // stack publishes a secret import in the TRUE branch and a plain one in the
    // FALSE branch; scrub cannot evaluate ANOTHER stack's conditions, so it
    // mirrors `resolveIf`'s unknown-condition arm and takes FALSE. Refusing here
    // would strand this consumer forever: nothing can turn the middle stack's
    // non-secret stored value into an expression, and there is no bypass flag.
    useChainState({
      [MID]: { [MID_EXPORT]: 'an-ordinary-bucket-name' },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const res = await scrub(
      {
        MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT },
        // The stack's OWN secret, so a completed run is observable.
        MasterUsername: SECRET_EXPR,
      },
      {
        appStacks: [
          rootStack,
          chainStack(PLAIN_STACK, {
            Plain: { Value: { Ref: 'SomeBucket' }, Export: { Name: PLAIN_EXPORT } },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: {
                'Fn::If': [
                  'IsProd',
                  { 'Fn::ImportValue': ROOT_EXPORT },
                  { 'Fn::ImportValue': PLAIN_EXPORT },
                ],
              },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    // POSITIVE MARKER: the run reached the rewrite rather than merely not
    // throwing.
    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
  });

  it('an Fn::If in the producer\'s output STILL refuses over the branch scrub takes', async () => {
    // The other polarity of the case above, and the reason it is a pair: the
    // FALSE arm carries the secret-bearing re-export, so the walk follows it and
    // the refusal fires exactly as it does without the `Fn::If`.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(PLAIN_STACK, {
            Plain: { Value: { Ref: 'SomeBucket' }, Export: { Name: PLAIN_EXPORT } },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: {
                'Fn::If': [
                  'IsProd',
                  { 'Fn::ImportValue': PLAIN_EXPORT },
                  { 'Fn::ImportValue': ROOT_EXPORT },
                ],
              },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
  });

  it('refuses through an Fn::GetStackOutput re-export, not only an Fn::ImportValue one', async () => {
    // The other hop kind, end to end. The middle stack reads the root's output
    // BY NAME rather than importing its export, which is the form
    // `Fn::GetStackOutput` takes — and which the walk resolves through the
    // literal `StackName` / `OutputName` pair instead of the export index.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::GetStackOutput': { StackName: ROOT, OutputName: 'DbSecret' } },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect((err as Error).message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
  });

  it('RESOLVES through a TWO-HOP chain, not only through one hop', async () => {
    // The resolve polarity at depth 2 (the two-hop case above is refuse-only).
    // Every stack in the chain holds the expression, so the read re-resolves it,
    // records the needle, and the consumer's seeded plaintext is rewritten —
    // which is what says the walk's extra hop did not cost the RESOLVE path.
    useChainState({
      [MID]: { [MID_EXPORT]: SECRET_EXPR },
      [SECOND_MID]: { [SECOND_MID_EXPORT]: SECRET_EXPR },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const res = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(SECOND_MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: SECOND_MID_EXPORT },
            },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': SECOND_MID_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    );

    const saved = savedState();
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
    expect(res.recordsChanged).toBe(1);
  });

  it('lists EVERY intermediate stack when the chain is three hops long', async () => {
    // Pins the `through 'A', 'B'` join and the four-command scrub order — the
    // two-hop case can be satisfied by a builder that only ever emits one
    // intermediate.
    useChainState({
      [MID]: { [MID_EXPORT]: PLAINTEXT },
      [SECOND_MID]: { [SECOND_MID_EXPORT]: PLAINTEXT },
      [THIRD_MID]: { [THIRD_MID_EXPORT]: PLAINTEXT },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      { MasterUserPassword: { 'Fn::ImportValue': MID_EXPORT }, MasterUsername: 'admin' },
      {
        appStacks: [
          rootStack,
          chainStack(THIRD_MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: THIRD_MID_EXPORT },
            },
          }),
          chainStack(SECOND_MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': THIRD_MID_EXPORT },
              Export: { Name: SECOND_MID_EXPORT },
            },
          }),
          chainStack(MID, {
            DbSecret: {
              Value: { 'Fn::ImportValue': SECOND_MID_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    expect(message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
    expect(message).toContain(`(through '${SECOND_MID}', '${THIRD_MID}')`);
    expect(message).toContain(
      `'cdkd scrub ${ROOT}', then 'cdkd scrub ${THIRD_MID}', then 'cdkd scrub ${SECOND_MID}', ` +
        `then 'cdkd scrub ${MID}'`
    );
  });
  it('memoizes the verdict per (producer, KEY), not per producer', async () => {
    // ONE producer, TWO exports, OPPOSITE verdicts, both read in a single scrub:
    // the ordinary one FIRST so its `no` is the entry already in the cache when
    // the secret-bearing one is looked up. A memo keyed by producer stack alone
    // returns that `no` for the second read, the pre-pass returns early, and the
    // stack is reported clean over the plaintext it still holds — the #2133
    // silent success reintroduced by a cache, which no assertion on the walk
    // itself would see.
    useChainState({
      [MID]: {
        [PLAIN_EXPORT]: 'an-ordinary-bucket-name',
        [MID_EXPORT]: PLAINTEXT,
      },
      [ROOT]: { [ROOT_EXPORT]: SECRET_EXPR },
    });

    const err = await scrub(
      {
        // Read FIRST (object property order is the pre-pass's walk order).
        MasterUserPassword: { 'Fn::ImportValue': PLAIN_EXPORT },
        MasterUsername: { 'Fn::ImportValue': MID_EXPORT },
      },
      {
        appStacks: [
          rootStack,
          chainStack(MID, {
            // Ordinary: matches its key, carries no expression and no hop.
            Plain: { Value: { Ref: 'SomeBucket' }, Export: { Name: PLAIN_EXPORT } },
            // Secret-bearing by re-export, from the SAME stack.
            DbSecret: {
              Value: { 'Fn::ImportValue': ROOT_EXPORT },
              Export: { Name: MID_EXPORT },
            },
          }),
        ],
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    // It refused for the SECOND export, not the first — the message names the
    // key that is actually secret-bearing.
    expect((err as Error).message).toContain(`publishes '${MID_EXPORT}' by RE-EXPORTING`);
    expect((err as Error).message).toContain(`by RE-EXPORTING a value that '${ROOT}' declares`);
  });
});

/**
 * The re-export WALK itself, exercised directly (issue #2146 review).
 *
 * WHY THIS BLOCK CALLS THE FUNCTION rather than going through `scrubStack` like
 * everything above it. Two of these properties are unreachable from the command
 * surface at a cost that pays for itself:
 *
 * - TERMINATION could only be pinned by HANGING. The walk is fully SYNCHRONOUS,
 *   so removing its visited set does not fail a test — it wedges the worker,
 *   no vitest timeout can fire (nothing yields), and CI reports a job timeout
 *   with a message pointing nowhere near the cause. A budget on template reads
 *   turns that into a red assertion in milliseconds, and names the defect.
 * - The `Fn::GetStackOutput` hop and the non-root NO-WIDENING rule need a
 *   producer template whose output names a stack + output directly; the second
 *   is reachable ONLY through the first, since an `Fn::ImportValue` hop is
 *   looked up BY export name and therefore always matches at the far end.
 *
 * The end-to-end polarities of the same behaviours stay on `scrubStack` below,
 * so nothing here stands in for "the command refuses".
 */
describe('the re-export walk (issue #2146 review)', () => {
  const EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

  function tpl(outputs: Record<string, unknown>): CloudFormationTemplate {
    return { Resources: {}, Outputs: outputs } as CloudFormationTemplate;
  }
  /** An output that RE-EXPORTS `value` under `exportName`. */
  function reexport(exportName: string, value: unknown): Record<string, unknown> {
    return { Value: value, Export: { Name: exportName } };
  }

  /**
   * A templates map that THROWS once the walk has read more templates than the
   * pair space can justify. `buildExportOwnerIndex` iterates entries rather than
   * calling `get`, so the count is the walk's own.
   */
  class BudgetMap extends Map<string, CloudFormationTemplate> {
    calls = 0;
    constructor(
      entries: readonly (readonly [string, CloudFormationTemplate])[],
      readonly budget: number
    ) {
      super(entries as [string, CloudFormationTemplate][]);
    }
    override get(key: string): CloudFormationTemplate | undefined {
      this.calls += 1;
      if (this.calls > this.budget) {
        throw new Error(`the walk read ${this.calls} templates, over the ${this.budget} budget`);
      }
      return super.get(key);
    }
  }

  function verdictOf(
    templates: ReadonlyMap<string, CloudFormationTemplate>,
    producerStack: string,
    key: string
  ): { kind: string; via: readonly string[] } {
    return producerPublishesSecretExpression(
      templates,
      buildExportOwnerIndex(templates),
      producerStack,
      key
    );
  }

  it('TERMINATES on a cycle within a BOUNDED number of template reads', async () => {
    // Three stacks re-exporting each other in a ring, none secret-bearing. The
    // pair space is 3, so a walk with a visited set reads at most a handful of
    // templates; one without reads unboundedly and never returns.
    const templates = new BudgetMap(
      [
        ['A', tpl({ Out: reexport('A-Export', { 'Fn::ImportValue': 'B-Export' }) })],
        ['B', tpl({ Out: reexport('B-Export', { 'Fn::ImportValue': 'C-Export' }) })],
        ['C', tpl({ Out: reexport('C-Export', { 'Fn::ImportValue': 'A-Export' }) })],
      ],
      8
    );

    const verdict = verdictOf(templates, 'A', 'A-Export');

    // It came back, it came back with the right answer, and it came back
    // WITHOUT re-reading a pair it had already expanded.
    expect(verdict.kind).toBe('no');
    expect(templates.calls).toBeLessThanOrEqual(8);
  });

  it('TERMINATES on a cycle that DOES lead to a secret, still within the budget', async () => {
    // A ring at depth 1 and the secret THREE hops down the other branch, so the
    // bound cannot be met by reaching the secret before the ring costs anything:
    // without the visited set the shallow ring re-expands at every level and
    // blows the budget BEFORE the deep root is ever read. Six distinct pairs, so
    // a deduping walk reads six templates and returns the full chain.
    const templates = new BudgetMap(
      [
        [
          'A',
          tpl({
            Out: reexport('A-Export', {
              'Fn::Join': [
                '',
                [{ 'Fn::ImportValue': 'Ring-Export' }, { 'Fn::ImportValue': 'P1-Export' }],
              ],
            }),
          }),
        ],
        // Straight back to A: the ring.
        ['Ring', tpl({ Out: reexport('Ring-Export', { 'Fn::ImportValue': 'A-Export' }) })],
        ['P1', tpl({ Out: reexport('P1-Export', { 'Fn::ImportValue': 'P2-Export' }) })],
        ['P2', tpl({ Out: reexport('P2-Export', { 'Fn::ImportValue': 'P3-Export' }) })],
        ['P3', tpl({ Out: reexport('P3-Export', { 'Fn::ImportValue': 'R-Export' }) })],
        ['R', tpl({ Out: reexport('R-Export', EXPR) })],
      ],
      8
    );

    const verdict = verdictOf(templates, 'A', 'A-Export');

    expect(verdict.kind).toBe('chained');
    expect(verdict.via).toEqual(['P1', 'P2', 'P3', 'R']);
    expect(templates.calls).toBeLessThanOrEqual(8);
  });

  it('follows a LITERAL Fn::GetStackOutput hop', async () => {
    const templates = new Map<string, CloudFormationTemplate>([
      [
        'Mid',
        tpl({
          Out: reexport('Mid-Export', {
            'Fn::GetStackOutput': { StackName: 'Root', OutputName: 'Password' },
          }),
        }),
      ],
      ['Root', tpl({ Password: { Value: EXPR } })],
    ]);

    expect(verdictOf(templates, 'Mid', 'Mid-Export')).toEqual({ kind: 'chained', via: ['Root'] });
  });

  it('does NOT follow an Fn::GetStackOutput whose slots are not literal, or whose stack is foreign', async () => {
    // The negative polarity of the branch above: an assembled `StackName`, an
    // assembled `OutputName`, and a stack outside the app each yield NO hop, so
    // the verdict stays `no` rather than guessing a producer.
    const root = tpl({ Password: { Value: EXPR } });
    const assembledStack = tpl({
      Out: reexport('Mid-Export', {
        'Fn::GetStackOutput': {
          StackName: { 'Fn::Sub': '${Env}-Root' },
          OutputName: 'Password',
        },
      }),
    });
    const assembledOutput = tpl({
      Out: reexport('Mid-Export', {
        'Fn::GetStackOutput': { StackName: 'Root', OutputName: { Ref: 'WhichOutput' } },
      }),
    });
    const foreignStack = tpl({
      Out: reexport('Mid-Export', {
        'Fn::GetStackOutput': { StackName: 'NotInThisApp', OutputName: 'Password' },
      }),
    });

    for (const mid of [assembledStack, assembledOutput, foreignStack]) {
      const templates = new Map<string, CloudFormationTemplate>([
        ['Mid', mid],
        ['Root', root],
      ]);
      expect(verdictOf(templates, 'Mid', 'Mid-Export').kind).toBe('no');
    }
  });

  it('does NOT widen at a HOP whose key matches no output there', async () => {
    // The invariant that keeps a refusal clearable: one hop up, the key is a
    // LITERAL name read out of a template, so a miss means that template does
    // not declare it — and widening to the upstream stack's OTHER outputs would
    // refuse this consumer over an unrelated secret two stacks away.
    const templates = new Map<string, CloudFormationTemplate>([
      [
        'Mid',
        tpl({
          Out: reexport('Mid-Export', {
            'Fn::GetStackOutput': { StackName: 'Root', OutputName: 'NotDeclaredHere' },
          }),
        }),
      ],
      // Root DOES have a secret-bearing output — under a different name.
      ['Root', tpl({ SomeOtherOutput: { Value: EXPR } })],
    ]);

    expect(verdictOf(templates, 'Mid', 'Mid-Export').kind).toBe('no');
  });

  it('follows EVERY owner of a duplicated export name, not just the first', async () => {
    // Two stacks declare one export name. Insertion order puts the NON-secret
    // twin first, so a single-owner index (first writer wins) follows it, finds
    // nothing, and reports a stack clean over surviving plaintext. Scrub reads
    // TEMPLATES, where a duplicate is routine (never deployed, or deployed to
    // two regions), so the over-approximation is the only safe reading.
    const templates = new Map<string, CloudFormationTemplate>([
      ['Mid', tpl({ Out: reexport('Mid-Export', { 'Fn::ImportValue': 'Shared-Export' }) })],
      ['PlainTwin', tpl({ Out: reexport('Shared-Export', { Ref: 'SomeBucket' }) })],
      ['SecretTwin', tpl({ Out: reexport('Shared-Export', EXPR) })],
    ]);

    expect(verdictOf(templates, 'Mid', 'Mid-Export')).toEqual({
      kind: 'chained',
      via: ['SecretTwin'],
    });
  });

  it('names the NEAREST secret-bearing stack when two paths reach one (diamond)', async () => {
    // Both branches of the diamond end at a secret-bearing stack, one hop apart.
    // BFS visits the nearer frame first, so the stack the message names is
    // decided by DISTANCE rather than by object key order.
    const templates = new Map<string, CloudFormationTemplate>([
      [
        'Mid',
        tpl({
          Out: reexport('Mid-Export', {
            'Fn::Join': [
              '',
              [{ 'Fn::ImportValue': 'Far-Export' }, { 'Fn::ImportValue': 'Near-Export' }],
            ],
          }),
        }),
      ],
      ['Far', tpl({ Out: reexport('Far-Export', { 'Fn::ImportValue': 'Deep-Export' }) })],
      ['Deep', tpl({ Out: reexport('Deep-Export', EXPR) })],
      ['Near', tpl({ Out: reexport('Near-Export', EXPR) })],
    ]);

    const verdict = verdictOf(templates, 'Mid', 'Mid-Export');
    expect(verdict.kind).toBe('chained');
    expect(verdict.via).toEqual(['Near']);
  });

  it('takes only the FALSE branch of an Fn::If, and no branch of a malformed one', async () => {
    // The condition belongs to ANOTHER stack, which scrub never evaluates, so
    // the walk mirrors `resolveIf`'s unknown-condition arm. Both polarities in
    // one case, because the pair is the whole point: a hop in the FALSE branch
    // is followed, one that exists ONLY in the TRUE branch is not.
    const root = tpl({ Out: reexport('Root-Export', EXPR) });
    const plain = tpl({ Out: reexport('Plain-Export', { Ref: 'SomeBucket' }) });
    const withIf = (ifTrue: unknown, ifFalse: unknown): CloudFormationTemplate =>
      tpl({ Out: reexport('Mid-Export', { 'Fn::If': ['IsProd', ifTrue, ifFalse] }) });
    const build = (mid: CloudFormationTemplate): Map<string, CloudFormationTemplate> =>
      new Map<string, CloudFormationTemplate>([
        ['Mid', mid],
        ['Root', root],
        ['Plain', plain],
      ]);

    // FALSE branch carries the re-export -> followed.
    expect(
      verdictOf(
        build(withIf({ 'Fn::ImportValue': 'Plain-Export' }, { 'Fn::ImportValue': 'Root-Export' })),
        'Mid',
        'Mid-Export'
      )
    ).toEqual({ kind: 'chained', via: ['Root'] });

    // TRUE branch only -> NOT followed. A refusal here could never be cleared:
    // nothing can turn the producer's non-secret stored value into an
    // expression, and there is no bypass flag.
    expect(
      verdictOf(
        build(withIf({ 'Fn::ImportValue': 'Root-Export' }, { 'Fn::ImportValue': 'Plain-Export' })),
        'Mid',
        'Mid-Export'
      ).kind
    ).toBe('no');

    // MALFORMED (not a 3-tuple) -> no hop from either arm, since which one is
    // live is unknowable and this function's only output is refuse-or-not.
    const malformed = tpl({
      Out: reexport('Mid-Export', { 'Fn::If': [{ 'Fn::ImportValue': 'Root-Export' }] }),
    });
    expect(verdictOf(build(malformed), 'Mid', 'Mid-Export').kind).toBe('no');
  });

  it('yields no hop for EVERY malformed Fn::If shape, not only the 1-element one', async () => {
    // The `Array.isArray(args) && args.length === 3` guard has four ways to be
    // false and only one of them was pinned. A shape that slipped past it would
    // fall through to the generic child walk — which is exactly the both-arms
    // behaviour the guard exists to prevent, reachable again through a
    // malformed node.
    const root = tpl({ Out: reexport('Root-Export', EXPR) });
    const midWith = (args: unknown): CloudFormationTemplate =>
      tpl({ Out: reexport('Mid-Export', { 'Fn::If': args }) });
    const hop = { 'Fn::ImportValue': 'Root-Export' };

    for (const args of [
      [hop, hop], // 2-tuple
      ['IsProd', hop, hop, hop], // 4-tuple
      hop, // not an array at all
      'IsProd', // a bare string
      null,
    ]) {
      const templates = new Map<string, CloudFormationTemplate>([
        ['Mid', midWith(args)],
        ['Root', root],
      ]);
      expect(verdictOf(templates, 'Mid', 'Mid-Export').kind).toBe('no');
    }

    // ...and the CONTROL: the same hop in a WELL-FORMED node's false arm is
    // still followed, so the loop above is not passing because hops stopped
    // working altogether.
    const wellFormed = new Map<string, CloudFormationTemplate>([
      ['Mid', midWith(['IsProd', 'unused', hop])],
      ['Root', root],
    ]);
    expect(verdictOf(wellFormed, 'Mid', 'Mid-Export')).toEqual({
      kind: 'chained',
      via: ['Root'],
    });
  });
});

/**
 * The refusal WORDING, over verdict shapes the walk does not produce today
 * (issue #2146 review).
 *
 * Two of these are unreachable from the command surface and are the reason this
 * block calls the wording builder directly: a `chained` verdict with an EMPTY
 * `via` (the arm that used to fall through to the widened "could not say which",
 * which is false of every chained verdict), and a `via` that names the DIRECT
 * PRODUCER — real walk output, since the visited set is keyed by `(stack, key)`
 * and a chain may return to a stack under a different output key.
 */
describe('the plaintext-producer refusal wording (issue #2146 review)', () => {
  const KEY = 'App:DbSecret';

  it('DECLARED names the key and prescribes one command', async () => {
    const { templateClaim, remedy } = scrubRefusalWording({ kind: 'declared', via: [] }, KEY, 'P', []);

    expect(templateClaim).toBe(`declares '${KEY}' from a {{resolve:...}} expression`);
    expect(remedy).toBe("Scrub the producer first ('cdkd scrub P')");
  });

  it('WIDENED without a chain keeps both halves of its hedge', async () => {
    const { templateClaim, remedy } = scrubRefusalWording({ kind: 'widened', via: [] }, KEY, 'P', []);

    expect(templateClaim).toContain('publishes at least one output from a {{resolve:...}} expression');
    expect(templateClaim).toContain(`could not match '${KEY}' to a declared output`);
    expect(remedy).toBe("Scrub the producer first ('cdkd scrub P')");
  });

  it('WIDENED with a chain says the output RE-EXPORTS one, and still hedges', async () => {
    const { templateClaim, remedy } = scrubRefusalWording(
      { kind: 'widened', via: ['R'] },
      KEY,
      'P',
      ['R']
    );

    // The hedge survives — this key still matched no declared output ...
    expect(templateClaim).toContain('could not match');
    // ... but the claim no longer says an output of P carries the expression,
    // which is the thing the walk proved false about P.
    expect(templateClaim).toContain("publishes at least one output that RE-EXPORTS a value 'R'");
    expect(templateClaim).not.toContain('output from a {{resolve:...}} expression');
    expect(remedy).toBe(
      "Scrub the producers first, from the head of the chain ('cdkd scrub R', then 'cdkd scrub P')"
    );
  });

  it('CHAINED with an empty via does NOT borrow the widened hedge', async () => {
    // Unreachable today (`chained` only returns from a non-root frame, whose
    // `via` has at least one entry), and the arm that caught it was the widened
    // wording — which asserts "could not match '<key>' to a declared output",
    // false of every chained verdict by construction, since a chained one
    // MATCHED the key and left through its value.
    const { templateClaim } = scrubRefusalWording({ kind: 'chained', via: [] }, KEY, 'P', []);

    expect(templateClaim).toContain(`publishes '${KEY}' by RE-EXPORTING a value`);
    expect(templateClaim).not.toContain('could not match');
    expect(templateClaim).not.toContain('at least one output');
  });

  it('a chain that RETURNS to the producer names each command once', async () => {
    // `A -> B -> A`: the walk left A under the consumer's key and found the
    // expression in ANOTHER of A's outputs. Both halves must survive: the claim
    // still names A (B declares nothing), and the remedy runs each command once.
    const { templateClaim, remedy } = scrubRefusalWording(
      { kind: 'chained', via: ['B', 'A'] },
      KEY,
      'A',
      ['B', 'A']
    );

    expect(templateClaim).toContain(`by RE-EXPORTING a value that 'A' declares`);
    expect(templateClaim).toContain("(through 'B')");
    expect(remedy).toBe(
      "Scrub the producers first, from the head of the chain ('cdkd scrub B', then 'cdkd scrub A')"
    );
    // THE ASSERTION: no command is repeated, and the DIRECT producer is last.
    const commands = [...remedy.matchAll(/'cdkd scrub ([^']+)'/g)].map((m) => m[1]);
    expect(commands).toEqual(['B', 'A']);
  });

  it('a SELF-import chain collapses to one command and no "through" list', async () => {
    // `A -> A`: same stack, different output key. Left undeduplicated this read
    // "producer 'A' ... a value that 'A' declares ... (through 'A')" with
    // `cdkd scrub A` twice.
    const { templateClaim, remedy } = scrubRefusalWording(
      { kind: 'chained', via: ['A', 'A'] },
      KEY,
      'A',
      ['A', 'A']
    );

    expect(templateClaim).toContain(`by RE-EXPORTING a value that 'A' declares`);
    expect(templateClaim).not.toContain('(through');
    expect(remedy).toBe("Scrub the producer first ('cdkd scrub A')");
  });

  it('a three-stack chain keeps every distinct stack, in scrub order', async () => {
    // The control for the two de-duplication cases above: nothing is dropped
    // when nothing repeats.
    const { remedy } = scrubRefusalWording({ kind: 'chained', via: ['B', 'C', 'R'] }, KEY, 'P', [
      'B',
      'C',
      'R',
    ]);

    expect([...remedy.matchAll(/'cdkd scrub ([^']+)'/g)].map((m) => m[1])).toEqual([
      'R',
      'C',
      'B',
      'P',
    ]);
  });
});

/**
 * WHICH ARM DECLINED, said out loud (issue
 * [#2163](https://github.com/go-to-k/cdkd/issues/2163)).
 *
 * `readOne` is the one function whose job is to decide whether a stack may be
 * reported clean, and FIVE of its outcomes used to return without saying
 * anything. Issue #2163 named three of them (`!producer`, the
 * `producerTemplates` miss, and a `no` verdict) and reasoned from "every arm
 * that classifies and then declines logs a debug line" that the failing live run
 * must have taken one of those three. That premise was FALSE: the `!stored` arm
 * and the healthy `carriesDynamicReference(stored)` arm were silent too, so the
 * absence of a debug line ruled out nothing. All five now name themselves.
 *
 * The fixture below is not hand-shaped: `PRODUCER_OUTPUTS` and `CONSUMER_PROPS`
 * are the templates `aws-cdk-lib` actually synthesizes for
 * `tests/integration/cross-stack-secret-import/`, with the #2163 arm's second
 * conditional export (`Fn::If` whose FALSE -- selected -- branch carries the
 * expression) added the same way the fixture builds its first one. The producer
 * STATE is deploy-shaped too: v9, every output stored under BOTH its output name
 * and its `Export.Name` alias, `exportNames` listing only the aliases.
 */
describe('cdkd scrub names WHICH arm declined a cross-stack read (issue #2163)', () => {
  const P = 'CdkdCrossStackSecretProducer';
  /** The `{{resolve:...}}` the CDK fixture emits, trailing `::` and all. */
  const SECRET_URI =
    '{{resolve:secretsmanager:cdkd-crossstack-secret-import:SecretString:password::}}';
  /** The producer's secret, as `verify.sh`'s per-run `EXPECTED_PLAINTEXT`. */
  const RUN_PLAINTEXT = 'integ-1934-20260826';
  const TAKEN_EXPORT = 'CdkdCrossStackConditionalTakenSecret';
  const TAKEN_OUTPUT = 'CrossStackConditionalTakenSecretOutput';
  const UNTAKEN_EXPORT = 'CdkdCrossStackConditionalSecret';
  const PLAIN_BRANCH = 'crossstack-conditional-plain-branch';

  /**
   * What `cdk synth` emits for the producer fixture, plus the #2163 arm --
   * re-indented to this file's style rather than pasted verbatim, so the shape
   * is the fixture's and the formatting is the repo's. Every key, every value
   * and the `Fn::If` argument ORDER are the synthesized ones; that order is the
   * only load-bearing part, since `selectTakenConditionalBranches` keys on it.
   */
  const PRODUCER_OUTPUTS = {
    CrossStackSecretArnOutput: { Value: { Ref: 'CrossStackSecret500993CD' } },
    CrossStackConditionalSecretOutput: {
      Value: {
        'Fn::If': ['CrossStackUseSecretBranch', SECRET_URI, PLAIN_BRANCH],
      },
      Export: { Name: UNTAKEN_EXPORT },
    },
    CrossStackConditionalTakenSecretOutput: {
      Value: {
        'Fn::If': [
          'CrossStackUseSecretBranch',
          'crossstack-conditional-decoy-branch',
          SECRET_URI,
        ],
      },
      Export: { Name: TAKEN_EXPORT },
    },
    CrossStackSecretPasswordOutput: {
      Value: SECRET_URI,
      Export: { Name: 'CdkdCrossStackSecretPassword' },
    },
  } as unknown as Record<string, unknown>;

  /** What `cdk synth` emits for the consumer's SSM parameter, same treatment. */
  const CONSUMER_PROPS = {
    Description: {
      'Fn::Join': [
        '',
        [
          'Imported. Conditional export resolved to: ',
          { 'Fn::ImportValue': UNTAKEN_EXPORT },
          ' Taken conditional export resolved to: ',
          { 'Fn::ImportValue': TAKEN_EXPORT },
        ],
      ],
    },
    Name: '/cdkd-integ/x',
    Type: 'String',
    Value: { 'Fn::ImportValue': 'CdkdCrossStackSecretPassword' },
  } as unknown as Record<string, unknown>;

  /** The producer's `state.outputs` as a real deploy writes it. */
  function producerOutputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      CrossStackSecretArnOutput:
        'arn:aws:secretsmanager:us-east-1:111122223333:secret:cdkd-crossstack-AbCdEf',
      CrossStackConditionalSecretOutput: PLAIN_BRANCH,
      [UNTAKEN_EXPORT]: PLAIN_BRANCH,
      [TAKEN_OUTPUT]: SECRET_URI,
      [TAKEN_EXPORT]: SECRET_URI,
      CrossStackSecretPasswordOutput: SECRET_URI,
      CdkdCrossStackSecretPassword: SECRET_URI,
      ...overrides,
    };
  }

  function useProducerState(outputs: Record<string, unknown>): void {
    stateBackend.listStacks.mockResolvedValue([{ stackName: P, region: REGION }]);
    stateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === P) {
        return Promise.resolve({
          state: {
            version: 9,
            region: REGION,
            stackName: P,
            resources: {},
            outputs,
            exportNames: [UNTAKEN_EXPORT, TAKEN_EXPORT, 'CdkdCrossStackSecretPassword'],
            lastModified: 0,
          } as StackState,
          etag: 'p-1',
        });
      }
      if (stackName === CONSUMER) return Promise.resolve({ state: consumerState, etag: 'c-1' });
      return Promise.resolve(null);
    });
  }

  const producerStack = {
    stackName: P,
    dependencyNames: [],
    template: {
      Resources: {},
      Conditions: { CrossStackUseSecretBranch: { 'Fn::Equals': ['a', 'b'] } },
      Outputs: PRODUCER_OUTPUTS,
    } as unknown as CloudFormationTemplate,
  };

  beforeEach(() => {
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: RUN_PLAINTEXT }),
    });
    useProducerState(producerOutputs());
  });

  it('the TAKEN Fn::If branch of a CDK-SYNTHESIZED export refuses when the producer stores the plaintext', async () => {
    // THE #2163 SHAPE, end to end and on the real templates: the producer's
    // second conditional export puts the expression in the FALSE arm -- index
    // 2, which `selectTakenConditionalBranches` takes UNCONDITIONALLY, mirroring
    // `resolveIf`'s unknown-condition arm. Scrub never evaluates a PRODUCER's
    // `Conditions`, so the fixture's false condition does not make that branch
    // live; it only makes the approximation agree with what the deploy selected.
    // The producer's state has been seeded back to the pre-#1899 plaintext under
    // BOTH keys. `cdkd scrub <consumer>` must exit 2 naming that export, not
    // exit 0 over a producer that still holds it in the clear.
    useProducerState(producerOutputs({ [TAKEN_OUTPUT]: RUN_PLAINTEXT, [TAKEN_EXPORT]: RUN_PLAINTEXT }));

    const err = await scrub(CONSUMER_PROPS, { appStacks: [producerStack] }).catch(
      (e: unknown) => e
    );

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT');
    // THE export, by name: the fixture imports three, and two of them must NOT
    // be the subject. Naming only the code would pass on a refusal raised over
    // `CdkdCrossStackSecretPassword`, whose producer value is healthy here.
    expect((err as Error).message).toContain(`declares '${TAKEN_EXPORT}'`);
    expect((err as Error).message).toContain(`producer stack '${P}'`);
    // The read that refused is the one nested in the `Fn::Join`, not the bare
    // `Value` import -- the position the live arm placed it in.
    expect((err as Error).message).toContain("Description['Fn::Join']");
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // ... and it did not leak the secret it just classified.
    expect((err as Error).message).not.toContain(RUN_PLAINTEXT);
  });

  it('NEGATIVE CONTROL: the same fixture with the producer SCRUBBED does not refuse, and says why it declined', async () => {
    // The other polarity of the case above, and what tells a NARROWING of the
    // refusal from a REMOVAL of it: leave the producer's stored value as the
    // expression and the identical template must scrub normally. The debug line
    // is asserted too -- it is the arm issue #2163's premise assumed was loud
    // and which was in fact silent.
    //
    // The consumer record carries this run's plaintext, so "did not refuse" is
    // backed by a POSITIVE marker: the leaf is rewritten to the expression. A
    // bare "no throw" is also what a run that died before the rewrite produces.
    consumerState = makeConsumerState({ Value: RUN_PLAINTEXT });

    const res = await scrub(CONSUMER_PROPS, { appStacks: [producerStack] });

    expect(res.recordsChanged).toBe(1);
    expect(savedState().resources['Db']!.properties['Value']).toBe(SECRET_URI);
    expect(logLines.join('\n')).toContain(
      `stored value for '${TAKEN_EXPORT}' already carries a {{resolve:...}} expression`
    );
  });

  it('the UNTAKEN branch still declines, and now says the template declares no expression for it', async () => {
    // #2164's narrowing, re-asserted from the logging side: the export whose
    // expression sits in the arm scrub does NOT select verdicts `no`, and that
    // decline is the one a reader has to be able to tell apart from the two
    // above.
    await scrub(CONSUMER_PROPS, { appStacks: [producerStack] });

    expect(logLines.join('\n')).toContain(
      `declares no {{resolve:...}} expression for '${UNTAKEN_EXPORT}'`
    );
  });

  it('a producer OUTSIDE the app declines by name rather than silently', async () => {
    // The `producerTemplates` miss. Nothing about the read changed -- only that
    // scrub holds no template for the stack that answered it -- so the outcome
    // is the documented residual, and the point of the line is that the residual
    // is now visible in one run instead of inferred over four.
    await scrub(CONSUMER_PROPS, { appStacks: [] });

    expect(logLines.join('\n')).toContain(`which is not a stack of this app`);
    expect(logLines.join('\n')).toContain(`classify export '${TAKEN_EXPORT}' with`);
  });

  it('a CloudFormation-sourced export declines by name, which is the arm that reports NO producer at all', async () => {
    // The `!producer` arm, and the only one of the three #2163 named that is
    // reachable without a stale exports index: `resolveImportValue` falls back
    // to CloudFormation `ListExports`, which is a WEAK reference and records
    // nothing -- so scrub has no producer to classify and cannot refuse. That
    // is the arm whose silence looks identical to "there was nothing to find".
    stateBackend.listStacks.mockResolvedValue([]);
    stateBackend.getState.mockImplementation((stackName: string) =>
      stackName === CONSUMER
        ? Promise.resolve({ state: consumerState, etag: 'c-1' })
        : Promise.resolve(null)
    );
    cfnSends.length = 0;
    secretResponses.set('cloudformation|ListExportsCommand', {
      Exports: [
        { Name: UNTAKEN_EXPORT, Value: PLAIN_BRANCH },
        { Name: TAKEN_EXPORT, Value: RUN_PLAINTEXT },
        { Name: 'CdkdCrossStackSecretPassword', Value: RUN_PLAINTEXT },
      ],
    });

    const res = await scrub(CONSUMER_PROPS, { appStacks: [producerStack] });

    // No refusal -- a CFn-managed producer is a weak reference by design.
    // EXACT, where the first cut wrote `toBeGreaterThanOrEqual(0)`, which no
    // run can fail (issue #2163 review). The fallback records no needle, so
    // this run finds nothing and rewrites nothing -- and a future change that
    // made this arm start refusing, or start recording, has to say so here.
    expect(res).toEqual({
      recordsChanged: 0,
      secretsFound: 0,
      secretBearingKeys: 0,
      unverifiableReads: 0,
    });
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('recorded no cdkd cross-stack read for it');
  });
});
