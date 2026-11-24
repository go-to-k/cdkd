/**
 * go-to-k/cdkd#6609 slice C2: the deploy's post-write capture
 * (`afterOwnWrite`) of an `AWS::IAM::Policy` took IAM's first
 * `Get{Role,User,Group}Policy` answer. An answer that still showed the
 * replaced document, or none, was frozen into the drift baseline, and
 * `drift --revert` would restore it (re-grant the replaced document, or delete
 * the policy just written). The capture now settles the copy it reads on the
 * declared document; every other read takes the first answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';
import { compareDriftReadback } from '../../../src/cli/commands/drift/compare.js';
import { buildReadCurrentStateContext } from '../../../src/deployment/read-current-state-context.js';

const TYPE = 'AWS::IAM::Policy';
const AFTER = { afterOwnWrite: true } as const;

/** The declared document of the us-east-1 probe (2026-11-20). */
const DECLARED = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'A',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::cdkd-probe-6609c2-a/*'],
      Condition: { StringEquals: { 'aws:RequestedRegion': ['us-east-1'] } },
    },
  ],
};
/** `GetRolePolicy`'s raw answer for DECLARED, verbatim from the probe (RFC 3986 encoded). */
const DECLARED_RAW =
  '%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%5B%7B%22Sid%22%3A%22A%22%2C%22Effect%22%3A%22Allow%22%2C%22Action%22%3A%5B%22s3%3AGetObject%22%5D%2C%22Resource%22%3A%5B%22arn%3Aaws%3As3%3A%3A%3Acdkd-probe-6609c2-a%2F%2A%22%5D%2C%22Condition%22%3A%7B%22StringEquals%22%3A%7B%22aws%3ARequestedRegion%22%3A%5B%22us-east-1%22%5D%7D%7D%7D%5D%7D';
/** The document DECLARED replaced, as the probe's replace step read it back. */
const PREVIOUS = {
  Statement: [
    { Effect: 'Allow', Resource: 'arn:aws:s3:::cdkd-probe-6609c2-b/*', Action: 's3:PutObject' },
    { Effect: 'Deny', Action: 'sqs:*', Resource: '*' },
  ],
  Version: '2012-10-17',
};
const PREVIOUS_RAW =
  '%7B%22Statement%22%3A%5B%7B%22Effect%22%3A%22Allow%22%2C%22Resource%22%3A%22arn%3Aaws%3As3%3A%3A%3Acdkd-probe-6609c2-b%2F%2A%22%2C%22Action%22%3A%22s3%3APutObject%22%7D%2C%7B%22Effect%22%3A%22Deny%22%2C%22Action%22%3A%22sqs%3A%2A%22%2C%22Resource%22%3A%22%2A%22%7D%5D%2C%22Version%22%3A%222012-10-17%22%7D';

const COMMAND_TARGET: Record<string, [string, string]> = {
  GetRolePolicyCommand: ['role', 'RoleName'],
  GetUserPolicyCommand: ['user', 'UserName'],
  GetGroupPolicyCommand: ['group', 'GroupName'],
};

/** Per `kind:name` target, the answers in order (the last one repeats). */
let script: Record<string, Array<() => unknown>> = {};
function answer(target: string, ...answers: Array<() => unknown>): void {
  script[target] = answers;
}
const doc = (raw: string) => () => ({ PolicyDocument: raw });
const missing = () => () => {
  throw new NoSuchEntityException({ message: 'The role policy cannot be found.', $metadata: {} });
};
const fail = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};
/** The targets read, in call order. */
const calls = (): string[] =>
  mockSend.mock.calls.map((c) => {
    const command = c[0] as { constructor: { name: string }; input: Record<string, string> };
    const [kind, field] = COMMAND_TARGET[command.constructor.name]!;
    return `${kind}:${command.input[field]}`;
  });
const unsettledWarnings = (): string[] =>
  childLogger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('refresh-observed'));

let provider: IAMPolicyProvider;
beforeEach(() => {
  mockSend.mockReset();
  childLogger.warn.mockClear();
  script = {};
  const served: Record<string, number> = {};
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Record<string, string> }) => {
    const [kind, field] = COMMAND_TARGET[command.constructor.name]!;
    const target = `${kind}:${command.input[field]}`;
    const queue = script[target];
    if (queue === undefined) return Promise.reject(new Error(`unscripted ${target}`));
    const index = Math.min(served[target] ?? 0, queue.length - 1);
    served[target] = (served[target] ?? 0) + 1;
    try {
      return Promise.resolve(queue[index]!());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  provider = new IAMPolicyProvider();
  provider.ownWriteRereadDelaysMs = [0, 0, 0];
});

