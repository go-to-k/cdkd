/**
 * go-to-k/cdkd#4847: a value served out of a persisted record is re-resolved
 * by the record's v12 `referenceProvenance`, through two INDEPENDENT arms:
 *
 * - region: the recorded region (shape-checked), otherwise today's proofs;
 * - generation: the recorded single version (a pinned lookup), otherwise
 *   today's physical-id proof, run in the chosen region.
 *
 * Driven through the REAL resolver, with a Secrets Manager / SSM double that
 * answers per region and per version.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const V1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const V2 = 'bbbbbbbb-2222-2222-2222-222222222222';
const V0 = 'cccccccc-0000-0000-0000-000000000000';

const calls = vi.hoisted(
  () =>
    [] as Array<{
      service: 'sm' | 'ssm';
      region: string;
      id: string | undefined;
      versionId?: string | undefined;
      stage?: string | undefined;
    }>
);
const warns = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((...a: unknown[]) => warns.push(a.map(String).join(' '))),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/**
 * Secret `app`: in us-west-2 V1 holds `west-q-1`, V2 (current) `west-q-2`;
 * in us-east-1 the same-named secret holds `east-q-1` at V1 and `east-q-x`
 * at V2 (current). V0 exists nowhere (a deprecated version). SSM
 * `/app/pw`: version 2 is `ssm-two-value`, version 4 (current) `ssm-four-value`.
 */
const answer = vi.hoisted(() => {
  const sm = (region: string, input: { SecretId?: string; VersionId?: string; VersionStage?: string }) => {
    calls.push({
      service: 'sm',
      region,
      id: input.SecretId,
      versionId: input.VersionId,
      stage: input.VersionStage,
    });
    // `throttled`: every read of V1 is throttled; the current one answers.
    if (input.SecretId === 'throttled') {
      if (input.VersionId !== undefined) {
        const e = new Error('Rate exceeded');
        e.name = 'ThrottlingException';
        throw e;
      }
      return { SecretString: JSON.stringify({ queue: 'thr-q-2' }), VersionId: 'bbbbbbbb-2222-2222-2222-222222222222' };
    }
    // `gone-current`: the current version cannot be read, V1 can.
    if (input.SecretId === 'gone-current') {
      if (input.VersionId === 'aaaaaaaa-1111-1111-1111-111111111111') {
        return { SecretString: JSON.stringify({ queue: 'gone-q-1' }), VersionId: input.VersionId };
      }
      const e = new Error('not authorized for the current version');
      e.name = 'AccessDeniedException';
      throw e;
    }
    if (input.SecretId !== 'app') {
      const e = new Error("Secrets Manager can't find the specified secret.");
      e.name = 'ResourceNotFoundException';
      throw e;
    }
    const version = input.VersionId ?? 'bbbbbbbb-2222-2222-2222-222222222222';
    const table: Record<string, Record<string, string>> = {
      'us-west-2': {
        'aaaaaaaa-1111-1111-1111-111111111111': 'west-q-1',
        'bbbbbbbb-2222-2222-2222-222222222222': 'west-q-2',
      },
      'us-east-1': {
        'aaaaaaaa-1111-1111-1111-111111111111': 'east-q-1',
        'bbbbbbbb-2222-2222-2222-222222222222': 'east-q-x',
      },
    };
    const queue = table[region]?.[version];
    if (queue === undefined) {
      const e = new Error("Secrets Manager can't find the specified secret value for VersionId");
      e.name = 'ResourceNotFoundException';
      throw e;
    }
    // `short`: under the needle floor, and different per region and version.
    // `short`: the current (V2) one is under the needle floor in both
    // regions; us-east-1's V1 is not, us-west-2's V1 is.
    const short =
      region === 'us-east-1'
        ? version.startsWith('a')
          ? 'abcdef'
          : 'cd'
        : version.startsWith('a')
          ? 'wa'
          : 'wc';
    const local = `${region === 'us-east-1' ? 'east' : 'west'}-local`;
    return { SecretString: JSON.stringify({ queue, short, local }), VersionId: version };
  };
  const ssm = (region: string, input: { Name?: string }) => {
    calls.push({ service: 'ssm', region, id: input.Name });
    const byName: Record<string, { Value: string; Version: number; Type?: string }> = {
      '/app/pw': { Value: 'ssm-four-value', Version: 4 },
      '/app/pw:2': { Value: 'ssm-two-value', Version: 2 },
      '/app/pw:4': { Value: 'ssm-four-value', Version: 4 },
      // Retyped: version 3 was a SecureString, the current one (5) is public.
      '/app/retyped': { Value: 'public-now', Version: 5, Type: 'String' },
      '/app/retyped:3': { Value: 'secret-three', Version: 3 },
      '/app/odd': { Value: 'odd-current', Version: 9, Type: 'Weird' },
      '/app/odd:7': { Value: 'odd-seven', Version: 7, Type: 'Weird' },
      'arn:aws:ssm:us-east-1:123456789012:parameter/app/pw:2': { Value: 'ssm-two-value', Version: 2 },
      'arn:aws:ssm:us-east-1:123456789012:parameter/app/pw:4': { Value: 'ssm-four-value', Version: 4 },
    };
    const hit = input.Name === undefined ? undefined : byName[input.Name];
    if (hit === undefined) {
      const e = new Error('ParameterVersionNotFound');
      e.name = 'ParameterVersionNotFound';
      throw e;
    }
    return { Parameter: { Type: 'SecureString', ...hit } };
  };
  return { sm, ssm };
});
const bagFor = vi.hoisted(() => {
  const make = (region: string): Record<string, unknown> => ({
    configuredRegion: region,
    credentialConfig: {},
    withRegion: (target: string) => make(target),
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: async (command: { input: Record<string, string> }) => answer.sm(region, command.input),
      config: { region: () => Promise.resolve(region) },
    },
    ssm: {
      send: async (command: { input: Record<string, string> }) => answer.ssm(region, command.input),
      config: { region: () => Promise.resolve(region) },
    },
  });
  return make;
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => bagFor('us-east-1'),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { clearRecordedSecretExpressions, markSameGenerationBag, redactSecretsForState } =
  await import('../../../src/deployment/secret-redaction.js');
const { resolvedPlaintextOf } = await import('../../../src/deployment/secret-redaction/pairs.js');
const { isRecordedSecretExpression } = await import(
  '../../../src/deployment/secret-redaction/mask-only.js'
);
const { passProvenanceFor } = await import(
  '../../../src/deployment/secret-redaction/reference-provenance.js'
);

const T = '{{resolve:secretsmanager:app:SecretString:queue::}}';
const ACCT = '123456789012';
const arnOf = (name: string): string => `arn:aws:sqs:us-east-1:${ACCT}:${name}`;
const urlOf = (name: string): string => `https://sqs.us-east-1.amazonaws.com/${ACCT}/${name}`;

/** The #4847 queue: named from a us-west-2 stack's output, read through `Fn::GetStackOutput`. */
const CROSS_REGION_NAME = {
  'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Name', Region: 'us-west-2' },
};

