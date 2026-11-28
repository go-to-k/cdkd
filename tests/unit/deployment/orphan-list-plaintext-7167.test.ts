/**
 * go-to-k/cdkd#7167: an orphan or superseded record that already holds a
 * secret's plaintext at a LIST position of `observedProperties` (written
 * before the redaction existed), where its own `properties` hold the
 * reference at that same position, keeps no plaintext on the deploy save nor
 * on `cdkd scrub`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
const ssmSend = vi.hoisted(() => vi.fn());
const smSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
    secretsManager: { send: smSend },
  }),
}));

import { scrubStack } from '../../../src/cli/commands/scrub.js';

const TYPE = 'AWS::Test::Users7167';
const SSM_PLAIN = 'ssm-plain-7167-value';
const SM_PLAIN = 'sm-plain-7167-value';
const REFS = {
  'ssm-secure': ['{{resolve:ssm-secure:/o7167}}', SSM_PLAIN],
  secretsmanager: ['{{resolve:secretsmanager:o7167-secret}}', SM_PLAIN],
} as const;
type Service = keyof typeof REFS;

/** The list shapes a position can take. */
const SHAPES: Record<string, (ref: string, plain: string) => [unknown, unknown]> = {
  'object element': (ref, plain) => [[{ Password: ref }], [{ Password: plain }]],
  'second object element': (ref, plain) => [
    [{ Name: 'a' }, { Password: ref }],
    [{ Name: 'a' }, { Password: plain }],
  ],
  'string element': (ref, plain) => [['plain', ref], ['plain', plain]],
  'nested list': (ref, plain) => [[{ Inner: [{ Password: ref }] }], [{ Inner: [{ Password: plain }] }]],
  'embedded in element': (ref, plain) => [[{ Url: `x-${ref}-y` }], [{ Url: `x-${plain}-y` }]],
  'reordered by AWS': (ref, plain) => [
    [{ Name: 'a' }, { Password: ref }],
    [{ Password: plain }, { Name: 'a' }],
  ],
  'length differs': (ref, plain) => [[{ Password: ref }], [{ Password: plain }, { Name: 'extra' }]],
};

function dropped(shape: string, service: Service): ResourceState {
  const [ref, plain] = REFS[service];
  const [props, observed] = SHAPES[shape]!(ref, plain);
  return {
    physicalId: 'o-7167',
    resourceType: TYPE,
    properties: { Users: props },
    observedProperties: { Users: observed },
  };
}

const cases = Object.keys(SHAPES).flatMap((shape) =>
  (Object.keys(REFS) as Service[]).map((service) => ({ shape, service }))
);

const engine = (): DeployEngine =>
  new DeployEngine({} as never, {} as never, {} as never, {} as never, {} as never, { dryRun: false }, 'us-east-1');

function persist(record: ResourceState): StackState {
  const state: StackState = {
    version: 18 as never,
    stackName: 'S7167',
    region: 'us-east-1',
    resources: {},
    orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: record }],
    supersededResources: [{ logicalId: 'Gone', supersededAt: 1, state: record }],
    outputs: {},
    lastModified: 0,
  };
  return (engine() as unknown as { redactStateForPersist(s: StackState): StackState }).redactStateForPersist(state);
}

