import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { marked, type Tokens } from 'marked';
import type { LockInfo, ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  // Issue #2280: the commands under test call this under --json; the mock
  // must export it or the import is `undefined` and the call throws.
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState } | null>>();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockGetLockInfo =
  vi.fn<(stackName: string, region?: string) => Promise<LockInfo | null>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    getLockInfo: mockGetLockInfo,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runStateShow(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
    // Schema v10 (issue #2944). Spread CONDITIONALLY like its neighbours: the
    // renderer tests presence, so an unconditional `observedBaselineRefused:
    // undefined` would put the key on every record and make the "unmarked
    // renders nothing" half of that case unfalsifiable.
    ...(overrides.observedBaselineRefused && {
      observedBaselineRefused: overrides.observedBaselineRefused,
    }),
  };
}

function makeState(overrides: Partial<StackState> = {}): { state: StackState } {
  return {
    state: {
      version: overrides.version ?? 2,
      stackName: overrides.stackName ?? 'TestStack',
      region: overrides.region ?? 'us-east-1',
      resources: overrides.resources ?? {},
      outputs: overrides.outputs ?? {},
      lastModified: overrides.lastModified ?? Date.UTC(2026, 3, 29, 10, 23, 45),
      ...(overrides.parentStack !== undefined && { parentStack: overrides.parentStack }),
      ...(overrides.parentLogicalId !== undefined && {
        parentLogicalId: overrides.parentLogicalId,
      }),
      ...(overrides.parentRegion !== undefined && { parentRegion: overrides.parentRegion }),
      // Spread rather than defaulted, so `{}` and ABSENT stay distinguishable
      // — the renderer treats them the same but for different reasons, and a
      // default would make the absent case untestable through this helper.
      ...(overrides.skippedOutputs !== undefined && {
        skippedOutputs: overrides.skippedOutputs,
      }),
    },
  };
}

/**
 * A value `JSON.parse` accepts and `JSON.stringify` then REFUSES.
 *
 * `JSON.stringify` recurses and exhausts the stack; `JSON.parse` does not recurse
 * and handles far deeper input, so any depth past the stringify limit qualifies.
 * That limit is the STACK's, so it is machine-specific and the depth is searched
 * for rather than hardcoded; FAILING when nothing in the probed range qualifies
 * keeps the case from passing vacuously if this stops being true.
 */
function unstringifiableFromParsedJson(): unknown {
  for (const depth of [4_000, 8_000, 16_000, 32_000]) {
    // No guard around the parse: the input is balanced and `JSON.parse` does not
    // recurse, so a failure here is not a case this helper should paper over.
    const parsed: unknown = JSON.parse('['.repeat(depth) + ']'.repeat(depth));
    try {
      JSON.stringify(parsed);
    } catch {
      return parsed;
    }
  }
  throw new Error(
    'premise broken: no nesting depth both parses and refuses to stringify, so this ' +
      'suite can no longer reach `formatAttributeValue`\'s serialization catch from ' +
      'stored bytes'
  );
}

function defaultListResponse(stackName = 'TestStack', region = 'us-east-1') {
  return [{ stackName, region }];
}