const read = (properties: Record<string, unknown>, context?: Record<string, unknown>) =>
  provider.readCurrentState('pol', 'PolicyP', TYPE, properties, context);

describe('AWS::IAM::Policy post-write capture settles the copy it reads (#6609 C2)', () => {
  for (const [kind, key, name] of [
    ['role', 'Roles', 'R1'],
    ['user', 'Users', 'U1'],
    ['group', 'Groups', 'G1'],
  ] as const) {
    it(`settles on read 1 for a ${kind} target in IAM's URL-encoded spelling: 1 call, no warning`, async () => {
      answer(`${kind}:${name}`, doc(DECLARED_RAW));
      const result = await read({ PolicyDocument: DECLARED, [key]: [name] }, AFTER);
      expect(calls()).toEqual([`${kind}:${name}`]);
      expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: DECLARED, [key]: [name] });
      expect(unsettledWarnings()).toEqual([]);
    });

    it(`re-reads a ${kind} copy still absent, and records it once it reads back`, async () => {
      answer(`${kind}:${name}`, missing(), doc(DECLARED_RAW));
      const result = await read({ PolicyDocument: DECLARED, [key]: [name] }, AFTER);
      expect(calls()).toEqual([`${kind}:${name}`, `${kind}:${name}`]);
      expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: DECLARED, [key]: [name] });
    });
  }

  it('re-reads a copy still holding the replaced document until the declared one shows: 2 calls', async () => {
    answer('role:R1', doc(PREVIOUS_RAW), doc(DECLARED_RAW));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toEqual(['role:R1', 'role:R1']);
    expect(result).toMatchObject({ PolicyDocument: DECLARED });
    expect(unsettledWarnings()).toEqual([]);
  });

  it('keeps the declared document and the target in its list when the copy stays absent, and warns value-free', async () => {
    answer('role:R1', missing());
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toEqual(['role:R1', 'role:R1', 'role:R1', 'role:R1']);
    // Pre-fix: RESOURCE_NOT_FOUND, so the capture recorded no baseline at all.
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: DECLARED, Roles: ['R1'] });
    const warnings = unsettledWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AWS::IAM::Policy PolicyP');
    expect(warnings[0]).toContain('PolicyDocument');
    expect(warnings[0]).not.toContain('s3:GetObject');
    expect(warnings[0]).not.toContain('cdkd-probe');
  });

  it('keeps a declared JSON-string document in the read (parsed) shape', async () => {
    answer('role:R1', missing());
    const result = await read({ PolicyDocument: JSON.stringify(DECLARED), Roles: ['R1'] }, AFTER);
    expect(result).toMatchObject({ PolicyDocument: DECLARED });
  });

  it('settles a declared JSON-string document on read 1 against the decoded answer', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    const result = await read({ PolicyDocument: JSON.stringify(DECLARED), Roles: ['R1'] }, AFTER);
    expect(calls()).toEqual(['role:R1']);
    expect(result).toMatchObject({ PolicyDocument: DECLARED });
  });

  it('settles on read 1 when only key order differs from the declaration', async () => {
    const reordered = { Statement: DECLARED.Statement, Version: '2012-10-17' };
    answer('role:R1', doc(DECLARED_RAW));
    await read({ PolicyDocument: reordered, Roles: ['R1'] }, AFTER);
    expect(calls()).toEqual(['role:R1']);
  });

  it('records another document as read after the schedule, with one warning', async () => {
    answer('role:R1', doc(PREVIOUS_RAW));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toHaveLength(4);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: PREVIOUS, Roles: ['R1'] });
    expect(unsettledWarnings()).toHaveLength(1);
    expect(unsettledWarnings()[0]).not.toContain('sqs:*');
  });

  it('a deterministic first failure (AccessDenied) is not re-read and throws as before: 1 call', async () => {
    answer('role:R1', fail('AccessDenied'), doc(DECLARED_RAW));
    await expect(read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER)).rejects.toThrow(
      'AccessDenied'
    );
    expect(calls()).toEqual(['role:R1']);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a transient first failure is re-read: settles on read 2', async () => {
    answer('role:R1', fail('Throttling'), doc(DECLARED_RAW));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toHaveLength(2);
    expect(result).toMatchObject({ PolicyDocument: DECLARED, Roles: ['R1'] });
  });

  it('every read failing transiently throws what the single read threw: 4 calls', async () => {
    answer('role:R1', fail('Throttling'));
    await expect(read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER)).rejects.toThrow(
      'Throttling'
    );
    expect(calls()).toHaveLength(4);
    // The throw is the message: no refresh-observed warning beside it.
    expect(unsettledWarnings()).toEqual([]);
  });

  it('every read failing throws the FIRST read\'s error, not a later re-read\'s: 4 calls', async () => {
    const unavailable = () => () => {
      throw Object.assign(new Error('ServiceUnavailable'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      });
    };
    answer('role:R1', fail('Throttling'), unavailable());
    const outcome = read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    await expect(outcome).rejects.toThrow('Throttling');
    await expect(outcome).rejects.not.toThrow('ServiceUnavailable');
    expect(calls()).toHaveLength(4);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a deterministic re-read failure ends the schedule; a still-absent copy keeps the declaration', async () => {
    answer('role:R1', missing(), fail('AccessDenied'));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toHaveLength(2);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: DECLARED, Roles: ['R1'] });
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a failed re-read keeps the newest answer, never a stale one before it', async () => {
    answer('role:R1', missing(), doc(PREVIOUS_RAW), fail('Throttling'));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, AFTER);
    expect(calls()).toHaveLength(4);
    expect(result).toMatchObject({ PolicyDocument: PREVIOUS, Roles: ['R1'] });
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('reads only the first target of a multi-principal policy, settling it while the others are echoed', async () => {
    // R1 lags until its last re-read (read 4); R2 and G1 are never read (each
    // would answer differently), so neither can freeze anything into the baseline.
    answer('role:R1', missing(), missing(), doc(PREVIOUS_RAW), doc(DECLARED_RAW));
    answer('role:R2', missing());
    answer('group:G1', doc(PREVIOUS_RAW));
    const result = await read(
      { PolicyDocument: DECLARED, Roles: ['R1', 'R2'], Groups: ['G1'], Users: ['U1'] },
      AFTER
    );
    expect(calls()).toEqual(['role:R1', 'role:R1', 'role:R1', 'role:R1']);
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: DECLARED,
      Roles: ['R1', 'R2'],
      Groups: ['G1'],
      Users: ['U1'],
    });
    expect(unsettledWarnings()).toEqual([]);
  });

  it('keeps the first target at its declared position when it never reads back on a multi-principal policy', async () => {
    answer('group:G1', missing());
    const result = await read({ PolicyDocument: DECLARED, Groups: ['G1', 'G2'], Users: ['U1'] }, AFTER);
    expect(calls()).toEqual(['group:G1', 'group:G1', 'group:G1', 'group:G1']);
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: DECLARED,
      Groups: ['G1', 'G2'],
      Users: ['U1'],
    });
    expect(unsettledWarnings()).toHaveLength(1);
  });
});