describe('an orphan / superseded record holding list-positioned plaintext (go-to-k/cdkd#7167)', () => {
  it('the generated population is the full product', () => {
    expect(cases).toHaveLength(7 * 2);
  });

  it.each(cases.map((c) => [c.shape, c.service] as const))(
    'deploy save: %s, %s — no plaintext anywhere in the persisted record',
    (shape, service) => {
      const saved = persist(dropped(shape, service));
      const text = JSON.stringify(saved);
      expect(text).not.toContain(SSM_PLAIN);
      expect(text).not.toContain(SM_PLAIN);
      for (const row of [saved.orphans![0]!, saved.supersededResources![0]!]) {
        // The reference itself survives in `properties`.
        expect(JSON.stringify(row.state.properties)).toContain(REFS[service][0]);
      }
    }
  );

  it('puts a paired leaf back on its reference and keeps the public element', () => {
    const [ref] = REFS['ssm-secure'];
    for (const shape of ['second object element', 'reordered by AWS'] as const) {
      const saved = persist(dropped(shape, 'ssm-secure'));
      for (const row of [saved.orphans![0]!, saved.supersededResources![0]!]) {
        const users = row.state.observedProperties!['Users'] as unknown[];
        expect(users).toContainEqual({ Name: 'a' });
        expect(users).toContainEqual({ Password: ref });
      }
    }
    const embedded = persist(dropped('embedded in element', 'secretsmanager'));
    expect(embedded.orphans![0]!.state.observedProperties).toEqual({
      Users: [{ Url: `x-${REFS.secretsmanager[0]}-y` }],
    });
  });

  it('masks every element that could hold the value when two corroborate', () => {
    const [ref, plain] = REFS['ssm-secure'];
    const saved = persist({
      physicalId: 'o-7167',
      resourceType: TYPE,
      properties: { Users: [{ Password: ref }, { Name: 'b' }] },
      // AWS reordered and normalised: both readback elements carry a `Password`.
      observedProperties: { Users: [{ Password: 'other', Name: 'b' }, { Password: plain }, { Name: 'B' }] },
    });
    const text = JSON.stringify(saved);
    expect(text).not.toContain(plain);
    // Only the leaf at the reference's position, in each element that has one.
    expect(saved.orphans![0]!.state.observedProperties!['Users']).toEqual([
      { Password: '***', Name: 'b' },
      { Password: '***' },
      { Name: 'B' },
    ]);
  });

  const users = (properties: unknown[], observed: unknown[]): unknown =>
    persist({
      physicalId: 'o-7167',
      resourceType: TYPE,
      properties: { Users: properties },
      observedProperties: { Users: observed },
    }).orphans![0]!.state.observedProperties!['Users'];

  it('keeps an element whose readback omits the write-only secret (nothing pairs)', () => {
    const [ref] = REFS['ssm-secure'];
    const observed = [
      { Username: 'u2', ConsoleAccess: true },
      { Username: 'u1', ConsoleAccess: false },
    ];
    expect(
      users(
        [
          { Username: 'u1', Password: ref },
          { Username: 'u2', Password: ref },
        ],
        observed
      )
    ).toEqual(observed);
  });

  it('an identity field AWS normalised still masks the plaintext', () => {
    const [ref, plain] = REFS['ssm-secure'];
    const out = users(
      [{ Name: 'a', Password: ref }, { Name: 'b' }],
      [{ Name: 'A', Password: plain }, { Name: 'b' }]
    );
    expect(JSON.stringify(out)).not.toContain(plain);
    expect(out).toEqual([{ Name: 'A', Password: '***' }, { Name: 'b' }]);
  });

  it('masks a paired leaf whose readback does not line up with the recorded text', () => {
    const [ref, plain] = REFS.secretsmanager;
    const out = users([{ Url: `x-${ref}-y` }], [{ Url: `X-${plain}-Y` }]);
    expect(out).toEqual([{ Url: '***' }]);
  });

  it('masks the one copy left when the reference is recorded twice and redacted once', () => {
    const [ref, plain] = REFS['ssm-secure'];
    const out = users(
      [{ Password: ref }, { Password: ref }],
      [{ Password: ref }, { Password: plain }, { Other: 'o' }]
    );
    expect(out).toEqual([{ Password: ref }, { Password: '***' }, { Other: 'o' }]);
  });

  it('a copy in an AWS-added element is masked although another element holds the reference', () => {
    const [ref, plain] = REFS['ssm-secure'];
    const out = users([{ Password: ref }], [{ Password: ref }, { Password: plain }]);
    expect(out).toEqual([{ Password: ref }, { Password: '***' }]);
  });

  it('a renamed identity-keyed element holding the plaintext is masked', () => {
    const [ref, plain] = REFS['ssm-secure'];
    const out = users(
      [
        { Name: 'a', Password: ref },
        { Name: 'b', Password: ref },
      ],
      [
        { Name: 'a', Password: ref },
        { Name: 'c', Password: plain },
      ]
    );
    expect(JSON.stringify(out)).not.toContain(plain);
  });

  it('a record redacted when it was written is kept as it is, reordered or not', () => {
    const [ref] = REFS['ssm-secure'];
    for (const observed of [
      [{ Name: 'a' }, { Password: ref }],
      [{ Password: ref, Name: 'x' }, { Name: 'A' }],
      // Ambiguous (no element pairs), every candidate leaf already the reference.
      [{ Name: 'A', Password: ref }, { Password: ref }],
    ]) {
      const record: ResourceState = {
        physicalId: 'o-7167',
        resourceType: TYPE,
        properties: { Users: [{ Name: 'a' }, { Password: ref }] },
        observedProperties: { Users: observed },
      };
      const saved = persist(record);
      expect(saved.orphans![0]!.state.observedProperties).toEqual({ Users: observed });
      expect(saved.supersededResources![0]!.state.observedProperties).toEqual({ Users: observed });
    }
  });

  describe('cdkd scrub', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
    const lockManager = {
      acquireLockWithRetry: vi.fn(async () => undefined),
      releaseLock: vi.fn(async () => undefined),
    };
    const info = {
      stackName: 'S7167',
      template: {
        Resources: { Live: { Type: 'AWS::SNS::Topic', Properties: { DisplayName: 'plain' } } },
      } as unknown as CloudFormationTemplate,
    };

    beforeEach(() => {
      vi.clearAllMocks();
      ssmSend.mockResolvedValue({ Parameter: { Value: SSM_PLAIN, Type: 'SecureString', Version: 1 } });
      smSend.mockResolvedValue({ SecretString: SM_PLAIN, VersionId: 'v1' });
      stateBackend = {
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag-2'),
        purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      };
    });

    async function scrub(state: StackState): Promise<StackState> {
      stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
      await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
        dryRun: false,
        logger: logger as never,
      });
      const call = stateBackend['saveState']!.mock.calls.at(-1);
      return (call ? call[2] : state) as StackState;
    }

    const base = (extra: Partial<StackState>): StackState => ({
      version: 18 as never,
      region: 'us-east-1',
      stackName: 'S7167',
      resources: { Live: { physicalId: 't', resourceType: 'AWS::SNS::Topic', properties: { DisplayName: 'plain' } } },
      outputs: {},
      lastModified: 0,
      ...extra,
    });

    it.each(cases.map((c) => [c.shape, c.service] as const))(
      'orphan: %s, %s — scrub leaves no plaintext',
      async (shape, service) => {
        const saved = await scrub(base({ orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: dropped(shape, service) }] }));
        const text = JSON.stringify(saved);
        expect(text).not.toContain(SSM_PLAIN);
        expect(text).not.toContain(SM_PLAIN);
      }
    );

    it.each(cases.map((c) => [c.shape, c.service] as const))(
      'superseded: %s, %s — scrub leaves no plaintext',
      async (shape, service) => {
        const saved = await scrub(
          base({ supersededResources: [{ logicalId: 'Gone', supersededAt: 1, state: dropped(shape, service) }] })
        );
        const text = JSON.stringify(saved);
        expect(text).not.toContain(SSM_PLAIN);
        expect(text).not.toContain(SM_PLAIN);
      }
    );
  });
});