describe('cdkd state show', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockGetLockInfo.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    errorSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('reports a clear error when the stack has no state', async () => {
    mockListStacks.mockResolvedValue([]);
    mockGetState.mockResolvedValue(null);
    mockGetLockInfo.mockResolvedValue(null);

    await expect(runStateShow(['show', 'Missing'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack 'Missing'/);
  });

  it('errors when the stack has multiple regions and --stack-region is missing', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-west-2' },
      { stackName: 'MyStack', region: 'us-east-1' },
    ]);

    await expect(runStateShow(['show', 'MyStack'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/multiple regions/);
    // Direct users to --stack-region, not the deprecated top-level
    // --region (which would emit a deprecation warning and be ignored).
    expect(message).toMatch(/--stack-region/);
    expect(message).not.toMatch(/--region\b(?!-)/);
  });

  it('renders stack header, lock status, outputs, and resources', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'MyStack',
        region: 'us-east-1',
        // Not every stored output is a string, and that is ordinary data rather
        // than a hand edit: the deploy engine assigns the resolved value
        // UNCOERCED, so a list-valued `Fn::GetAtt` persists a JSON array
        // (CLAUDE.md, "State Schema"). These two are what tell the value's
        // formatter from a bare strip, which would throw on either.
        outputs: { ApiUrl: 'https://api.example.com', Azs: ['us-east-1a', 'us-east-1b'], Count: 2 },
        resources: {
          MyBucket: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'my-bucket-abc',
            properties: { BucketName: 'my-bucket-abc' },
            attributes: { Arn: 'arn:aws:s3:::my-bucket-abc' },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toContain('Stack: MyStack');
    expect(out).toContain('  Region: us-east-1');
    expect(out).toContain('  Version: 2');
    expect(out).toContain('  Last Modified: 2026-04-29T10:23:45.000Z');
    expect(out).toContain('  Lock: unlocked');
    expect(out).toContain('Outputs:');
    // Whole rows, in insertion order: the array as JSON, the number as itself.
    expect(out.split('\n').filter((l) => /^  (ApiUrl|Azs|Count): /.test(l))).toEqual([
      '  ApiUrl: https://api.example.com',
      '  Azs: ["us-east-1a","us-east-1b"]',
      '  Count: 2',
    ]);
    expect(out).toContain('Resources (1):');
    expect(out).toContain('MyBucket');
    expect(out).toContain('  Type: AWS::S3::Bucket');
    expect(out).toContain('  PhysicalID: my-bucket-abc');
    expect(out).toContain('  Properties:');
    expect(out).toContain('    BucketName: my-bucket-abc');
    expect(out).toContain('  Attributes:');
    expect(out).toContain('    Arn: arn:aws:s3:::my-bucket-abc');
  });

  it('renders a locked stack with owner / operation / expiry detail', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
    mockGetState.mockResolvedValue(makeState({ stackName: 'MyStack' }));
    mockGetLockInfo.mockResolvedValue({
      owner: 'alice@workstation:1234',
      operation: 'deploy',
      timestamp: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000, // 10 minutes from now
    });

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toMatch(/Lock: locked by alice@workstation:1234 \(operation: deploy\), expires in /);
  });

  it('renders an expired lock when expiresAt is in the past', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
    mockGetState.mockResolvedValue(makeState({ stackName: 'MyStack' }));
    mockGetLockInfo.mockResolvedValue({
      owner: 'bob@host:5678',
      timestamp: Date.now() - 7_200_000,
      expiresAt: Date.now() - 30_000, // 30 seconds ago
    });

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toMatch(/Lock: locked by bob@host:5678, expired \d+s ago/);
  });

  it('reports `(none)` for resources with no attributes / no properties', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('AnyStack'));
    mockGetState.mockResolvedValue(
      makeState({
        resources: {
          Bare: makeResource({ resourceType: 'AWS::SQS::Queue', physicalId: 'q-1' }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'AnyStack']);

    expect(out).toContain('  Properties: (none)');
    expect(out).toContain('  Attributes: (none)');
    expect(out).toContain('  Dependencies: (none)');
  });

  it('STRIPS control characters from an Outputs row, key AND value (issue #1948)', async () => {
    // An Outputs bag KEY can be an `Export.Name` cdkd RESOLVED from an
    // `Fn::Sub` / parameter / SSM value, so unlike a CFn logical id it passed
    // no validator; the VALUE has the same provenance. Both would otherwise
    // carry an ANSI escape straight into the terminal that renders this block,
    // which is the last human-render site for a stored outputs bag.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        outputs: {
          // A bare ESC (what starts every ANSI sequence) plus a bidi override,
          // one in the KEY and one in the VALUE. Deliberately NOT a full
          // `\u001b[2J`: only the control character is removed, so the `[2J`
          // tail would survive and an expectation written around it could not
          // tell a strip from a rewrite.
          'Api\u001bUrl\u202e': 'https://api\u001b.example.com',
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);

    const outputsRow = out.split('\n').find((l) => l.includes('ApiUrl'));
    expect(outputsRow).toBe('  ApiUrl: https://api.example.com');
    // Scoped to the ROW, not the whole document: a whole-output assertion would
    // hold today only because this renderer happens to use no color helper, so
    // it would silently stop discriminating the moment one is added.
    expect(outputsRow).not.toContain('\u001b');
    expect(outputsRow).not.toContain('\u202e');
  });

  it('STRIPS control characters from Attributes and Properties rows too (issue #1948 review)', async () => {
    // Same provenance as the Outputs row and the same terminal: a resource
    // PROPERTY is a resolved template value and an ATTRIBUTE is a provider
    // readback, neither of which passed a CloudFormation validator. The guard
    // lives inside `formatAttributeValue` so this row gets it.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b',
            properties: { BucketName: 'my\u001bbucket' },
            attributes: { Arn: 'arn:aws:s3:::my\u202ebucket' },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);

    const propRow = out.split('\n').find((l) => l.includes('BucketName'));
    const attrRow = out.split('\n').find((l) => l.includes('Arn:'));
    expect(propRow).toBe('    BucketName: mybucket');
    expect(attrRow).toBe('    Arn: arn:aws:s3:::mybucket');
  });

  it('strips control characters from Attribute and Property KEYS, not just values', async () => {
    // The KEY strips were unfenced: the test above puts control characters only
    // in VALUES, which `formatAttributeValue` already handles, so all three
    // `stripControlChars(k)` call sites could be deleted with the suite green.
    // A property NAME is template-authored and an attribute NAME is
    // provider-returned; neither passed a CloudFormation validator.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b',
            properties: { 'Bucket\u001bName': 'plain-value' },
            attributes: { 'A\u202ern': 'plain-arn' },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);

    expect(out.split('\n').find((l) => l.includes('BucketName'))).toBe(
      '    BucketName: plain-value'
    );
    expect(out.split('\n').find((l) => l.includes('Arn'))).toBe('    Arn: plain-arn');
  });

  it('STRIPS control characters from a resource LOGICAL ID', async () => {
    // CloudFormation constrains a logical id, but a hand-edited record is not
    // bound by that, and this row is a terminal sink like every other key.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilIdStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilIdStack',
        resources: {
          'My\u001bTable\u202e': makeResource({
            resourceType: 'AWS::DynamoDB::Table',
            physicalId: 'tbl-1',
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilIdStack']);

    const idRow = out.split('\n').find((l) => l.includes('MyTable'));
    expect(idRow).toBe('MyTable');
    expect(out).not.toContain('\u001b');
  });

  it('a NEWLINE in any state-derived row cannot forge a row', async () => {
    // The strip removes U+0000-U+001F, newline included, and these lines are
    // joined with a newline — so an unstripped field does not merely colour
    // output, it invents rows. One per field of the stack header and the
    // resource block; the Outputs, skipped-outputs, attribute and property rows
    // carry keys and values of their own and have their own cases.
    mockListStacks.mockResolvedValue(defaultListResponse('ForgeStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'Forge\nStack: Fake',
        region: 'us-east-1\nFake: 1',
        parentStack: 'Parent\nStack: Fake',
        parentRegion: 'us-west-2\nFake: 1',
        parentLogicalId: 'PL\nFake: 1',
        resources: {
          'Logical\nFake: 1': {
            physicalId: 'phys\nFake: 1',
            resourceType: 'AWS::SNS::Topic\nFake: 1',
            properties: {},
            provisionedBy: 'sdk\nFake: 1' as 'sdk',
            dependencies: ['A\nFake: 1', 'B'],
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'ForgeStack']);

    // The text survives — stripping removes the newline, not the characters
    // after it — but it stays JOINED to its own row. A forged row would be a
    // line that BEGINS with the injected text; there is none.
    expect(out.split('\n').filter((l) => l.startsWith('Fake: 1'))).toEqual([]);
    expect(out).toContain('Stack: ForgeStack: Fake');
    expect(out).toContain('  Region: us-east-1Fake: 1');
    expect(out).toContain('  Parent: ParentStack: Fake (us-west-2Fake: 1), logical id: PLFake: 1');
    expect(out).toContain('  Type: AWS::SNS::TopicFake: 1');
    expect(out).toContain('  ProvisionedBy: sdkFake: 1');
    expect(out).toContain('  Dependencies: AFake: 1, B');
    expect(out.split('\n')).toContain('LogicalFake: 1');
  });

  it('renders non-string name, region, parent trio, type and provisionedBy', async () => {
    // Each of the five is declared `string` and read as an unchecked cast, so a
    // hand-edited record can hold anything. Under the bare strip the first one
    // throws and the user gets NO render at all — not the stack header, not the
    // resources, not the lock. Reverting any ONE of the five to the bare STRIP
    // fails this case. Reverting one to RAW interpolation does not — a number
    // interpolates fine — and the row-forging case catches that direction
    // instead; both are needed. The lock, `version`, `lastModified` and
    // `dependencies` have their own cases.
    mockListStacks.mockResolvedValue(defaultListResponse('OddFieldStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 7 as unknown as string,
        region: 11 as unknown as string,
        parentStack: 13 as unknown as string,
        parentRegion: 17 as unknown as string,
        parentLogicalId: 19 as unknown as string,
        resources: {
          R1: {
            physicalId: 23 as unknown as string,
            resourceType: 29 as unknown as string,
            properties: {},
            provisionedBy: 31 as unknown as 'sdk',
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'OddFieldStack']);

    expect(out).toContain('Stack: 7');
    expect(out).toContain('  Region: 11');
    expect(out).toContain('  Parent: 13 (17), logical id: 19');
    expect(out).toContain('  PhysicalID: 23');
    expect(out).toContain('  Type: 29');
    expect(out).toContain('  ProvisionedBy: 31');
  });

  it('still dates a `lastModified` that is not a number', async () => {
    // The guard wraps only the THROW, so every value the previous line already
    // dated keeps dating: a numeric-only conversion would send this to the
    // fallback and print the string back instead of the instant.
    mockListStacks.mockResolvedValue(defaultListResponse('IsoStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'IsoStack',
        // Date-ONLY, so its ISO form differs from the input. An ISO string
        // would round-trip to itself and the assertion would hold either way.
        lastModified: '2026-04-29' as unknown as number,
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'IsoStack']);

    expect(out).toContain('  Last Modified: 2026-04-29T00:00:00.000Z');
  });

  it('dates a `null` and a boolean `lastModified` as the doc says, and does not hide it', async () => {
    // `formatLastModified`'s doc claims both still date. They do — `null` is
    // epoch 0 — and that is worth pinning precisely BECAUSE it is indistinguishable
    // from a genuine 1970 record: a wrong timestamp printed confidently is the
    // shape nothing else here would notice. `makeState` coalesces `null` to its
    // default, so the record is patched after construction.
    for (const [value, expected] of [
      [null, '1970-01-01T00:00:00.000Z'],
      [true, '1970-01-01T00:00:00.001Z'],
    ] as const) {
      const record = makeState({ stackName: 'EpochStack' });
      record.state.lastModified = value as unknown as number;
      mockListStacks.mockResolvedValue(defaultListResponse('EpochStack'));
      mockGetState.mockResolvedValue(record);
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'EpochStack']);

      expect(out.split('\n').filter((l) => l.startsWith('  Last Modified: '))).toEqual([
        `  Last Modified: ${expected}`,
      ]);
    }
  });

  it('never truncates the formatter\'s own sentinel into a digest-shaped prefix', async () => {
    // `(unserializable)` is 16 characters, past the 12-character window, so an
    // unexempted cut renders `(unserializa…` — which reads as a hash prefix, not
    // as the guard having fired. Reached through a digest `JSON.stringify` refuses.
    mockListStacks.mockResolvedValue(defaultListResponse('SentinelStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'SentinelStack',
        skippedOutputs: { Deep: unstringifiableFromParsedJson() as unknown as string },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'SentinelStack']);

    expect(out.split('\n').filter((l) => l.startsWith('  Deep: '))).toEqual([
      '  Deep: (unserializable)',
    ]);
  });

  it('STRIPS an undatable `lastModified` on the way back out', async () => {
    // The fallback is the shared guard, not a bare `String`: this value is not a
    // time AND carries a newline, so returning it raw would forge a row.
    mockListStacks.mockResolvedValue(defaultListResponse('BadDateStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'BadDateStack',
        lastModified: 'not-a-date\nStack: Fake' as unknown as number,
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'BadDateStack']);

    expect(out).toContain('  Last Modified: not-a-dateStack: Fake');
    expect(out.split('\n').filter((l) => l.startsWith('Stack: Fake'))).toEqual([]);
  });

  it('distinguishes an ABSENT `dependencies` from one holding null', async () => {
    // Absent means none. An explicit `null` is a record holding null, and saying
    // `(none)` about it would claim something the record does not say — so the
    // two must not collapse, and the value still goes through the guard.
    mockListStacks.mockResolvedValue(defaultListResponse('DepShapeStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'DepShapeStack',
        resources: {
          ANull: {
            physicalId: 'p-1',
            resourceType: 'AWS::SNS::Topic',
            properties: {},
            dependencies: null as unknown as string[],
          },
          BAbsent: { physicalId: 'p-2', resourceType: 'AWS::SNS::Topic', properties: {} },
          CNumber: {
            physicalId: 'p-3',
            resourceType: 'AWS::SNS::Topic',
            properties: {},
            dependencies: 42 as unknown as string[],
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'DepShapeStack']);
    const rows = out.split('\n').filter((l) => l.startsWith('  Dependencies: '));

    // Sorted by logical id, so: null, absent, number.
    expect(rows).toEqual([
      '  Dependencies: null',
      '  Dependencies: (none)',
      '  Dependencies: 42',
    ]);
  });

  it('survives a `lastModified` that is not a time', async () => {
    // `toISOString` THROWS on it, which empties the render entirely. `version`
    // is deliberately NOT part of this case — the state backend refuses an
    // unreadable one before a renderer sees the record.
    mockListStacks.mockResolvedValue(defaultListResponse('OddMetaStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'OddMetaStack',
        lastModified: 'yesterday' as unknown as number,
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'OddMetaStack']);

    expect(out).toContain('  Last Modified: yesterday');
    expect(out).toContain('Resources (0):');
  });

  it('renders an out-of-range numeric lastModified rather than dying', async () => {
    // Finite but not a valid time: `new Date(1e20).getTime()` is NaN, so a
    // `Number.isFinite` check alone would still let `toISOString` throw.
    mockListStacks.mockResolvedValue(defaultListResponse('FarFutureStack'));
    mockGetState.mockResolvedValue(
      makeState({ stackName: 'FarFutureStack', lastModified: 1e20 })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'FarFutureStack']);

    expect(out).toContain('  Last Modified: 100000000000000000000');
  });

  it('renders a `dependencies` that is a bare string rather than dying', async () => {
    // `"A".length > 0` passes the caller's emptiness guard and then `.join`
    // throws, so the guard has to test array-ness.
    mockListStacks.mockResolvedValue(defaultListResponse('OddDepsStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'OddDepsStack',
        resources: {
          R1: {
            physicalId: 'p-1',
            resourceType: 'AWS::SNS::Topic',
            properties: {},
            dependencies: 'A\nFake: 1' as unknown as string[],
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'OddDepsStack']);

    expect(out).toContain('  Dependencies: AFake: 1');
    expect(out.split('\n').filter((l) => l.startsWith('Fake: 1'))).toEqual([]);
  });

  it('renders a record holding a value that throws on string coercion', async () => {
    // `{"toString": null}` is valid JSON, so a hand-edited record can hold it
    // anywhere, and `JSON.stringify` handles it fine — what throws is COERCION:
    // inside `String(...)`, inside `Array.join` and inside `new Date`. So it
    // reaches three different guards, and it is the shape that decides whether
    // each one wraps the CONSTRUCTION or only the formatting.
    const UNSTRINGIFIABLE = { toString: null } as unknown as string;
    mockListStacks.mockResolvedValue(defaultListResponse('NoStringStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: UNSTRINGIFIABLE,
        lastModified: UNSTRINGIFIABLE as unknown as number,
        resources: {
          R1: {
            physicalId: UNSTRINGIFIABLE,
            resourceType: 'AWS::SNS::Topic',
            properties: {},
            dependencies: [UNSTRINGIFIABLE],
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'NoStringStack']);

    // JSON is what survives: the value is shown, and the render is whole.
    expect(out).toContain('Stack: {"toString":null}');
    expect(out).toContain('  Last Modified: {"toString":null}');
    expect(out).toContain('  PhysicalID: {"toString":null}');
    expect(out).toContain('  Dependencies: {"toString":null}');
    expect(out).toContain('Resources (1):');
  });

  it('names a value `JSON.stringify` refuses, from bytes a record can hold', async () => {
    // `JSON.stringify` exhausts the stack on a deeply nested value where
    // `JSON.parse` does not, so a depth that parses and then refuses exists —
    // which makes this arm reachable from STORED BYTES, not only from a
    // hand-built BigInt. The depth is searched for at run time because the
    // stringify limit is the stack's, so a hardcoded one would flake elsewhere.
    const deep = unstringifiableFromParsedJson();
    mockListStacks.mockResolvedValue(defaultListResponse('DeepStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'DeepStack',
        resources: {
          R1: {
            physicalId: 'p-1',
            resourceType: 'AWS::SNS::Topic',
            properties: {},
            attributes: { Deep: deep },
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'DeepStack']);

    expect(out).toContain('    Deep: (unserializable)');
    expect(out).toContain('  PhysicalID: p-1');
  });

  it('renders a non-string PhysicalID instead of throwing', async () => {
    // Whole-ROW equality, like the cases around it: a substring match would hold
    // while the rest of the row changed. And an OBJECT arm, because a number
    // cannot tell the formatter from `stripControlChars(String(x))` — both render
    // `4242`, so the primitive arm alone leaves the claim pinned for primitives.
    mockListStacks.mockResolvedValue(defaultListResponse('OddPhysStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'OddPhysStack',
        resources: {
          ANumber: {
            physicalId: 4242 as unknown as string,
            resourceType: 'AWS::SNS::Topic',
            properties: {},
          },
          BObject: {
            physicalId: { a: 1 } as unknown as string,
            resourceType: 'AWS::SNS::Topic',
            properties: {},
          },
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'OddPhysStack']);
    const rows = out.split('\n').filter((l) => l.startsWith('  PhysicalID: '));

    // `[object Object]` is what the bare `String(...)` would give for the second.
    expect(rows).toEqual(['  PhysicalID: 4242', '  PhysicalID: {"a":1}']);
    expect(out).toContain('Resources (2):');
  });

  it('renders an `undefined` attribute value instead of throwing', async () => {
    // The `value === undefined` guard was unfenced: without it
    // `stripControlChars(JSON.stringify(undefined))` throws a TypeError,
    // because `JSON.stringify(undefined)` is `undefined` rather than a string.
    // Distinct from the symbol case below — that one reaches the JSON branch,
    // this one is caught before it.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b',
            attributes: { Missing: undefined as unknown as string },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);
    expect(out).toContain('Missing: undefined');
  });

  it('strips control characters from the PhysicalID too (issue #1926 review)', async () => {
    // A physical id is often COMPOSITE — built from template-authored
    // segments — so it can carry whatever those segments carried.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({ resourceType: 'AWS::S3::Bucket', physicalId: 'my\u001bbucket-123' }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);
    const row = out.split('\n').find((l) => l.includes('PhysicalID'));
    expect(row).toBe('  PhysicalID: mybucket-123');
  });

  it('renders an unserializable attribute value instead of throwing', async () => {
    // `JSON.stringify` returns `undefined` — not a string — for a symbol or a
    // function, so stripping its result directly threw. Unreachable from state
    // read out of S3 (JSON has neither), reachable from an in-memory
    // `attributes` bag, and a renderer that throws is worse than one that says
    // what it could not print.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b',
            attributes: { Weird: Symbol('nope') as unknown as string },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);
    expect(out).toContain('Weird: (unserializable)');
  });

  it('strips a control character nested inside a STRUCTURED value', async () => {
    // The other arm of `formatAttributeValue`: a non-scalar is JSON-encoded,
    // and `JSON.stringify` escapes C0 INSIDE a string but passes C1 and the
    // bidi marks through unchanged — so the strip has to run on the encoded
    // text, not only on the scalar branch.
    mockListStacks.mockResolvedValue(defaultListResponse('EvilStack'));
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'EvilStack',
        resources: {
          R: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b',
            properties: { Tags: [{ Key: 'env', Value: 'pr\u202eod' }] },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EvilStack']);

    const row = out.split('\n').find((l) => l.includes('Tags'));
    expect(row).toBe('    Tags: [{"Key":"env","Value":"prod"}]');
  });

  it('omits the Outputs section when outputs are empty', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('AnyStack'));
    mockGetState.mockResolvedValue(makeState({ outputs: {} }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'AnyStack']);

    expect(out).not.toContain('Outputs:');
  });

  it('renders a Skipped outputs block naming each key and a truncated digest (issue #2772)', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('SkipStack'));
    mockGetState.mockResolvedValue(
      makeState({
        outputs: { Live: 'http://x' },
        // Inserted in REVERSE alphabetical order, so the row order below
        // pins the comparator rather than the object's insertion order.
        skippedOutputs: {
          Endpoint: 'b'.repeat(64),
          ApiUrl: 'a'.repeat(64),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'SkipStack']);

    expect(out).toContain('Skipped outputs:');
    // The KEY is the point of the block. The record covers BOTH failure arms,
    // and they differ: an output whose resolver THREW is already named by the
    // deploy's own warn, while one that quietly returned `undefined` gets no
    // per-output warn at all. For the quiet arm, while the key is absent from
    // the stored bag -- as here -- this block is the only place the name
    // appears in the human-readable view; a key whose earlier value was
    // retained also shows under `Outputs:`. `--json` carries it either way.
    expect(out).toContain('ApiUrl');
    expect(out).toContain('Endpoint');
    // TRUNCATED, not whole: 12 of the 64 hex characters. Asserted as an
    // absence of the full digest as well, because `toContain` on the prefix
    // alone passes against an untruncated render.
    expect(out).toContain(`ApiUrl: ${'a'.repeat(12)}…`);
    expect(out).toContain(`Endpoint: ${'b'.repeat(12)}…`);
    expect(out).not.toContain('a'.repeat(13));
    expect(out).not.toContain('b'.repeat(13));
    // Sorted, not insertion-ordered.
    const rows = out.split('\n');
    const apiRow = rows.findIndex((l) => l.startsWith('  ApiUrl:'));
    const endpointRow = rows.findIndex((l) => l.startsWith('  Endpoint:'));
    expect(apiRow).toBeGreaterThan(-1);
    expect(endpointRow).toBeGreaterThan(apiRow);
    // The retained-value qualification: the record does NOT suppress such a
    // key, and the ordinary path can end in the whole Outputs section going —
    // the opposite of the legend's own "no row, no warning".
    // Whitespace-normalised: the legend is hard-wrapped, so any phrase can
    // straddle a line break and a raw `toContain` would then miss it.
    const legendText = out.replace(/\s+/g, ' ');
    expect(legendText).toContain('does NOT suppress it');
    // WHOSE Outputs section: the legend's first `Outputs:` is this view's own
    // block, the suppression is `cdkd diff`'s. Dropping the attribution leaves
    // a sentence that reads as `state show` hiding its own section.
    expect(legendText).toContain('`cdkd diff` suppressing its whole Outputs section');
    // The block explains the SILENT diff behaviour AND points at the rule.
    // Both halves are pinned because either survives deleting the other: a
    // pointer-only assertion passes against a legend with no explanation, and
    // an explanation-only one passes against a legend with no pointer. What
    // they keep is both halves present, not the prose in step with the code.
    expect(legendText).toContain('could not resolve the keys listed');
    expect(legendText).toContain('ABSENT');
    expect(legendText).toContain('bindingSkippedOutputs');
    // The neighbouring section still renders its row in full. Anchored,
    // because the legend itself contains the literal `Outputs:` and would
    // satisfy a bare `toContain` even with the section gone.
    expect(out).toContain('\nOutputs:\n');
    expect(out).toContain('  Live: http://x');
  });

  it('the fixture keeps ABSENT and present-but-empty distinguishable', async () => {
    // The two omission cases below would both pass against a helper that
    // defaulted the field to `{}`, which would make the absent case a
    // restatement of the empty one. This pins the fixture itself so those
    // two names keep meaning what they say.
    const absent = makeState({ outputs: { Live: 'http://x' } }).state;
    expect(Object.prototype.hasOwnProperty.call(absent, 'skippedOutputs')).toBe(false);

    const empty = makeState({ skippedOutputs: {} }).state;
    expect(Object.prototype.hasOwnProperty.call(empty, 'skippedOutputs')).toBe(true);
    expect(empty.skippedOutputs).toEqual({});
  });

  it('omits the Skipped outputs block when the field is absent (pre-#2740 records)', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('NoSkipStack'));
    mockGetState.mockResolvedValue(makeState({ outputs: { Live: 'http://x' } }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'NoSkipStack']);

    expect(out).not.toContain('Skipped outputs:');
    // Not vacuous: the record rendered, it simply carried no skipped set.
    expect(out).toContain('Outputs:');
  });

  it('omits the Skipped outputs block when the field is present but EMPTY', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('EmptySkipStack'));
    mockGetState.mockResolvedValue(makeState({ skippedOutputs: {} }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EmptySkipStack']);

    expect(out).not.toContain('Skipped outputs:');
    // Not vacuous for the same reason as the absent case: the block is gone
    // because the set is empty, not because nothing rendered.
    expect(out).toContain('Resources (');
  });

  it('STRIPS control characters from a Skipped outputs KEY', async () => {
    // A bare ESC plus a bidi override, following the Outputs-row case above:
    // only the control CHARACTER is removed, so a full `\u001b[31m` would
    // leave `[31m` behind and an expectation written around it could not tell
    // a strip from a rewrite. These keys are template `Outputs` keys rather
    // than resolved export names, so this is defence against a template cdkd
    // never validated, not against a value it resolved.
    mockListStacks.mockResolvedValue(defaultListResponse('SkipCtrlStack'));
    mockGetState.mockResolvedValue(
      makeState({
        skippedOutputs: { 'Api\u001bUrl\u202e': 'c'.repeat(64) },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'SkipCtrlStack']);

    // Scoped to the ROW and asserted whole, so a surviving escape anywhere in
    // the rendered key fails rather than being absorbed by a `toContain`.
    const skippedRow = out.split('\n').find((l) => l.includes('ApiUrl'));
    expect(skippedRow).toBe(`  ApiUrl: ${'c'.repeat(12)}…`);
  });

  it('tolerates a non-string digest instead of killing the whole render', async () => {
    // State is read as an unchecked cast, so this map's value types are
    // whatever the object holds. A String method called directly on the digest
    // would throw, and because `renderStateBlock` builds every line before
    // anything is written, that would cost the stack header and every resource
    // as well — an empty stdout rather than a partial block.
    for (const [bad, shown] of [
      [12345, '12345'],
      [null, 'null'],
      [{ nested: true }, '{"nested":tr…'],
    ] as const) {
      mockListStacks.mockResolvedValue(defaultListResponse('OddDigestStack'));
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'OddDigestStack',
          outputs: { Live: 'http://x' },
          skippedOutputs: { ApiUrl: bad as unknown as string },
          resources: {
            R1: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'r-1' }),
          },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'OddDigestStack']);

      // The render SURVIVES, asserted on CONTENT rather than on a header that
      // a zero-resource record would print anyway: the stack header, the
      // sibling output's value, and the resource's own rows.
      expect(out).toContain('Stack: OddDigestStack');
      expect(out).toContain('  Live: http://x');
      expect(out).toContain('Resources (1):');
      expect(out).toContain('  PhysicalID: r-1');
      // The CELL, not just its presence: `toBeDefined()` alone stays green
      // with the digest replaced by an empty string, which would render the
      // fix inert while looking fixed.
      const row = out.split('\n').find((l) => l.startsWith('  ApiUrl:'));
      expect(row, `row for digest ${JSON.stringify(bad)}`).toBe(`  ApiUrl: ${shown}`);
    }
  });

  it('marks a digest ONLY when it was actually cut', async () => {
    // The boundary: a value exactly the window's length is NOT truncated, so
    // it takes no marker. A fixture formatting to exactly the window's length
    // is what separates `>` from `>=`.
    mockListStacks.mockResolvedValue(defaultListResponse('BoundaryStack'));
    mockGetState.mockResolvedValue(
      makeState({
        skippedOutputs: {
          Exactly: 'e'.repeat(12),
          OneMore: 'f'.repeat(13),
          Short: 'ab',
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'BoundaryStack']);
    const rowFor = (k: string) => out.split('\n').find((l) => l.startsWith(`  ${k}:`));

    expect(rowFor('Exactly')).toBe(`  Exactly: ${'e'.repeat(12)}`);
    expect(rowFor('OneMore')).toBe(`  OneMore: ${'f'.repeat(12)}…`);
    expect(rowFor('Short')).toBe('  Short: ab');
  });

  it('STRIPS control characters from the DIGEST, not only the key', async () => {
    // An ANSI CSI fits inside the 12 shown characters. Stripping happens
    // either way, so the ORDER is about how many printable characters survive:
    // strip-then-slice yields a full 12, slice-then-strip yields 11.
    mockListStacks.mockResolvedValue(defaultListResponse('EscDigestStack'));
    mockGetState.mockResolvedValue(
      makeState({ skippedOutputs: { ApiUrl: '\u001b[2Jabcdefghijklmnop' } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EscDigestStack']);

    const row = out.split('\n').find((l) => l.startsWith('  ApiUrl:'));
    // Whole-row equality: the ESC is gone AND the strip happened BEFORE the
    // truncation, so the reader gets 12 printable characters rather than 11.
    // 12 printable characters once the ESC is gone, asserted WHOLE so a
    // miscount cannot hide behind a prefix match.
    expect(row).toBe('  ApiUrl: [2Jabcdefghi…');
    expect(out).not.toContain('\u001b');
  });

  it('renders the block with no Outputs: section above it', async () => {
    // The first-deploy case this record exists for: every output failed, so
    // the bag is empty and `Outputs:` is omitted entirely. The legend must not
    // claim a section that is not on the screen.
    mockListStacks.mockResolvedValue(defaultListResponse('NoOutputsStack'));
    mockGetState.mockResolvedValue(
      makeState({ outputs: {}, skippedOutputs: { ApiUrl: 'a'.repeat(64) } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'NoOutputsStack']);

    expect(out).toContain('Skipped outputs:');
    // No `Outputs:` SECTION rendered. The anchored form matters: the legend
    // itself contains the literal `Outputs:`, so an unanchored check would
    // fail on the legend rather than on a section.
    expect(out).not.toContain('Outputs:\n');
    // ...and the legend does not claim one is on the screen. It legitimately
    // says "listed under `Skipped outputs:` above", naming the block it
    // explains, so what must NOT appear is that phrasing pointed at
    // `Outputs:`. Whitespace-normalised because the referent and the word
    // `above` fall on different rendered lines, and a raw `toContain` would
    // miss the pairing.
    const flat = out.replace(/\s+/g, ' ');
    expect(flat).toContain('under `Skipped outputs:` above');
    expect(flat).not.toContain('under `Outputs:` above');
  });

  it('the legend sits at column zero, not at the rows indent', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('IndentStack'));
    mockGetState.mockResolvedValue(
      makeState({ skippedOutputs: { ApiUrl: 'a'.repeat(64) } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'IndentStack']);

    // EVERY indented line from the header to the next block must be a
    // `key: value` row, so `grep '^  '` cannot pick up prose. Checking only
    // the first would pass with the rest of the legend re-indented, including
    // the line quoting `Outputs:` mid-sentence, which an indented substring
    // match would then read as a row.
    const rows = out.split('\n');
    const start = rows.findIndex((l) => l === 'Skipped outputs:');
    expect(start).toBeGreaterThan(-1);
    const nextBlock = rows.findIndex((l, i) => i > start && l.startsWith('Resources ('));
    expect(nextBlock).toBeGreaterThan(start);
    const indented = rows.slice(start + 1, nextBlock).filter((l) => l.startsWith('  '));
    expect(indented).toEqual([`  ApiUrl: ${'a'.repeat(12)}…`]);
    // ...and EVERY nonblank legend line is at column zero, not just the
    // opening sentence: indenting the continuations by a space or a tab is the
    // shape that otherwise slips through.
    const span = rows.slice(start + 1, nextBlock);
    const prose = span.filter((l) => l !== '' && l !== `  ApiUrl: ${'a'.repeat(12)}…`);
    expect(prose.length, 'the legend is in this span').toBeGreaterThan(1);
    expect(prose.filter((l) => /^\s/.test(l))).toEqual([]);
  });

  it('the legend the binary PRINTS is the legend docs/cli-state.md shows', async () => {
    // The legend's lines are duplicated verbatim into the docs page and nothing
    // synced them, so any reword left the docs copy stale in silence — the same
    // class of defect as a comment that stops matching its code.
    //
    // Derived from the RENDER, not from the source text: reading the array
    // literal would compare one copy of the string against another copy of the
    // string, which two copies drifting the same way would satisfy. Rendering
    // makes the BINARY's output the authority.
    mockListStacks.mockResolvedValue(defaultListResponse('SyncStack'));
    mockGetState.mockResolvedValue(
      makeState({ skippedOutputs: { ApiUrl: 'a'.repeat(64) } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'SyncStack']);

    // Both sides are anchored on the BLOCK HEADER and take everything at column
    // zero up to the next section — not on the legend's first sentence, which
    // would leave a PREPENDED sentence outside the compared region on either
    // side. The indented rows are dropped because the docs copy uses an example
    // key rather than this fixture's.
    const columnZeroLegend = (lines: string[], from: number, to: number) =>
      lines.slice(from + 1, to).filter((l) => l !== '' && !l.startsWith('  '));

    // The SAME bound on both sides: the render always has a `Resources (` header
    // after the legend, while the documented example may or may not show one.
    // Bounding only the render makes extending the example with that section --
    // a legitimate docs edit that changes no legend line -- fail this case.
    const untilNextSection = (lines: string[], from: number) => {
      const at = lines.findIndex((l, i) => i > from && /^Resources \(/.test(l));
      return at === -1 ? lines.length : at;
    };

    const rows = out.split('\n');
    const blockAt = rows.indexOf('Skipped outputs:');
    expect(blockAt, 'the render carries the block').toBeGreaterThan(-1);
    const resourcesAt = untilNextSection(rows, blockAt);
    expect(resourcesAt, 'the resources header bounds the legend').toBeGreaterThan(blockAt);
    const legend = columnZeroLegend(rows, blockAt, resourcesAt);
    // A floor, so a selection that silently collapsed to one line cannot pass.
    expect(legend.length).toBeGreaterThanOrEqual(6);

    // The docs side is read by RENDERING the page, not by scanning it for fences.
    // Hand-parsing them was wrong twice: walking up from the header picks a
    // fence-like LINE OF CONTENT as the opener, and an example indented by a
    // space is a legitimate edit that an exact line lookup misses. `marked` is
    // already the repo's answer to "what does a reader actually see" — see
    // `tests/unit/scripts/rule-file-payload.test.ts` — and its code token hands
    // back the block's text with the fence gone and the indentation normalized.
    const page = readFileSync(resolve(import.meta.dirname, '../../../docs/cli-state.md'), 'utf-8');
    // `walkTokens`, not a filter over the top level: a code block inside a
    // blockquote or a list item renders to a reader exactly the same and would
    // otherwise be invisible here, in both directions — a stale nested copy would
    // pass, and moving this example into a blockquote would find none.
    const copies: string[][] = [];
    marked.walkTokens(marked.lexer(page), (token) => {
      if (token.type !== 'code') return;
      const lines = (token as Tokens.Code).text.split('\n');
      if (lines.includes('Skipped outputs:')) copies.push(lines);
    });

    // EXACTLY one, and then EVERY one: `find` would check the first and let a
    // second example carry stale prose, or let a matching block added earlier
    // mask the one this section is about.
    expect(copies, 'docs/cli-state.md carries the block in one code example').toHaveLength(1);

    // The whole SEQUENCE, not per-line inclusion: reordering two lines always
    // passes an inclusion check, and a dropped or shortened line passes it
    // whenever the original line still appears anywhere else on the page.
    // EVERY occurrence, not the first in each block: one example can show two
    // renders, and checking only the first lets a matching copy mask a stale one
    // below it.
    for (const lines of copies) {
      const heads = lines.flatMap((l, i) => (l === 'Skipped outputs:' ? [i] : []));
      expect(heads.length, 'the example shows at least one block').toBeGreaterThan(0);
      for (const at of heads) {
        expect(columnZeroLegend(lines, at, untilNextSection(lines, at))).toEqual(legend);
      }
    }
  });

  it('the pointer the legend SHIPS resolves: symbol exists, cited path exists', async () => {
    // The legend is user-visible text naming a symbol and a source file, and
    // asserting the literal string only proves the string is there. A rename
    // or a file move would otherwise ship a dangling pointer. Same shape as
    // `docs-site-links.test.ts`.
    mockListStacks.mockResolvedValue(defaultListResponse('PointerStack'));
    mockGetState.mockResolvedValue(makeState({ skippedOutputs: { ApiUrl: 'a'.repeat(64) } }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'PointerStack']);

    // Both halves are DERIVED from the rendered text, so a move, or a rename
    // within the subset the identifier filter accepts, reds here rather than
    // leaving a dangling pointer in shipped output.
    const cited = [...out.matchAll(/src\/[\w/-]+\.ts/g)].map((m) => m[0]);
    expect(cited.length, 'the legend cites at least one source path').toBeGreaterThan(0);
    for (const path of cited) {
      expect(existsSync(resolve(import.meta.dirname, '../../../', path)), path).toBe(true);
    }

    // ...and every backticked run matching an ASCII bare identifier must be
    // exported by the module the legend cites. ASCII is a SUBSET of what a JS
    // identifier may be — it covers the one this legend names today, and a
    // non-ASCII one would be skipped. Deliberately not a naming-convention
    // filter, which would drop names on a narrower and less obvious basis.
    const named = [...out.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1] ?? '')
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    expect(named.length, 'the legend names at least one symbol').toBeGreaterThan(0);
    const mod = (await import(`../../../${cited[0]}`)) as Record<string, unknown>;
    for (const sym of named) {
      expect(typeof mod[sym], `${sym} exported by ${cited[0]}`).toBe('function');
    }
  });

  it('a CHILD-only or GRANDCHILD-only skipped set still earns the legend, once', async () => {
    // `treeOwesSkippedLegend` recurses. With the parent carrying the set the
    // recursion short-circuits, so deleting the descendant scan survives that
    // fixture -- these two are what pin it.
    for (const carrier of ['NestedSkip~Child', 'NestedSkip~Child~Grandchild'] as const) {
      mockListStacks.mockResolvedValue([{ stackName: 'NestedSkip', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name: string) => {
        const skipped =
          name === carrier ? { OnlyHere: 'a'.repeat(64) } : (undefined as unknown as undefined);
        if (name === 'NestedSkip') {
          return makeState({
            stackName: 'NestedSkip',
            ...(skipped !== undefined && { skippedOutputs: skipped }),
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedSkip~Child',
              }),
            },
          });
        }
        if (name === 'NestedSkip~Child') {
          return makeState({
            stackName: 'NestedSkip~Child',
            ...(skipped !== undefined && { skippedOutputs: skipped }),
            resources: {
              Grandchild: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedSkip~Child~Grandchild',
              }),
            },
          });
        }
        return makeState({
          stackName: 'NestedSkip~Child~Grandchild',
          ...(skipped !== undefined && { skippedOutputs: skipped }),
        });
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'NestedSkip', '--show-nested']);

      // Counted as a HEADER LINE, not a substring: the legend now names the
      // block it explains, so `Skipped outputs:` appears in the prose too.
      const headers = out.split('\n').filter((l) => l === 'Skipped outputs:');
      expect(headers, `block for ${carrier}`).toHaveLength(1);
      expect(
        out.split('The last deploy could not resolve the keys listed').length - 1,
        `legend for ${carrier}`
      ).toBe(1);
    }
  });

  it('the legend FOLLOWS the block it explains', async () => {
    // Split out of the recursion case above: counting occurrences passes with the
    // legend printed BEFORE the block, so the order needs a claim of its own
    // rather than a third assertion inside a case named for something else.
    mockListStacks.mockResolvedValue(defaultListResponse('OrderStack'));
    mockGetState.mockResolvedValue(
      makeState({ stackName: 'OrderStack', skippedOutputs: { Only: 'a'.repeat(64) } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'OrderStack']);

    const lines = out.split('\n');
    const block = lines.findIndex((l) => l === 'Skipped outputs:');
    const legend = lines.findIndex((l) => l.startsWith('The last deploy'));
    expect(block).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(block);
  });

  it('a resource logical id spelled like the header emits NO legend', async () => {
    // A logical id is printed on its own line, and stripping it leaves a
    // hand-edited `Skipped outputs:` unchanged. A tree renderer that decided
    // the legend by scanning rendered lines for the header would emit one for
    // a stack that skipped nothing.
    mockListStacks.mockResolvedValue([{ stackName: 'SpoofRoot', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'SpoofRoot',
        resources: {
          'Skipped outputs:': makeResource({
            resourceType: 'AWS::SNS::Topic',
            physicalId: 'arn:spoof',
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'SpoofRoot', '--show-nested']);

    expect(out).toContain('Skipped outputs:');
    expect(out).not.toContain('The last deploy could not resolve the keys listed');
  });

  it('emits the legend for a CHILDLESS root under --show-nested', async () => {
    // A root with a skipped set and no children still owes the legend once.
    mockListStacks.mockResolvedValue([{ stackName: 'LoneRoot', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(
      makeState({ stackName: 'LoneRoot', skippedOutputs: { Only: 'a'.repeat(64) } })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const nested = await runStateShow(['show', 'LoneRoot', '--show-nested']);

    expect(nested.split('\n').filter((l) => l === 'Skipped outputs:')).toHaveLength(1);
    expect(nested.split('The last deploy could not resolve the keys listed').length - 1).toBe(1);
    expect(nested).not.toContain('Nested stack:');

    // ...and it moved to the END of the tree, which is what the JSDoc claims and
    // what counting occurrences cannot see: a variant printing the legend inline
    // when the ROOT owes it, and at the end only for a descendant, emits exactly
    // one either way. The position is the only thing that separates them, so the
    // single-stack path is rendered here too as the comparand.
    const posOf = (out: string) => {
      const lines = out.split('\n');
      return {
        legend: lines.findIndex((l) => l.startsWith('The last deploy')),
        resources: lines.findIndex((l) => /^Resources \(/.test(l)),
      };
    };
    const n = posOf(nested);
    expect(n.resources).toBeGreaterThan(-1);
    expect(n.legend, 'under --show-nested the legend is last').toBeGreaterThan(n.resources);

    const plain = await runStateShow(['show', 'LoneRoot']);
    const pl = posOf(plain);
    expect(pl.resources).toBeGreaterThan(-1);
    // Present BEFORE ordered: `findIndex` returns -1 for a missing legend, which
    // is less than any real index, so the order check alone passes on no legend.
    expect(pl.legend, 'the single-stack path renders a legend at all').toBeGreaterThan(-1);
    expect(pl.legend, 'on the single-stack path it stays with its block').toBeLessThan(
      pl.resources
    );
  });

  it('a tree node carrying an EMPTY skipped map gets neither block nor legend', async () => {
    // The single-predicate property: the tree's legend guard and the block's
    // own guard must answer the same question. This fixture separates field
    // PRESENCE from a NON-EMPTY map on the nested path, so a tree guard asking
    // `skippedOutputs !== undefined` emits the legend with no block anywhere
    // in the tree.
    mockListStacks.mockResolvedValue([{ stackName: 'EmptyMapTree', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async (name: string) =>
      name === 'EmptyMapTree'
        ? makeState({
            stackName: 'EmptyMapTree',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::EmptyMapTree~Child',
              }),
            },
          })
        : makeState({ stackName: 'EmptyMapTree~Child', skippedOutputs: {} })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'EmptyMapTree', '--show-nested']);

    expect(out).toContain('Nested stack: EmptyMapTree~Child');
    expect(out.split('\n').filter((l) => l === 'Skipped outputs:')).toHaveLength(0);
    expect(out).not.toContain('The last deploy could not resolve the keys listed');
  });

  it('emits NO legend for a tree where nothing was skipped', async () => {
    // The other side of the guard: a tree that owes no legend must not get
    // one, which is what unconditional emission would break.
    mockListStacks.mockResolvedValue([{ stackName: 'CleanTree', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async (name: string) =>
      name === 'CleanTree'
        ? makeState({
            stackName: 'CleanTree',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::CleanTree~Child',
              }),
            },
          })
        : makeState({ stackName: 'CleanTree~Child' })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'CleanTree', '--show-nested']);

    expect(out).toContain('Nested stack: CleanTree~Child');
    expect(out).not.toContain('Skipped outputs:');
    expect(out).not.toContain('The last deploy could not resolve the keys listed');
  });

  it('emits the legend ONCE for a nested tree, not per child', async () => {
    const child = makeState({
      stackName: 'Parent~Child',
      skippedOutputs: { ChildUrl: 'b'.repeat(64) },
    }).state;
    const parent = makeState({
      stackName: 'Parent',
      resources: {
        Child: {
          physicalId: 'arn:child',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
        },
      },
      skippedOutputs: { ParentUrl: 'a'.repeat(64) },
    }).state;
    mockListStacks.mockResolvedValue(defaultListResponse('Parent'));
    mockGetState.mockImplementation(async (name: string) =>
      name === 'Parent' ? { state: parent } : { state: child }
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'Parent', '--show-nested']);

    // Both blocks render; the explanation does not repeat. Header LINES, not
    // substrings -- the legend names the block, so the literal appears there.
    expect(out.split('\n').filter((l) => l === 'Skipped outputs:')).toHaveLength(2);
    expect(out.split('The last deploy could not resolve the keys listed').length - 1).toBe(1);
  });

  it('emits a `{state, lock}` JSON object with --json', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('JsonStack', 'us-west-2'));
    const stateRecord = makeState({
      stackName: 'JsonStack',
      region: 'us-west-2',
      outputs: { Endpoint: 'http://x' },
      // `docs/cli-state.md` sends readers to `--json` for an EXACT digest
      // comparison, so the untruncated digest is part of that promise.
      skippedOutputs: { ApiUrl: 'a'.repeat(64) },
      resources: {
        R1: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'r-1' }),
      },
    });
    const lockRecord: LockInfo = {
      owner: 'ci@runner:9999',
      operation: 'destroy',
      timestamp: 100,
      expiresAt: 200,
    };
    mockGetState.mockResolvedValue(stateRecord);
    mockGetLockInfo.mockResolvedValue(lockRecord);

    const out = await runStateShow(['show', 'JsonStack', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed.state.stackName).toBe('JsonStack');
    expect(parsed.state.region).toBe('us-west-2');
    expect(parsed.state.outputs).toEqual({ Endpoint: 'http://x' });
    expect(parsed.state.resources.R1.physicalId).toBe('r-1');
    // WHOLE, not the 12 the text view shows -- this is the claim the docs make
    // when they send a reader here for an exact comparison.
    expect(parsed.state.skippedOutputs).toEqual({ ApiUrl: 'a'.repeat(64) });
    expect(parsed.lock).toEqual(lockRecord);
  });

  it('emits `lock: null` in JSON when the stack is unlocked', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('UnlockedStack'));
    mockGetState.mockResolvedValue(makeState({ stackName: 'UnlockedStack' }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'UnlockedStack', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed.lock).toBeNull();
  });

  // #555 A4: recursive child stack rendering.
  describe('--show-nested', () => {
    it('appends a Nested stack block per child in DFS order (3-level deep)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'NestedStackDeep', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'NestedStackDeep') {
          return makeState({
            stackName: 'NestedStackDeep',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedStackDeep~Child',
              }),
            },
          });
        }
        if (name === 'NestedStackDeep~Child') {
          return makeState({
            stackName: 'NestedStackDeep~Child',
            parentStack: 'NestedStackDeep',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
            resources: {
              Grandchild: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedStackDeep~Child~Grandchild',
              }),
            },
          });
        }
        return makeState({
          stackName: 'NestedStackDeep~Child~Grandchild',
          parentStack: 'NestedStackDeep~Child',
          parentLogicalId: 'Grandchild',
          parentRegion: 'us-east-1',
          resources: {
            Leaf: makeResource({ resourceType: 'AWS::S3::Bucket', physicalId: 'leaf-bkt' }),
          },
        });
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'NestedStackDeep', '--show-nested']);

      // Parent block first.
      expect(out).toContain('Stack: NestedStackDeep');
      // Then each child as its own `Nested stack: <name>` block in DFS order.
      const childIdx = out.indexOf('Nested stack: NestedStackDeep~Child');
      const grandchildIdx = out.indexOf('Nested stack: NestedStackDeep~Child~Grandchild');
      expect(childIdx).toBeGreaterThan(-1);
      expect(grandchildIdx).toBeGreaterThan(childIdx);
      // Each child block carries the v6 parent link.
      expect(out).toContain('  Parent: NestedStackDeep (us-east-1), logical id: Child');
      expect(out).toContain(
        '  Parent: NestedStackDeep~Child (us-east-1), logical id: Grandchild'
      );
      // Grandchild's own resource is rendered too.
      expect(out).toContain('Leaf');
      expect(out).toContain('  Type: AWS::S3::Bucket');
    });

    it('is a no-op on a leaf with no nested children (single-stack output)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Leaf', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'Leaf',
          resources: { Bkt: makeResource({ resourceType: 'AWS::S3::Bucket' }) },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Leaf', '--show-nested']);

      expect(out).toContain('Stack: Leaf');
      expect(out).not.toContain('Nested stack:');
    });

    it('shows only the child block when invoked against a child directly (no grandchildren)', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent~Child', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'Parent~Child',
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
          resources: { Q: makeResource({ resourceType: 'AWS::SQS::Queue' }) },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Parent~Child', '--show-nested']);

      expect(out).toContain('Stack: Parent~Child');
      expect(out).toContain('  Parent: Parent (us-east-1), logical id: Child');
      expect(out).not.toContain('Nested stack:');
    });

    it('emits a nested {state, lock, children} JSON shape', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Parent', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return makeState({
            stackName: 'Parent',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~Child',
              }),
            },
          });
        }
        return makeState({
          stackName: 'Parent~Child',
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
          resources: { R: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'r-1' }) },
        });
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Parent', '--show-nested', '--json']);
      const parsed = JSON.parse(out);

      expect(parsed.state.stackName).toBe('Parent');
      expect(parsed.lock).toBeNull();
      expect(parsed.children).toHaveLength(1);
      expect(parsed.children[0].state.stackName).toBe('Parent~Child');
      expect(parsed.children[0].state.parentStack).toBe('Parent');
      expect(parsed.children[0].lock).toBeNull();
      // Stable key set: `children: []` on leaves rather than omitted.
      expect(parsed.children[0].children).toEqual([]);
    });

    it('combines with --stack-region to disambiguate when same name lives in two regions', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent', region: 'us-west-2' },
        { stackName: 'Parent', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name, region) => {
        if (name === 'Parent' && region === 'us-east-1') {
          return makeState({
            stackName: 'Parent',
            region: 'us-east-1',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~Child',
              }),
            },
          });
        }
        if (name === 'Parent~Child' && region === 'us-east-1') {
          return makeState({
            stackName: 'Parent~Child',
            region: 'us-east-1',
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
          });
        }
        return null;
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow([
        'show',
        'Parent',
        '--show-nested',
        '--stack-region',
        'us-east-1',
      ]);

      expect(out).toContain('Stack: Parent');
      expect(out).toContain('  Region: us-east-1');
      expect(out).toContain('Nested stack: Parent~Child');
    });

    it('a NEWLINE in a child name cannot forge a row in its header', async () => {
      // The header name is built as `<parent>~<logicalId>`, and the logical id
      // is a KEY of the parent's hand-editable `resources` map — so the flat
      // rule reaches this row too, and it is the only row this command renders
      // from a name it derived rather than read.
      const EVIL_ID = 'Child\nStack: Fake';
      mockListStacks.mockResolvedValue([{ stackName: 'Parent', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return makeState({
            stackName: 'Parent',
            resources: {
              [EVIL_ID]: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: `cdkd-local::stack::Parent~${EVIL_ID}`,
              }),
            },
          });
        }
        if (name === `Parent~${EVIL_ID}`) {
          return makeState({
            stackName: `Parent~${EVIL_ID}`,
            parentStack: 'Parent',
            parentLogicalId: EVIL_ID,
            parentRegion: 'us-east-1',
          });
        }
        return null;
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Parent', '--show-nested']);

      // Unstripped, the header's own newline ends the row and `Stack: Fake`
      // begins a forged one that reads exactly like a top-level stack header.
      expect(out).toContain('Nested stack: Parent~ChildStack: Fake');
      expect(out.split('\n').filter((l) => l.startsWith('Stack: Fake'))).toEqual([]);
    });

    it('fails fast on a torn tree (parent lists nested-stack row but child state missing)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Parent', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return makeState({
            stackName: 'Parent',
            resources: {
              GhostChild: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~GhostChild',
              }),
            },
          });
        }
        return null;
      });
      mockGetLockInfo.mockResolvedValue(null);

      await expect(
        runStateShow(['show', 'Parent', '--show-nested'])
      ).rejects.toThrow();

      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/missing nested-child 'Parent~GhostChild'/);
    });
  });

  // --- issue #2944: the refused-baseline row -------------------------------

  describe('ObservedBaseline row (schema v10, issue #2944)', () => {
    it('renders REFUSED for a marked resource and NOTHING for an unmarked one', () => {
      // This row is the affordance a user reaches for when `cdkd state
      // refresh-observed` starts declining a resource: the command tells them a
      // refusal happened, and this is where they find out WHICH resource and
      // that a plain re-run will not clear it. `--json` carries the field for
      // free, so without this case the human row could be deleted and nothing
      // would red.
      //
      // Both polarities in one case, because the row is conditional: it is
      // printed ONLY when set, unlike the `ProvisionedBy` row above, whose
      // absence is itself a fact worth naming. A `(not refused)` row on every
      // resource of every stack would bury the one that matters — so the
      // unmarked half is the half that pins that decision.
      mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'MyStack',
          resources: {
            Refused: makeResource({
              resourceType: 'AWS::SSM::Parameter',
              physicalId: 'refused-param',
              observedBaselineRefused: true,
            }),
            Ordinary: makeResource({
              resourceType: 'AWS::S3::Bucket',
              physicalId: 'ordinary-bucket',
            }),
          },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      return runStateShow(['show', 'MyStack']).then((out) => {
        expect(out).toContain('ObservedBaseline: REFUSED');
        // The remedy has to be ON the row: a user who reads only "REFUSED"
        // re-runs `refresh-observed`, which declines it again with no new
        // information.
        expect(out).toMatch(/deploy a change to this resource/i);

        // Exactly ONE row, for exactly the marked resource — a row rendered
        // unconditionally would also satisfy `toContain` above.
        const rows = out.split('\n').filter((l) => l.includes('ObservedBaseline'));
        expect(rows).toHaveLength(1);

        // ...and it sits under `Refused`, not under `Ordinary`. Both resources
        // render, so a row attached to the wrong record would still count one.
        //
        // Asserted as "the nearest PhysicalID line above the row" rather than
        // by comparing the two resources' positions: the render order of the
        // resources bag is not this case's subject, and an ordering assumption
        // here failed once already (the bag renders `Ordinary` first).
        const lines = out.split('\n');
        const rowAt = lines.findIndex((l) => l.includes('ObservedBaseline'));
        expect(rowAt).toBeGreaterThan(0);
        const owner = lines
          .slice(0, rowAt)
          .reverse()
          .find((l) => l.includes('PhysicalID:'));
        expect(owner).toContain('refused-param');
        // Both resources really did render — otherwise "the row's owner is the
        // refused one" is satisfied by a report that dropped the other.
        expect(out).toContain('ordinary-bucket');
      });
    });
  });
});
