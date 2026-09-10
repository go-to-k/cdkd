import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  scrubResourceRecord,
  redactSecretsForState,
  SECRET_MASK,
  STATE_SOURCED_BASELINE_RULES,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Logger silenced.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

// A secret-aware mock resolver. It resolves a `{ __resolveSecret: [plaintext,
// expr] }` sentinel to the PLAINTEXT (what the AWS provider must receive) AND
// records (plaintext -> expr) into ctx.recordedSecretValues, exactly as the
// real resolver does for a {{resolve:secretsmanager:...}} reference. This lets
// the test prove the deploy engine PERSISTS the expression while the AWS call
// gets the plaintext.
function resolveWithSecrets(value: unknown, ctx: { recordedSecretValues?: Map<string, string> }): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__resolveSecret' in obj) {
      const [plaintext, expr] = obj['__resolveSecret'] as [string, string];
      ctx.recordedSecretValues?.set(plaintext, expr);
      return plaintext;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveWithSecrets(v, ctx);
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - resolved secrets are redacted out of persisted state (GHSA fix)', () => {
  const stackName = 'secret-redaction-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    loadRollbackJournal: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Idp']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('CREATE: persists the {{resolve:...}} expression in state while the AWS call gets the plaintext', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockResolvedValue({
      physicalId: 'idp-phys',
      // Readback-style attribute that echoes the resolved secret (the Cognito
      // ProviderDetails.client_secret case): must be redacted in state too.
      attributes: { ProviderDetails: { client_secret: SECRET_PLAINTEXT } },
    });
    // observedProperties also echoes the secret (async capture drain path).
    mockProvider.readCurrentState.mockResolvedValue({
      ProviderName: 'oidc',
      ProviderDetails: { client_secret: SECRET_PLAINTEXT },
    });

    const desiredProps = {
      ProviderName: 'oidc',
      ProviderDetails: {
        client_id: 'public-client-id',
        client_secret: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: {
        Idp: { Type: 'AWS::Cognito::UserPoolIdentityProvider', Properties: desiredProps },
      },
      // A CfnOutput whose Value resolves a secret (the anti-pattern the code
      // review flagged) must also be redacted in persisted outputs.
      Outputs: {
        LeakedSecret: { Value: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] } },
        PublicOut: { Value: 'not-a-secret' },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.created).toBe(1);

    // The AWS provider call received the RESOLVED plaintext (so the real
    // secret reaches AWS).
    const createArgs = mockProvider.create.mock.calls[0]!;
    const createdProps = createArgs[2] as Record<string, unknown>;
    expect((createdProps['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_PLAINTEXT
    );

    // Persisted state holds the EXPRESSION, never the plaintext — across
    // properties, attributes, AND observedProperties.
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const record = savedState.resources['Idp']!;
    expect((record.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_EXPR
    );
    // Non-secret sibling is untouched.
    expect((record.properties['ProviderDetails'] as Record<string, unknown>)['client_id']).toBe(
      'public-client-id'
    );
    expect(
      (record.attributes!['ProviderDetails'] as Record<string, unknown>)['client_secret']
    ).toBe(SECRET_EXPR);
    expect(
      (record.observedProperties!['ProviderDetails'] as Record<string, unknown>)['client_secret']
    ).toBe(SECRET_EXPR);

    // Outputs are redacted too: the secret-valued output holds the expression,
    // the public output is untouched.
    expect(savedState.outputs['LeakedSecret']).toBe(SECRET_EXPR);
    expect(savedState.outputs['PublicOut']).toBe('not-a-secret');

    // Hard invariant: the plaintext must appear NOWHERE in the serialized state.
    expect(JSON.stringify(savedState)).not.toContain(SECRET_PLAINTEXT);
  });

  it('does NOT redact one resource literal that equals a secret another resource resolved (per-resource scoping)', async () => {
    // The exact false-positive the secrets-dynamic-ref integ caught: resource A
    // (a Lambda) resolves a WHOLE-SECRET reference to value V; resource B (the
    // AWS::SecretsManager::Secret that owns it) carries V as its own LITERAL
    // property. A session-wide value scan would rewrite B's literal to A's
    // expression — a spurious perpetual diff. Per-resource scoping must leave
    // B's literal intact while redacting A's reference.
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockResolvedValue({ physicalId: 'p' });
    mockProvider.readCurrentState.mockResolvedValue(undefined);

    const wholeSecretExpr = '{{resolve:secretsmanager:my-secret:SecretString::}}';
    const secretJson = '{"username":"u","password":"cdkd-known-pw"}';

    // Two resources provisioned in one deploy (two DAG entries).
    mockDagBuilder.getExecutionLevels.mockReturnValue([['TheSecret', 'TheLambda']]);
    const changes = new Map<string, ResourceChange>([
      [
        'TheSecret',
        {
          logicalId: 'TheSecret',
          changeType: 'CREATE',
          resourceType: 'AWS::SecretsManager::Secret',
          // Literal secret value (unsafePlainText) — NOT a dynamic reference.
          desiredProperties: { SecretString: secretJson },
        },
      ],
      [
        'TheLambda',
        {
          logicalId: 'TheLambda',
          changeType: 'CREATE',
          resourceType: 'AWS::Lambda::Function',
          // Whole-secret reference that resolves to the SAME JSON string.
          desiredProperties: {
            Environment: { Variables: { FULL: { __resolveSecret: [secretJson, wholeSecretExpr] } } },
          },
        },
      ],
    ]);
    mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

    const template: CloudFormationTemplate = {
      Resources: {
        TheSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { SecretString: secretJson } },
        TheLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: { Variables: { FULL: { __resolveSecret: [secretJson, wholeSecretExpr] } } },
          },
        },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    // The Lambda's reference IS redacted to the expression.
    expect(
      (
        (savedState.resources['TheLambda']!.properties['Environment'] as Record<string, unknown>)[
          'Variables'
        ] as Record<string, unknown>
      )['FULL']
    ).toBe(wholeSecretExpr);
    // The secret's OWN literal is UNTOUCHED (no false-positive over-redaction).
    expect(savedState.resources['TheSecret']!.properties['SecretString']).toBe(secretJson);
  });

  it('does not redact anything when no secret was resolved (identity path)', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockResolvedValue({ physicalId: 'phys' });
    mockProvider.readCurrentState.mockResolvedValue(undefined);

    const desiredProps = { Name: 'plain', Nested: { Value: 'also-plain' } };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Idp: { Type: 'AWS::S3::Bucket', Properties: desiredProps } },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(savedState.resources['Idp']!.properties).toEqual({
      Name: 'plain',
      Nested: { Value: 'also-plain' },
    });
  });

  it('masks a resolved secret out of a recorded deployment event error message', async () => {
    // A provider failure whose error message echoes the resolved property (an
    // AWS "InvalidParameter: <value> rejected" shape) would otherwise carry the
    // plaintext into the persisted deployments/ event stream. The secret is
    // recorded during resolution (before the create call), so even a failed
    // CREATE has a per-resource secrets map to mask the event with.
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockRejectedValue(
      new Error(`InvalidParameterException: client_secret '${SECRET_PLAINTEXT}' was rejected`)
    );

    const desiredProps = {
      ProviderName: 'oidc',
      ProviderDetails: {
        client_secret: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Idp: { Type: 'AWS::Cognito::UserPoolIdentityProvider', Properties: desiredProps },
      },
    };

    const recorded: unknown[] = [];
    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, eventRecorder: { record: (e: unknown) => recorded.push(e) } as never },
      'us-east-1'
    );
    // The deploy fails (one resource errored); we only care about the events.
    await engine.deploy(stackName, template).catch(() => undefined);

    expect(recorded.length).toBeGreaterThan(0);
    // Hard invariant: the plaintext appears in NONE of the recorded events.
    expect(JSON.stringify(recorded)).not.toContain(SECRET_PLAINTEXT);
    // And the failure event that carried the secret in its message was masked
    // (not merely absent) — prove the mask token is present where the value was.
    const failedWithSecretText = recorded.find(
      (e) =>
        typeof (e as { error?: { message?: string } }).error?.message === 'string' &&
        (e as { error: { message: string } }).error.message.includes('client_secret')
    ) as { error: { message: string } } | undefined;
    expect(failedWithSecretText).toBeDefined();
    expect(failedWithSecretText!.error.message).toContain('***');
  });

  it('redacts a resolved secret out of the rollback-journal segment (failed op attemptedProperties)', async () => {
    // The rollback journal is built from the in-memory working map, which does
    // NOT pass through the state-save choke point — so a failed CREATE's
    // attemptedProperties would carry the resolved plaintext into
    // rollback-journal.json unless redactOperationsForJournal masks it.
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockRejectedValue(new Error('AWS rejected the CREATE'));

    const desiredProps = {
      ProviderName: 'oidc',
      ProviderDetails: {
        client_id: 'public-client-id',
        client_secret: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Idp: { Type: 'AWS::Cognito::UserPoolIdentityProvider', Properties: desiredProps },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template).catch(() => undefined);

    expect(mockStateBackend.appendRollbackJournalSegment).toHaveBeenCalled();
    const segment = mockStateBackend.appendRollbackJournalSegment.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ attemptedProperties?: Record<string, unknown> }>;
    };
    // Hard invariant: the plaintext appears NOWHERE in the serialized journal.
    expect(JSON.stringify(segment)).not.toContain(SECRET_PLAINTEXT);
    // And the attempted-secret member holds the expression, not the plaintext,
    // while the public sibling is untouched.
    const attempted = segment.failedOperations![0]!.attemptedProperties!['ProviderDetails'] as Record<
      string,
      unknown
    >;
    expect(attempted['client_secret']).toBe(SECRET_EXPR);
    expect(attempted['client_id']).toBe('public-client-id');
  });
});