function queue(
  name: string,
  provenance: Record<string, unknown> | undefined,
  token = T
): ResourceState {
  return {
    physicalId: urlOf(name),
    resourceType: 'AWS::SQS::Queue',
    properties: { QueueName: token },
    attributes: { Arn: arnOf(token) },
    dependencies: [],
    ...(provenance !== undefined && { referenceProvenance: provenance }),
  } as ResourceState;
}

/** Cross-region evidence: the classifier answers `ambiguous` for a region-less token. */
const AMBIGUOUS = { regions: ['us-west-2'], complete: true };

function contextFor(
  producer: ResourceState,
  templateProps: Record<string, unknown>,
  bag: Map<string, string>,
  evidence: { regions: readonly string[]; complete: boolean } = AMBIGUOUS
) {
  return {
    template: {
      Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: templateProps } },
    } as CloudFormationTemplate,
    resources: { Queue: producer },
    parameters: {},
    conditions: {},
    recordedSecretValues: bag,
    secretRegionEvidence: () => evidence,
  };
}

async function readArn(
  producer: ResourceState,
  templateProps: Record<string, unknown> = { QueueName: CROSS_REGION_NAME },
  bag: Map<string, string> = new Map(),
  evidence?: { regions: readonly string[]; complete: boolean },
  resolver = new IntrinsicFunctionResolver('us-east-1')
): Promise<unknown> {
  return await resolver.resolve(
    { 'Fn::GetAtt': ['Queue', 'Arn'] },
    contextFor(producer, templateProps, bag, evidence) as never
  );
}