describe('AWS::IAM::Policy reads outside the post-write capture believe AWS (#6609 C2)', () => {
  it('a drift read takes the first answer: an absent sole copy is RESOURCE_NOT_FOUND, 1 call', async () => {
    answer('role:R1', missing(), doc(DECLARED_RAW));
    expect(await read({ PolicyDocument: DECLARED, Roles: ['R1'] })).toBe(RESOURCE_NOT_FOUND);
    expect(calls()).toEqual(['role:R1']);
  });

  it('a drift read records another document as read: 1 call, no warning', async () => {
    answer('role:R1', doc(PREVIOUS_RAW), doc(DECLARED_RAW));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, {});
    expect(calls()).toEqual(['role:R1']);
    expect(result).toMatchObject({ PolicyDocument: PREVIOUS });
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a drift read of several targets answering differently reads each once and re-reads none', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('role:R2', missing(), doc(DECLARED_RAW));
    answer('user:U1', doc(PREVIOUS_RAW), doc(DECLARED_RAW));
    const result = await read({ PolicyDocument: DECLARED, Roles: ['R1', 'R2'], Users: ['U1'] });
    expect(calls().sort()).toEqual(['role:R1', 'role:R2', 'user:U1']);
    // R2's absence is drift on Roles; U1's edited copy is the reported document.
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: PREVIOUS,
      Roles: ['R1'],
      Users: ['U1'],
    });
  });

  it('afterOwnWrite: false is a drift read, not a capture', async () => {
    answer('role:R1', missing(), doc(DECLARED_RAW));
    expect(await read({ PolicyDocument: DECLARED, Roles: ['R1'] }, { afterOwnWrite: false })).toBe(
      RESOURCE_NOT_FOUND
    );
    expect(calls()).toHaveLength(1);
  });
});