// ---------------------------------------------------------------- #2886 --

describe('the deploy journal previousState is a REPLAYED baseline, not a fresh one (issue #2886)', () => {
  // The #2852 fail-closed refusal is keyed on the DESTINATION: a bag that
  // BECOMES a drift baseline masks every position it cannot certify, while the
  // journal's `previousState` — a snapshot of a bag that ALREADY sits in
  // `state.json` — must not gain masks, because `replayRollback` restores that
  // record wholesale and the masks would land in `state.json` as permanent
  // phantom drift on a baseline that was intact before the deploy.
  //
  // BOTH directions are pinned HERE, in one file, so a future edit cannot
  // satisfy one and drop the other: the journal call site passes
  // `STATE_SOURCED_READBACK_RULES` explicitly (case 1), while the SAME record
  // through the same choke point's DERIVATION (the deploy persist path's
  // issue-1900 walk, and `cdkd state refresh-observed`'s declared constant)
  // still masks (cases 2 and 3).

  // Issue #2852's ancestor-reshaped shape: the source spells a reference at
  // `A.B`, the readback reshaped `A` into an array — a position the walk
  // cannot certify, so the BASELINE destination masks it.
  const JOURNAL_EXPR = '{{resolve:secretsmanager:journal-secret:SecretString:pw::}}';
  const UNCERTIFIABLE_LIVE = 'journal-live-uncertifiable-value';
  function replayedRecord() {
    return {
      physicalId: 'db-1',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { A: { B: JOURNAL_EXPR } },
      observedProperties: { A: [UNCERTIFIABLE_LIVE] },
    };
  }

  function makeBareEngine(): DeployEngine {
    return new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('an op with previousState and an EMPTY secrets map keeps observedProperties UNMASKED in the journal', () => {
    // The engine resolved nothing for this logicalId (a DELETE, or an UPDATE
    // with no reference of its own), so `redactOperationsForJournal` reaches
    // the scrub with an empty map — the exact call `deploy-engine.ts` admits
    // whenever `previousState` exists. Without the explicit readback constant
    // at that call site, the derivation fails closed and this masks.
    const engine = makeBareEngine();
    const redact = (
      engine as unknown as {
        redactOperationsForJournal: <T>(ops: T[]) => T[];
      }
    ).redactOperationsForJournal.bind(engine);

    const [redacted] = redact([
      {
        logicalId: 'Db',
        resourceType: 'AWS::RDS::DBInstance',
        changeType: 'DELETE',
        previousState: replayedRecord(),
      } as never,
    ]) as Array<{ previousState: { observedProperties: Record<string, unknown> } }>;

    expect(redacted!.previousState.observedProperties).toEqual({ A: [UNCERTIFIABLE_LIVE] });
    expect(JSON.stringify(redacted)).not.toContain(SECRET_MASK);
  });

  it('...while the SAME record through the empty-map DERIVATION still masks (the baseline destination)', () => {
    // The other half of the pair: the deploy persist choke point (the
    // issue-1900 unchanged-resource walk) derives the fail-closed constant for
    // an empty map, and that must SURVIVE the journal fix — weakening the
    // derivation instead of passing the constant at the journal call site
    // would re-open GHSA-p5qg-v9gv-hc7w and reds this case.
    const scrubbed = scrubResourceRecord(replayedRecord(), new Map<string, string>());

    expect(scrubbed.observedProperties).toEqual({ A: [SECRET_MASK] });
    expect(JSON.stringify(scrubbed)).not.toContain(UNCERTIFIABLE_LIVE);
  });

  it('...and a POPULATED map still redacts the journal previousState — the scrub is ALIVE', () => {
    // The negative the two cases above cannot carry: an UNMASKED bag is also
    // what a DELETED scrub produces, so without this row replacing the whole
    // call with `next.previousState = next.previousState` stays green. A
    // NoEcho mask-only needle recorded by THIS deploy (the
    // `registerNoEchoAttributes` -> `recordMaskOnlyValuesIn` path fills
    // `perResourceSecrets`, the same map the journal scrub receives) must
    // still be masked out of the journaled snapshot.
    const NOECHO_PLAINTEXT = 'journal-noecho-plaintext-2886';
    const engine = makeBareEngine();
    (
      engine as unknown as { perResourceSecrets: Map<string, Map<string, string>> }
    ).perResourceSecrets.set('Db', new Map([[NOECHO_PLAINTEXT, SECRET_MASK]]));
    const redact = (
      engine as unknown as {
        redactOperationsForJournal: <T>(ops: T[]) => T[];
      }
    ).redactOperationsForJournal.bind(engine);

    const [redacted] = redact([
      {
        logicalId: 'Db',
        resourceType: 'AWS::RDS::DBInstance',
        changeType: 'DELETE',
        previousState: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: {
            MasterUserPassword: NOECHO_PLAINTEXT,
            DBInstanceClass: 'db.t3.micro',
          },
        },
      } as never,
    ]) as Array<{ previousState: { properties: Record<string, unknown> } }>;

    expect(redacted!.previousState.properties['MasterUserPassword']).toBe(SECRET_MASK);
    expect(JSON.stringify(redacted)).not.toContain(NOECHO_PLAINTEXT);
    // The public sibling is untouched — the scrub redacts, it does not erase.
    expect(redacted!.previousState.properties['DBInstanceClass']).toBe('db.t3.micro');
  });

  it('...and the `cdkd state refresh-observed` call shape (declared BASELINE destination) still masks', () => {
    // `state.ts` passes `STATE_SOURCED_BASELINE_RULES` itself; the
    // command-level pin is `tests/unit/cli/state-refresh-observed.test.ts`.
    // This row repeats the call SHAPE here so this one file alone pins the
    // journal/baseline split in both directions.
    const record = replayedRecord();
    const out = redactSecretsForState(
      record.observedProperties,
      new Map<string, string>(),
      record.properties,
      STATE_SOURCED_BASELINE_RULES
    );

    expect(out).toEqual({ A: [SECRET_MASK] });
    expect(JSON.stringify(out)).not.toContain(UNCERTIFIABLE_LIVE);
  });
});