beforeEach(() => {
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  calls.length = 0;
  warns.length = 0;
});

describe('re-resolving a recorded reference by its v12 provenance (#4847)', () => {
  it('no field: today\'s path (a cross-region read leaves the region unproven, served as recorded)', async () => {
    expect(await readArn(queue('west-q-2', undefined))).toBe(arnOf(T));
    expect(calls).toEqual([]);
  });

  it('region arm only: resolved in the RECORDED region, and the physical-id proof runs there', async () => {
    const bag = new Map<string, string>();
    expect(await readArn(queue('west-q-2', { [T]: { region: 'us-west-2' } }), undefined, bag)).toBe(
      arnOf('west-q-2')
    );
    expect(calls.map((c) => c.region)).toEqual(['us-west-2']);
    expect(calls[0]!.stage).toBe('AWSCURRENT');
    // The re-resolution records on the read route, in the recorded region.
    expect(passProvenanceFor(bag, T)).toEqual({
      region: 'us-west-2',
      versions: [V2],
      readVersions: [V2],
    });
  });

  it('region arm only, rotated before the upgrade: the proof fails in the recorded region; never the same-named us-east-1 secret', async () => {
    expect(await readArn(queue('west-q-1', { [T]: { region: 'us-west-2' } }))).toBe(arnOf(T));
    expect(calls.map((c) => c.region)).toEqual(['us-west-2']);
    expect(warns.some((w) => w.includes('as recorded'))).toBe(true);
  });

  it('both arms: the RECORDED version is read in the recorded region, even after a rotation', async () => {
    const bag = new Map<string, string>();
    const resolved = await readArn(
      queue('west-q-1', { [T]: { region: 'us-west-2', versions: [V1], readVersions: [V1] } }),
      undefined,
      bag
    );
    expect(resolved).toBe(arnOf('west-q-1'));
    // The unpinned read (current V2), then the pinned one: VersionId only.
    expect(calls).toEqual([
      { service: 'sm', region: 'us-west-2', id: 'app', versionId: undefined, stage: 'AWSCURRENT' },
      { service: 'sm', region: 'us-west-2', id: 'app', versionId: V1, stage: undefined },
    ]);
    expect(passProvenanceFor(bag, T)).toEqual({
      region: 'us-west-2',
      versions: [V1],
      readVersions: [V1],
    });
    // The pinned plaintext still redacts and masks, but is not a PAIR: the
    // pair is the current value, the one the token's literal route resolves.
    expect(bag.get('west-q-1')).toBe(T);
    expect(resolvedPlaintextOf(bag, T)).toBe('west-q-2');
  });

  it('version arm only: the region keeps today\'s proof, the generation is pinned (no physical-id proof)', async () => {
    // A literal template token proves the region local; the queue was named
    // at V1 in us-east-1, where the current version is V2 (`east-q-x`).
    const resolved = await readArn(
      queue('east-q-1', { [T]: { versions: [V1] } }),
      { QueueName: T },
      new Map(),
      { regions: [], complete: true }
    );
    expect(resolved).toBe(arnOf('east-q-1'));
    expect(calls.every((c) => c.region === 'us-east-1')).toBe(true);
    expect(calls.at(-1)).toMatchObject({ versionId: V1, stage: undefined });
    expect(warns).toEqual([]);
  });

  it('version arm only, the pin gone: warns, and the physical-id proof decides', async () => {
    const resolved = await readArn(
      queue('east-q-1', { [T]: { versions: [V0] } }),
      { QueueName: T },
      new Map(),
      { regions: [], complete: true }
    );
    // The current value is not the queue's name: served as recorded.
    expect(resolved).toBe(arnOf(T));
    expect(calls.some((c) => c.versionId === V0)).toBe(true);
    expect(warns.some((w) => w.includes('deprecated or deleted'))).toBe(true);
    expect(warns.some((w) => w.includes('as recorded'))).toBe(true);
  });

  it('version arm only, pin held in this region: served at the pinned version', async () => {
    const resolved = await readArn(
      queue('east-q-x', { [T]: { versions: [V2] } }),
      { QueueName: T },
      new Map(),
      { regions: [], complete: true }
    );
    expect(resolved).toBe(arnOf('east-q-x'));
  });

  it('an invalid recorded region is ignored: today\'s proofs decide', async () => {
    for (const region of ['US-WEST-2', 'us-west-2 ', 'not a region', 42]) {
      calls.length = 0;
      expect(await readArn(queue('west-q-2', { [T]: { region } }))).toBe(arnOf(T));
      expect(calls).toEqual([]);
    }
  });

  it('a pin equal to the cached version makes no extra call', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // Today's path (no field) and the pinned path make the SAME single call.
    await readArn(
      queue('west-q-2', undefined),
      { QueueName: T },
      new Map(),
      { regions: [], complete: true },
      new IntrinsicFunctionResolver('us-west-2')
    );
    const today = calls.length;
    calls.length = 0;
    const pinned = await readArn(
      queue('west-q-2', { [T]: { region: 'us-west-2', versions: [V2] } }),
      undefined,
      new Map(),
      undefined,
      resolver
    );
    expect(pinned).toBe(arnOf('west-q-2'));
    expect(calls.length).toBe(today);
    expect(calls.length).toBe(1);
    // A second reader of the same token: no call at all.
    calls.length = 0;
    await readArn(
      queue('west-q-2', { [T]: { region: 'us-west-2', versions: [V2] } }),
      undefined,
      new Map(),
      undefined,
      resolver
    );
    expect(calls).toEqual([]);
  });

  it('a failed pin falls back to the physical-id proof in the chosen region', async () => {
    const resolved = await readArn(
      queue('west-q-2', { [T]: { region: 'us-west-2', versions: [V0] } })
    );
    // V0 is gone; the current value is the one the queue is named from.
    expect(resolved).toBe(arnOf('west-q-2'));
    expect(warns.some((w) => w.includes('deprecated or deleted'))).toBe(true);
  });

  it('SSM: the selector is stripped and the pinned version appended', async () => {
    for (const [token, expected] of [
      ['{{resolve:ssm-secure:/app/pw}}', '/app/pw:2'],
      ['{{resolve:ssm-secure:/app/pw:4}}', '/app/pw:2'],
      [
        '{{resolve:ssm-secure:arn:aws:ssm:us-east-1:123456789012:parameter/app/pw:4}}',
        'arn:aws:ssm:us-east-1:123456789012:parameter/app/pw:2',
      ],
    ] as const) {
      calls.length = 0;
      clearRecordedSecretExpressions();
      const record = {
        physicalId: 'x-ssm-two-value',
        resourceType: 'Custom::Thing',
        properties: { Value: token },
        attributes: { Out: token },
        dependencies: [],
        referenceProvenance: { [token]: { versions: ['2'] } },
      } as unknown as ResourceState;
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Out'] }, {
        ...contextFor(record, { Value: token }, new Map(), { regions: [], complete: true }),
      } as never);
      expect(resolved).toBe('ssm-two-value');
      expect(calls.at(-1)!.id).toBe(expected);
    }
  });

  it('a Ref served from a record takes the same arms', async () => {
    const record = {
      ...queue('west-q-1', { [T]: { region: 'us-west-2', versions: [V1] } }),
      physicalId: T,
    } as ResourceState;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve(
      { Ref: 'Queue' },
      contextFor(record, { QueueName: CROSS_REGION_NAME }, new Map()) as never
    );
    expect(resolved).toBe('west-q-1');
  });

  it('tokens recorded in two regions are each resolved in their own', async () => {
    const LOCAL = '{{resolve:secretsmanager:app:SecretString:short::}}';
    const record = {
      physicalId: 'west-q-2-abcdef',
      resourceType: 'Custom::Thing',
      properties: {},
      attributes: { Out: `${T}-${LOCAL}` },
      dependencies: [],
      referenceProvenance: {
        [T]: { region: 'us-west-2', versions: [V2] },
        [LOCAL]: { region: 'us-east-1', versions: [V1] },
      },
    } as unknown as ResourceState;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve(
      { 'Fn::GetAtt': ['Queue', 'Out'] },
      contextFor(record, { Name: CROSS_REGION_NAME }, new Map()) as never
    );
    // Pre-fix (one resolver for the value): `west-q-2-wa`.
    expect(resolved).toBe('west-q-2-abcdef');
    expect(new Set(calls.map((c) => c.region))).toEqual(new Set(['us-west-2', 'us-east-1']));
  });

  it('a token without a recorded region keeps today\'s region proof, beside one that has it', async () => {
    const OTHER = '{{resolve:secretsmanager:app:SecretString:short::}}';
    const record = {
      ...queue('west-q-2', { [T]: { region: 'us-west-2' } }),
      attributes: { Arn: `${arnOf(T)}/${OTHER}` },
    } as ResourceState;
    // OTHER has no recorded region, the template does not spell it, and the
    // evidence names another region: unproven, so the value is served as recorded.
    expect(await readArn(record)).toBe(`${arnOf(T)}/${OTHER}`);
    expect(calls).toEqual([]);
  });

  it("a recorded region equal to this stack's resolves here, although the deploy's evidence names another", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, {
      ...contextFor(queue('east-q-x', { [T]: { region: 'us-east-1', versions: [V2] } }), {
        QueueName: CROSS_REGION_NAME,
      }, new Map()),
      // The deploy's producer-region evidence: a region-less token would be
      // refused as ambiguous had the recorded region not settled it.
      producerRegions: ['us-west-2'],
    } as never);
    expect(resolved).toBe(arnOf('east-q-x'));
  });

  it('a failed pin falls back in a context that collects abandoned resolutions too', async () => {
    const abandonedResolutions: unknown[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, {
      ...contextFor(queue('west-q-2', { [T]: { region: 'us-west-2', versions: [V0] } }), {
        QueueName: CROSS_REGION_NAME,
      }, new Map()),
      abandonedResolutions,
    } as never);
    expect(resolved).toBe(arnOf('west-q-2'));
    expect(warns.some((w) => w.includes('deprecated or deleted'))).toBe(true);
    expect(abandonedResolutions).toEqual([]);
  });

  it('a failed pin is tried once per resolver and warned once', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    for (let i = 0; i < 3; i++) {
      await readArn(
        queue('west-q-2', { [T]: { region: 'us-west-2', versions: [V0] } }),
        undefined,
        new Map(),
        undefined,
        resolver
      );
    }
    expect(calls.filter((c) => c.versionId === V0)).toHaveLength(1);
    expect(warns.filter((w) => w.includes('deprecated or deleted'))).toHaveLength(1);
  });

  it('a THROTTLED pinned read is not memoized: the next read tries it again', async () => {
    const { dynamicReferenceRetryDelays } = await import(
      '../../../src/deployment/intrinsic-resolver/account-drain.js'
    );
    dynamicReferenceRetryDelays.sleep = () => Promise.resolve();
    const THR = '{{resolve:secretsmanager:throttled:SecretString:queue::}}';
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const pinnedReads = (): number =>
      calls.filter((c) => c.id === 'throttled' && c.versionId === V1).length;
    const read = () =>
      readArn(
        queue('thr-q-2', { [THR]: { region: 'us-west-2', versions: [V1] } }, THR),
        undefined,
        new Map(),
        undefined,
        resolver
      );
    await read();
    const first = pinnedReads();
    expect(first).toBeGreaterThan(0);
    await read();
    expect(pinnedReads()).toBe(first * 2);
  });

  it("the fourth site warns when a pinned value too short to keep out of state is not served", async () => {
    const SHORT = '{{resolve:secretsmanager:app:SecretString:short::}}';
    const row = {
      physicalId: `arn:cdkd-local:us-west-2:${ACCT}:nested-stack/Parent/Child`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: { 'Outputs.Name': SHORT },
      dependencies: [],
      // us-west-2 holds `wa` at V1: under the floor.
      referenceProvenance: { [SHORT]: { versions: [V1] } },
    } as unknown as ResourceState;
    const resolved = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Queue', 'Outputs.Name'] },
      {
        template: {
          Resources: { Queue: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
        } as CloudFormationTemplate,
        resources: { Queue: row },
        parameters: {},
        conditions: {},
        recordedSecretValues: new Map(),
      } as never
    );
    // The current value (V2: `wc`), as before this change.
    expect(resolved).toBe('wc');
    expect(warns.some((w) => w.includes('shorter than four characters'))).toBe(true);
    // The migration capture prints none of it (the deploy does).
    warns.length = 0;
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Queue', 'Outputs.Name'] },
      {
        template: {
          Resources: { Queue: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
        } as CloudFormationTemplate,
        resources: { Queue: row },
        parameters: {},
        conditions: {},
        recordedSecretValues: new Map(),
        provenanceCapture: true,
      } as never
    );
    expect(warns).toEqual([]);
  });

  it('a current version that cannot be read does not stop a pin that can', async () => {
    const GONE = '{{resolve:secretsmanager:gone-current:SecretString:queue::}}';
    const abandonedResolutions: unknown[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, {
      ...contextFor(queue('gone-q-1', { [GONE]: { region: 'us-west-2', versions: [V1] } }, GONE), {
        QueueName: CROSS_REGION_NAME,
      }, new Map()),
      abandonedResolutions,
    } as never);
    expect(resolved).toBe(arnOf('gone-q-1'));
    expect(abandonedResolutions).toEqual([]);
  });

  it('a pinned SSM read pins no verdict and contradicts no public proof (a retyped parameter)', async () => {
    const RETYPED = '{{resolve:ssm:/app/retyped}}';
    const record = {
      physicalId: 'x-secret-three',
      resourceType: 'Custom::Thing',
      properties: { Value: RETYPED },
      attributes: { Out: RETYPED },
      dependencies: [],
      referenceProvenance: { [RETYPED]: { versions: ['3'] } },
    } as unknown as ResourceState;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve(
      { 'Fn::GetAtt': ['Queue', 'Out'] },
      contextFor(record, { Value: RETYPED }, new Map(), { regions: [], complete: true }) as never
    );
    expect(resolved).toBe('secret-three');
    expect(calls.at(-1)!.id).toBe('/app/retyped:3');
    expect(isRecordedSecretExpression(RETYPED)).toBe(false);
  });

  it("a pinned SSM read's warning names the parameter as the token spells it, never the version", async () => {
    const ODD = '{{resolve:ssm:/app/odd}}';
    const record = {
      physicalId: 'x-odd-seven',
      resourceType: 'Custom::Thing',
      properties: { Value: ODD },
      attributes: { Out: ODD },
      dependencies: [],
      referenceProvenance: { [ODD]: { versions: ['7'] } },
    } as unknown as ResourceState;
    const resolved = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Queue', 'Out'] },
      contextFor(record, { Value: ODD }, new Map(), { regions: [], complete: true }) as never
    );
    expect(resolved).toBe('odd-seven');
    const typeWarns = warns.filter((w) => w.includes('unrecognized Type'));
    // One warning per (parameter, type): the pinned read shares the current one's.
    expect(typeWarns).toHaveLength(1);
    expect(typeWarns.some((w) => w.includes(':7'))).toBe(false);
  });

  it('the capture context prints no failed-pin warning (the deploy does)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, {
      ...contextFor(queue('west-q-1', { [T]: { region: 'us-west-2', versions: [V0] } }), {
        QueueName: CROSS_REGION_NAME,
      }, new Map()),
      provenanceCapture: true,
    } as never);
    expect(warns).toEqual([]);
  });

  it('a token without a recorded region proven local, beside a cross-region one: both re-resolve', async () => {
    const LOCAL = '{{resolve:secretsmanager:app:SecretString:local::}}';
    const record = {
      physicalId: 'west-q-2-east-local',
      resourceType: 'Custom::Thing',
      properties: {},
      attributes: { Out: `${T}-${LOCAL}` },
      dependencies: [],
      referenceProvenance: { [T]: { region: 'us-west-2', versions: [V2] } },
    } as unknown as ResourceState;
    // The template spells LOCAL literally and reads no other stack (LOCAL is
    // proven local); T, which it does not spell, is proven by its record only,
    // since the evidence names another region.
    const resolved = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Queue', 'Out'] },
      contextFor(record, { Tag: LOCAL }, new Map()) as never
    );
    expect(resolved).toBe('west-q-2-east-local');
  });

  it("the fourth site: a version with no recorded region resolves in the child's region", async () => {
    const row = {
      physicalId: `arn:cdkd-local:us-west-2:${ACCT}:nested-stack/Parent/Child`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: { 'Outputs.Name': T },
      dependencies: [],
      referenceProvenance: { [T]: { versions: [V1] } },
    } as unknown as ResourceState;
    const resolved = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Queue', 'Outputs.Name'] },
      {
        template: {
          Resources: { Queue: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
        } as CloudFormationTemplate,
        resources: { Queue: row },
        parameters: {},
        conditions: {},
        recordedSecretValues: new Map(),
      } as never
    );
    expect(resolved).toBe('west-q-1');
    expect(new Set(calls.map((c) => c.region))).toEqual(new Set(['us-west-2']));
  });

  it('two recorded versions do not pin: the physical-id proof decides', async () => {
    const resolved = await readArn(
      queue('west-q-1', { [T]: { region: 'us-west-2', versions: [V1, V2] } })
    );
    expect(resolved).toBe(arnOf(T));
    expect(calls.some((c) => c.versionId !== undefined)).toBe(false);
  });

  it("the fourth site: a nested row's Outputs.<Key> takes the recorded region and version", async () => {
    const row = {
      physicalId: `arn:cdkd-local:us-east-1:${ACCT}:nested-stack/Parent/Child`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: { 'Outputs.Name': T },
      dependencies: [],
      referenceProvenance: { [T]: { region: 'us-west-2', versions: [V1] } },
    } as unknown as ResourceState;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Queue', 'Outputs.Name'] }, {
      template: {
        Resources: { Queue: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
      } as CloudFormationTemplate,
      resources: { Queue: row },
      parameters: {},
      conditions: {},
      recordedSecretValues: new Map(),
    } as never);
    expect(resolved).toBe('west-q-1');
    expect(calls.map((c) => [c.region, c.versionId])).toEqual([
      ['us-west-2', undefined],
      ['us-west-2', V1],
    ]);
  });

  it('S1: a pinned plaintext under the needle floor never marks the literal pair conflicting', async () => {
    // The reader spells the token literally (current V2: `cd`, under the
    // floor) and reads a record holding it at V1 (`abcdef`).
    const SHORT = '{{resolve:secretsmanager:app:SecretString:short::}}';
    const producer = {
      physicalId: 'producer-id',
      resourceType: 'Custom::Thing',
      properties: { Value: SHORT },
      attributes: { Out: `x-${SHORT}` },
      dependencies: [],
      referenceProvenance: { [SHORT]: { versions: [V1] } },
    } as unknown as ResourceState;
    const source = {
      Description: `pre-${SHORT}`,
      Value: { 'Fn::GetAtt': ['Queue', 'Out'] },
    };
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    const ctx = contextFor(producer, { Value: SHORT }, bag, { regions: [], complete: true });
    const resolved = (await resolver.resolve(source, ctx as never)) as Record<string, unknown>;
    expect(resolved).toEqual({ Description: 'pre-cd', Value: 'x-abcdef' });
    expect(resolvedPlaintextOf(bag, SHORT)).toBe('cd');
    const persisted = redactSecretsForState(
      markSameGenerationBag(resolved),
      bag,
      source
    ) as Record<string, unknown>;
    expect(persisted['Description']).toBe(`pre-${SHORT}`);
    expect(persisted['Value']).toBe(`x-${SHORT}`);
  });

  it('a pinned plaintext under the needle floor is NOT served: the physical-id proof refuses it', async () => {
    const SHORT = '{{resolve:secretsmanager:app:SecretString:short::}}';
    const producer = {
      physicalId: 'producer-id',
      resourceType: 'Custom::Thing',
      properties: {},
      attributes: { Out: `x-${SHORT}` },
      dependencies: [],
      // us-west-2 holds `wa` at V1: under the floor.
      referenceProvenance: { [SHORT]: { region: 'us-west-2', versions: [V1] } },
    } as unknown as ResourceState;
    const source = { Value: { 'Fn::GetAtt': ['Queue', 'Out'] } };
    const bag = new Map<string, string>();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = (await resolver.resolve(
      source,
      contextFor(producer, { Value: CROSS_REGION_NAME }, bag) as never
    )) as Record<string, unknown>;
    expect(resolved['Value']).toBe(`x-${SHORT}`);
    const persisted = redactSecretsForState(markSameGenerationBag(resolved), bag, source) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(persisted)).not.toContain('x-wa');
    // Not a deprecated version, and the proof decides here: neither the
    // failed-pin line nor the no-proof site's short-pin line.
    expect(warns.some((w) => w.includes('deprecated or deleted'))).toBe(false);
    expect(warns.some((w) => w.includes('serving its current value instead'))).toBe(false);
  });
});