// ─── The drift heal (fourth rule of preFixBaselineUncomparedDriftKeys) ─────
describe('heal: an AWS::IAM::Policy member is skipped only while every live copy is the declared one (#6609 C2)', () => {
  /** A baseline captured before the write showed: the replaced document. */
  const STALE = { PolicyName: 'pol', PolicyDocument: PREVIOUS, Roles: ['R1', 'R2'] };
  /** An out-of-band edit on one principal's copy. */
  const EDITED = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
  };
  const EDITED_RAW = encodeURIComponent(JSON.stringify(EDITED));
  const healOf = (properties: Record<string, unknown>, aws: Record<string, unknown>) =>
    preFixBaselineUncomparedDriftKeys(TYPE, STALE, properties, aws);
  /** The drift read (against the stale baseline), then the heal over its bag. */
  const readThenHeal = async (properties: Record<string, unknown>) => {
    const aws = (await read(properties, { driftBaseline: STALE })) as Record<string, unknown>;
    return { aws, healed: healOf(properties, aws) };
  };

  it('skips PolicyDocument when the sole copy is the declared one', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    const { healed } = await readThenHeal({ PolicyName: 'pol', PolicyDocument: DECLARED, Roles: ['R1'] });
    expect(healed).toContain('PolicyDocument');
  });

  it('skips a declared JSON-string PolicyDocument the copy holds parsed', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    const { healed } = await readThenHeal({ PolicyDocument: JSON.stringify(DECLARED), Roles: ['R1'] });
    expect(healed).toContain('PolicyDocument');
  });

  it('compares PolicyDocument when the sole copy is another document', async () => {
    answer('role:R1', doc(EDITED_RAW));
    const { healed } = await readThenHeal({ PolicyDocument: DECLARED, Roles: ['R1'] });
    expect(healed).not.toContain('PolicyDocument');
  });

  it('skips PolicyDocument when every principal\'s copy is the declared one', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('role:R2', doc(DECLARED_RAW));
    answer('user:U1', doc(DECLARED_RAW));
    const { healed } = await readThenHeal({
      PolicyDocument: DECLARED,
      Roles: ['R1', 'R2'],
      Users: ['U1'],
    });
    expect(healed).toEqual(expect.arrayContaining(['PolicyDocument', 'Roles', 'Users']));
  });

  it('never skips PolicyDocument when copies differ, even though the surfaced copy is the declared one', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('role:R2', doc(EDITED_RAW));
    const { aws, healed } = await readThenHeal({ PolicyDocument: DECLARED, Roles: ['R1', 'R2'] });
    // The read surfaces R1's copy (the first differing from the stale baseline) ...
    expect(aws['PolicyDocument']).toEqual(DECLARED);
    // ... so only the agreeing-copies mark, absent here, keeps R2's edit reported.
    expect(healed).not.toContain('PolicyDocument');
    expect(healed).toContain('Roles');
  });

  it('never skips PolicyDocument when a second copy still holds the stale baseline\'s document', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('role:R2', doc(PREVIOUS_RAW));
    const { aws, healed } = await readThenHeal({ PolicyDocument: DECLARED, Roles: ['R1', 'R2'] });
    expect(aws['PolicyDocument']).toEqual(DECLARED);
    expect(healed).not.toContain('PolicyDocument');
  });

  it('skips PolicyDocument but compares Roles when a principal lacks the policy', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('role:R2', missing());
    const { aws, healed } = await readThenHeal({ PolicyDocument: DECLARED, Roles: ['R1', 'R2'] });
    expect(aws['Roles']).toEqual(['R1']);
    expect(healed).toContain('PolicyDocument');
    expect(healed).not.toContain('Roles');
  });

  for (const key of ['Roles', 'Users', 'Groups'] as const) {
    it(`skips ${key} only on the exact declared set`, () => {
      const properties = { PolicyDocument: DECLARED, [key]: ['a', 'b'] };
      expect(healOf(properties, { [key]: ['a', 'b'] })).toContain(key);
      expect(healOf(properties, { [key]: ['b', 'a'] })).toContain(key);
      for (const live of [['a', 'b', 'c'], ['a'], ['a', 'c'], [], undefined]) {
        expect(healOf(properties, { [key]: live })).not.toContain(key);
      }
      // Undeclared: nothing to agree with.
      expect(healOf({ PolicyDocument: DECLARED }, { [key]: ['a'] })).not.toContain(key);
    });
  }

  it('skips PolicyName only on the exact declared name', () => {
    expect(healOf({ PolicyName: 'pol', PolicyDocument: DECLARED }, { PolicyName: 'pol' })).toContain(
      'PolicyName'
    );
    expect(healOf({ PolicyName: 'pol', PolicyDocument: DECLARED }, { PolicyName: 'other' })).not.toContain(
      'PolicyName'
    );
    expect(healOf({ PolicyDocument: DECLARED }, { PolicyName: 'pol' })).not.toContain('PolicyName');
    expect(healOf({ PolicyName: '', PolicyDocument: DECLARED }, { PolicyName: '' })).not.toContain(
      'PolicyName'
    );
  });

  it('heals nothing without a recorded baseline', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(TYPE, undefined, { PolicyDocument: DECLARED, Roles: ['R1'] }, {
        PolicyDocument: DECLARED,
        Roles: ['R1'],
      })
    ).toEqual([]);
  });
});

// ─── The heal through drift's own comparison (detect → compare) ───────────
describe('heal through compareDriftReadback: PolicyDocument skips only on a read whose every copy agreed (#6609 C2)', () => {
  const STALE = { PolicyName: 'pol', PolicyDocument: PREVIOUS, Roles: ['R1'], Users: ['U1'] };
  const DECLARED_PROPS = { PolicyName: 'pol', PolicyDocument: DECLARED, Roles: ['R1'], Users: ['U1'] };
  /** Wider than the declaration: an out-of-band edit on U1's copy. */
  const WIDER_RAW = encodeURIComponent(
    JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] })
  );
  const compareOnce = async (clone: boolean) => {
    const state = {
      resources: {
        PolicyP: {
          resourceType: TYPE,
          physicalId: 'pol',
          properties: DECLARED_PROPS,
          observedProperties: STALE,
          attributes: {},
        },
      },
    };
    const readContext = buildReadCurrentStateContext(state as never, 'PolicyP');
    const read = (await provider.readCurrentState(
      'pol',
      'PolicyP',
      TYPE,
      DECLARED_PROPS,
      readContext
    )) as Record<string, unknown>;
    const outcomes: Array<{ kind: string; changes?: Array<{ path: string }> }> = [];
    await compareDriftReadback({
      region: 'us-east-1',
      resolvePrincipalUniqueId: () => Promise.resolve(undefined),
      outcomes: outcomes as never,
      logger: childLogger as never,
      secretResolvers: {} as never,
      producerRegions: { regions: [], complete: true },
      stackSecretNames: new Map(),
      resource: state.resources.PolicyP as never,
      logicalId: 'PolicyP',
      provider,
      secrets: new Map(),
      printing: new Map(),
      aws: clone ? { ...read } : read,
      readContext,
    });
    expect(outcomes).toHaveLength(1);
    return (outcomes[0]!.changes ?? []).map((c) => c.path);
  };
  const documentReported = (paths: string[]) => paths.some((p) => p.startsWith('PolicyDocument'));

  it('compares PolicyDocument when R1 holds the declared copy and U1 a wider one', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('user:U1', doc(WIDER_RAW));
    expect(documentReported(await compareOnce(false))).toBe(true);
  });

  it('still compares it when the bag is shallow-cloned on the way to the heal', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('user:U1', doc(WIDER_RAW));
    expect(documentReported(await compareOnce(true))).toBe(true);
  });

  it('skips it when every copy agrees on the declared document', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('user:U1', doc(DECLARED_RAW));
    expect(await compareOnce(false)).toEqual([]);
  });

  it('a cloned bag of agreeing copies loses the mark and stays compared (the stale baseline reports)', async () => {
    answer('role:R1', doc(DECLARED_RAW));
    answer('user:U1', doc(DECLARED_RAW));
    expect(documentReported(await compareOnce(true))).toBe(true);
  });
});
