import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275): the confirmation
 * prompt this file drives now REFUSES a non-interactive stdin
 * (`CdkdError` / `NON_INTERACTIVE_CONFIRM`, from the shared
 * `confirmOrRefuse` helper) instead of hanging on a `question` an EOF stdin
 * can never settle. Vitest's stdin is NOT a TTY, so every case that exercises
 * the PROMPT has to present as interactive; the refusal cases set it back.
 */
import { setStdinIsTty } from '../../stdin-tty.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
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
  resolveApp: vi.fn(() => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockGetState = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn());
const mockListStacks = vi.hoisted(() => vi.fn());
const mockVerifyBucketExists = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    saveState: mockSaveState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn(async () => true));
// Issue #2170: production calls `getLockInfo` to name the holder. Without it
// on the mock the call THREW, the best-effort catch swallowed it, and the
// assertion below still matched the degraded wording — so the test certified
// nothing about this change.
const mockGetLockInfo = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
const mockReleaseLock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

const mockRegisterAllProviders = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: mockRegisterAllProviders,
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(() => ({ getAttribute: vi.fn(async () => undefined) })),
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';

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

async function runOrphan(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createOrphanCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function templateWith(
  metadata: Record<string, string>,
  extras: Record<string, { Type: string; cdkPath?: string }> = {}
): {
  Resources: Record<string, { Type: string; Metadata?: { 'aws:cdk:path': string } }>;
} {
  const Resources: Record<string, { Type: string; Metadata?: { 'aws:cdk:path': string } }> = {};
  for (const [logicalId, path] of Object.entries(metadata)) {
    Resources[logicalId] = {
      Type: 'AWS::S3::Bucket',
      Metadata: { 'aws:cdk:path': path },
    };
  }
  for (const [logicalId, { Type, cdkPath }] of Object.entries(extras)) {
    Resources[logicalId] = {
      Type,
      ...(cdkPath !== undefined && { Metadata: { 'aws:cdk:path': cdkPath } }),
    };
  }
  return { Resources };
}

let originalIsTTY: boolean | undefined;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
});

describe('cdkd orphan (per-resource)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"new-etag"');
    mockListStacks.mockReset();
    mockListStacks.mockResolvedValue([]);
    mockAcquireLock.mockReset();
    mockAcquireLock.mockResolvedValue(true);
    mockReleaseLock.mockReset();
    mockReleaseLock.mockResolvedValue(undefined);
    mockSynthesize.mockReset();
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("hard-fails when given a stack name without a slash (no silent route to 'state orphan')", async () => {
    await expect(runOrphan(['MyStack', '--app', 'noop'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/cdkd orphan' now expects a construct path/);
    expect(message).toMatch(/cdkd state orphan MyStack/);
    expect(mockGetState).not.toHaveBeenCalled();
  });

  it('errors when paths reference different stacks', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'StackA',
          displayName: 'StackA',
          template: templateWith({ A: 'StackA/A' }),
          region: 'us-east-1',
        },
        {
          stackName: 'StackB',
          displayName: 'StackB',
          template: templateWith({ B: 'StackB/B' }),
          region: 'us-east-1',
        },
      ],
    });

    await expect(
      runOrphan(['StackA/A', 'StackB/B', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/All construct paths must reference the same stack/);
  });

  it('errors when no app is configured', async () => {
    await expect(runOrphan(['MyStack/MyTable'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/'cdkd orphan' requires a CDK app/);
  });

  it('aborts when path does not match any resource', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await expect(
      runOrphan(['MyStack/Missing', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Construct path 'MyStack\/Missing' not found/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('succeeds, releases lock, and writes new state under --yes', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
          Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {}, dependencies: ['Bucket'] },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockAcquireLock).toHaveBeenCalledWith('MyStack', 'us-east-1', expect.any(String), 'orphan');
    expect(mockReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [[stack, region, savedState]] = mockSaveState.mock.calls;
    expect(stack).toBe('MyStack');
    expect(region).toBe('us-east-1');
    expect(savedState.resources.Bucket).toBeUndefined();
    expect(savedState.resources.Other.dependencies).not.toContain('Bucket');
  });

  /**
   * The `outputs` bag (issue go-to-k/cdkd#3192). `cdkd orphan` is the headline
   * write path of that issue, and the harm was CONFIRMED by execution rather
   * than argued: `rewriteResourceReferences` rebuilds the bag from
   * `Object.entries(state.outputs ?? {})`, so `outputs: 'abcdef'` comes out as
   * `{"0":"a",…,"5":"f"}` and a `null` one as `{}` — and this command SAVES
   * that. The damaged record is the only signal anything is wrong; rewriting
   * it into a well-formed one is permanent, and the next deploy republishes
   * the fabricated keys into the shared exports index.
   *
   * The resource map is HEALTHY in every case here: the two containers are
   * independent, and a guard that needed both broken would never fire on the
   * shape this closes.
   */
  describe('a malformed `outputs` bag is refused, not laundered', () => {
    function arrange(outputs: unknown): void {
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: 'MyStack',
            displayName: 'MyStack',
            template: templateWith({ Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' }),
            region: 'us-east-1',
          },
        ],
      });
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          version: 9,
          stackName: 'MyStack',
          region: 'us-east-1',
          resources: {
            Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
            Other: {
              physicalId: 'o',
              resourceType: 'AWS::S3::Bucket',
              properties: {},
              dependencies: ['Bucket'],
            },
          },
          outputs,
          lastModified: 0,
        },
        etag: '"e"',
      });
    }

    for (const [label, bag] of [
      ['a string', 'abcdef'],
      ['null', null],
      ['a list', ['a', 'b']],
      ['a number', 5],
    ] as const) {
      it(`refuses ${label} and writes NOTHING`, async () => {
        arrange(bag);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        // The evidence survives — this is the whole point of refusing rather
        // than repairing, and `saveState` is the expression that would destroy
        // it.
        expect(
          mockSaveState,
          'cdkd orphan saved over a record whose outputs bag it could not read; the damaged ' +
            'record is gone and a well-formed fabrication is in its place'
        ).not.toHaveBeenCalled();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(message).toContain(`'outputs'`);
        // It must name THIS container, not borrow the resources refusal, whose
        // sentence is about the stack being re-created on the next deploy.
        expect(message).not.toContain(`'resources'`);
      });
    }

    it('refuses BEFORE the lock is released without one being wasted on a doomed run', async () => {
      // Placement: the refusal sits at the load, above the rewrite and above
      // the confirmation prompt, so the user is never asked to confirm an
      // operation that cannot proceed.
      arrange('abcdef');
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(readlineQuestion).not.toHaveBeenCalled();
    });

    it('FLOOR: a POPULATED outputs bag is still rewritten and saved', async () => {
      // The other side of the fence, and the one that would be missed: a guard
      // that refused everything satisfies every case above. The bag here holds
      // a value the rewrite must carry through unchanged, so the assertion is
      // about the SAVE happening AND the outputs surviving it — not merely
      // that nothing threw.
      arrange({ BucketName: 'b', 'Stack:Export': 'b' });
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [[, , savedState]] = mockSaveState.mock.calls;
      expect(savedState.outputs).toEqual({ BucketName: 'b', 'Stack:Export': 'b' });
      expect(savedState.resources.Bucket).toBeUndefined();
    });

    it('FLOOR: an EMPTY and an ABSENT outputs bag are both still saved', async () => {
      // `{}` is a legitimate exports-nothing record, and an ABSENT bag is one
      // cdkd writes on purpose — a deploy's failure-path save emits
      // `outputs: currentState.outputs`, which `JSON.stringify` drops when
      // undefined. Refusing either would make `cdkd orphan` unusable on
      // ordinary state.
      arrange({});
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);

      mockSaveState.mockClear();
      arrange(undefined);
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Issue [go-to-k/cdkd#3318](https://github.com/go-to-k/cdkd/issues/3318): the
   * per-ENTRY `properties` container, which neither refusal above covers.
   *
   * `rewriteResourceReferences` passes each bag through `rewriteValue`, whose
   * first line returns a non-object VERBATIM, and re-assigns the result through
   * a bare cast — so the record `cdkd orphan` saves still carries the map it
   * could not read, and the command reports success over it.
   */
  describe('an unreadable per-resource `properties` bag is refused (go-to-k/cdkd#3318)', () => {
    /** `Bucket` is the orphan target; `Other` is the record that SURVIVES. */
    function arrange(otherProperties: unknown): void {
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: 'MyStack',
            displayName: 'MyStack',
            template: templateWith({ Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' }),
            region: 'us-east-1',
          },
        ],
      });
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          version: 10,
          stackName: 'MyStack',
          region: 'us-east-1',
          resources: {
            Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
            Other: {
              physicalId: 'o',
              resourceType: 'AWS::S3::Bucket',
              ...(otherProperties === undefined ? {} : { properties: otherProperties }),
              dependencies: ['Bucket'],
            },
          },
          outputs: {},
          lastModified: 0,
        },
        etag: '"e"',
      });
    }

    // Fenced ONE SHAPE AT A TIME. Measured 2026-09-17 through the real
    // `rewriteResourceReferences`: `absent` is saved back absent (dropped by
    // `JSON.stringify`), `null` / `[]` / `5` / `"abcdef"` come back byte for
    // byte, and a POPULATED list is the one unreadable shape `rewriteValue`
    // walks — its `{Ref: Bucket}` was rewritten to the physical id and the run
    // reported a rewrite into a container that is still not a map.
    for (const [label, bag] of [
      ['absent', undefined],
      ['null', null],
      ['an empty list', []],
      ['a populated list', [{ Ref: 'Bucket' }]],
      ['a number', 5],
      ['a string', 'abcdef'],
      ['a boolean', true],
    ] as const) {
      it(`refuses ${label} and writes NOTHING`, async () => {
        arrange(bag);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        // The RUNTIME half of the dominance fence. A guard placed below the
        // rewrite still refuses, so every assertion here stays green through
        // exactly that regression — what changes is that the audit table is
        // printed FIRST, over a record the next line refuses. Asserting its
        // absence is what makes the placement observable without reading the
        // source (test review of go-to-k/cdkd#3318).
        const printed = infoSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
        expect(
          printed,
          'cdkd orphan printed its rewrite audit table before refusing, so the guard now sits ' +
            'below the rewrite walk it is supposed to dominate'
        ).not.toContain('Orphaning 1 resource(s):');
        expect(
          mockSaveState,
          'cdkd orphan saved a record whose `properties` map it could not read; the next ' +
            'cdkd deploy refuses on it and a cdkd diff in between previews a replacement'
        ).not.toHaveBeenCalled();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        // It names the SURVIVING damaged record, and the container.
        expect(message).toContain('Other');
        expect(message).toContain(`'properties'`);
        // Not the two sibling containers' texts: a `resources` refusal over an
        // intact resource map tells the operator their stack would be
        // re-created, which does not hold.
        expect(message).not.toContain(`no readable 'resources' map`);
        expect(message).not.toContain(`no readable 'outputs' map`);
        // And it is THIS command's text, not the deploy sibling's: `cdkd
        // orphan` computes no diff, so "a DELETE and re-create of resources
        // the template did not change" would describe a verdict it never
        // reached. The positive half names the mechanism that IS true here.
        expect(message).toContain('carried through VERBATIM');
        expect(message).not.toContain('a DELETE and re-create of resources');
        // The remedies, with the CONDITION on the template-dependent one. The
        // first revision named only `cdkd orphan <its construct path>` and said
        // it unconditionally, which is impossible for a record the CDK app no
        // longer declares (security review of go-to-k/cdkd#3318).
        expect(message).toContain('repair the record by hand');
        // The remedy carries `--stack-region`, and the flag is the point:
        // `cdkd state orphan <stack>` alone drops that stack name's record in
        // EVERY region, so a message omitting it hands a stuck operator
        // something wider than it describes (security review of
        // go-to-k/cdkd#3318, round 2). Asserted WITH the region this caller
        // holds, so a regression back to the bare form reds here rather than
        // passing on a substring.
        // Since go-to-k/cdkd#3363 the command is also qualified with the run's
        // `--state-bucket` (and `--profile` / `--state-prefix` when given), so
        // the region is asserted as a flag PAIR rather than as the last token.
        expect(message).toMatch(
          /^Drop the record: cdkd state orphan \S+ --stack-region \S+( --state-bucket \S+)?$/m
        );
        expect(message).toContain('only while the CDK app STILL DECLARES');
      });
    }

    it('names EVERY surviving damaged record, not just the first', async () => {
      // A single-id message renders `holds 1 resource record(s) — Other —`, so
      // every other case in this block is satisfied by a guard that stopped at
      // the first hit. Two survivors is what distinguishes them.
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: 'MyStack',
            displayName: 'MyStack',
            template: templateWith({
              Bucket: 'MyStack/Bucket',
              Other: 'MyStack/Other',
              Third: 'MyStack/Third',
            }),
            region: 'us-east-1',
          },
        ],
      });
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          version: 10,
          stackName: 'MyStack',
          region: 'us-east-1',
          resources: {
            Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
            Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: 'abcdef' },
            Third: { physicalId: 't', resourceType: 'AWS::S3::Bucket', properties: [] },
          },
          outputs: {},
          lastModified: 0,
        },
        etag: '"e"',
      });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('holds 2 resource record(s)');
      expect(message).toContain('Other');
      expect(message).toContain('Third');
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('names the CALLER identity, never the planted one in the record body', async () => {
      // `parseStateBody` validates neither `stackName` nor `region`, and an
      // attacker holding `s3:PutObject` on one stack's key can plant another
      // stack's name. The refusal ends on a pasteable `cdkd state show`, so a
      // record-derived identity would aim it at a healthy record while the
      // damaged one goes unnamed. `cdkd orphan` resolves both from the
      // synthesized app and from `pickStackRegion`.
      // `arrange` supplies the synth + listStacks doubles; the record itself is
      // replaced below so its self-report diverges from the caller's identity.
      arrange('abcdef');
      mockGetState.mockResolvedValue({
        state: {
          version: 10,
          stackName: 'prod-payments',
          region: 'eu-west-1',
          resources: {
            Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
            Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: 'abcdef' },
          },
          outputs: {},
          lastModified: 0,
        },
        etag: '"e"',
      });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('State for MyStack (us-east-1)');
      expect(message).toContain('cdkd state show MyStack --stack-region us-east-1 --json');
      expect(message, 'the refusal aims its remedy at the stack the RECORD names').not.toContain(
        'prod-payments'
      );
      expect(message).not.toContain('eu-west-1');
    });

    /**
     * go-to-k/cdkd#3359. The remedy commands select a record by the region it is
     * LISTED under, and a single legacy record whose body names no region is
     * loaded under the SYNTHESIZED region (`getState` falls back to the legacy
     * key for any region). Handing the refusal that loaded region printed a
     * `--stack-region us-east-1` that selects no record in `cdkd state orphan`
     * or `cdkd state show`. That the bare command DOES select the legacy
     * record is driven through the real `state orphan` in
     * `tests/unit/cli/state-orphan.test.ts`.
     */
    describe('a legacy record names the region it is LISTED under (go-to-k/cdkd#3359)', () => {
      function dropCommand(message: string): string {
        const m = /^Drop the record: (cdkd state orphan .*)$/m.exec(message);
        expect(m, 'the drop remedy is no longer rendered in the expected shape').not.toBeNull();
        return m![1]!;
      }

      it('omits --stack-region for a legacy record whose body names no region', async () => {
        arrange('abcdef');
        mockListStacks.mockResolvedValue([{ stackName: 'MyStack' }]);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        // The LOAD is unchanged: still the synthesized region, which is what
        // reaches the legacy key through the backend's fallback.
        expect(mockGetState).toHaveBeenCalledWith('MyStack', 'us-east-1');
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        // `--state-bucket` rides along: `cdkd state orphan` re-resolves the
        // bucket from the ambient profile, and the double resolves `test-bucket`.
        expect(dropCommand(message)).toBe('cdkd state orphan MyStack --state-bucket test-bucket');
        expect(message).not.toContain('us-east-1');
        // `cdkd state show` refuses a region-less legacy record with or without
        // the flag, so the refusal must not end on it.
        expect(message).not.toMatch(/cdkd state show MyStack/);
        expect(message).not.toContain('--json');
        // The real prefix (commander's default) and the resolved bucket.
        expect(message).toMatch(/^Object key: cdkd\/MyStack\/state\.json$/m);
        expect(message).toMatch(/^State bucket: test-bucket$/m);
        expect(message).not.toContain('<prefix>');
        expect(mockSaveState).not.toHaveBeenCalled();
      });

      it('keeps the region a legacy body DOES carry, which is what the listing selects by', async () => {
        arrange('abcdef');
        // `readLegacyRegion` lists a legacy key under its body's region, so a
        // `--stack-region` naming it selects the record — dropping it would
        // widen the remedy to every region holding the name.
        mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'eu-west-1' }]);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(dropCommand(message)).toBe(
          'cdkd state orphan MyStack --stack-region eu-west-1 --state-bucket test-bucket'
        );
        expect(message).toContain('cdkd state show MyStack --stack-region eu-west-1 --json');
      });

      it('carries profile and bucket into the drop command, and prefix and bucket into the object line', async () => {
        arrange('abcdef');
        mockListStacks.mockResolvedValue([{ stackName: 'MyStack' }]);
        await expect(
          runOrphan([
            'MyStack/Bucket', '--app', 'noop', '--yes',
            '--profile', 'prod', '--state-prefix', 'custom',
          ])
        ).rejects.toThrow();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(dropCommand(message)).toBe(
          'cdkd state orphan MyStack --profile prod --state-bucket test-bucket --state-prefix custom'
        );
        expect(message).toMatch(/^Object key: custom\/MyStack\/state\.json$/m);
        expect(message).toMatch(/^State bucket: test-bucket$/m);
      });

      it('names the region --stack-region selected when several are listed', async () => {
        arrange('abcdef');
        mockListStacks.mockResolvedValue([
          { stackName: 'MyStack', region: 'us-east-1' },
          { stackName: 'MyStack', region: 'eu-west-1' },
        ]);
        await expect(
          runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes', '--stack-region', 'eu-west-1'])
        ).rejects.toThrow();
        expect(mockGetState).toHaveBeenCalledWith('MyStack', 'eu-west-1');
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        // Dropping the flag here widens a destructive remedy to BOTH regions.
        expect(dropCommand(message)).toBe(
          'cdkd state orphan MyStack --stack-region eu-west-1 --state-bucket test-bucket'
        );
      });

      it('keeps --stack-region for a region-keyed record', async () => {
        arrange('abcdef');
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(dropCommand(message)).toBe(
          'cdkd state orphan MyStack --stack-region us-east-1 --state-bucket test-bucket'
        );
        expect(message).toContain('cdkd state show MyStack --stack-region us-east-1 --json');
      });
    });

    it('refuses under --dry-run too, where the audit table would otherwise look fine', async () => {
      // The guard sits at the load, above the `if (options.dryRun)` return. A
      // plausible rewrite plan followed by a refusal the moment the flag comes
      // off is the worst arm of all.
      arrange('abcdef');
      await expect(
        runOrphan(['MyStack/Bucket', '--app', 'noop', '--dry-run'])
      ).rejects.toThrow();
      // Qualified on the REFUSAL, not on "something threw": every command in
      // this file exits through `withErrorHandling`, so the rejection is always
      // the `process.exit` mock and a bare `rejects.toThrow()` is satisfied by
      // any failure at all.
      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('carried through VERBATIM');
      // `not.toHaveBeenCalled()` on `saveState` would be VACUOUS here — a dry
      // run never saves. What distinguishes a refusal from a normal dry run is
      // that the PLAN is not printed either.
      const printed = infoSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(printed).not.toContain('--dry-run: state will NOT be written');
      expect(printed).not.toContain('Orphaning 1 resource(s):');
    });

    it('--force does NOT bypass it', async () => {
      // `--force`'s contract is "use a possibly-wrong value rather than
      // stranding me" for an unresolvable ATTRIBUTE. It buys nothing here: the
      // save would still leave a record `cdkd deploy` refuses, and the real way
      // out is one line down.
      arrange('abcdef');
      await expect(
        runOrphan(['MyStack/Bucket', '--app', 'noop', '--force'])
      ).rejects.toThrow();
      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('carried through VERBATIM');
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('refuses before the confirmation prompt, so no doomed run is confirmed', async () => {
      arrange('abcdef');
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop'])).rejects.toThrow();
      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('carried through VERBATIM');
      expect(readlineQuestion).not.toHaveBeenCalled();
    });

    it('RECOVERY: orphaning the DAMAGED record itself still works and repairs the record', async () => {
      // The decision the guard turns on. `cdkd orphan` is the per-resource way
      // out of a torn record, and the save cannot persist a record it is
      // deleting — so the refusal is scoped to the SURVIVORS. A guard that
      // ignored the orphan set would close the one command that repairs this.
      arrange('abcdef');
      await runOrphan(['MyStack/Other', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [[, , savedState]] = mockSaveState.mock.calls;
      expect(savedState.resources.Other, 'the torn record survived the orphan').toBeUndefined();
      // And what is left is readable, which is the whole point: the record the
      // save writes is one the next cdkd deploy accepts.
      expect(savedState.resources.Bucket.properties).toEqual({});
    });

    it('FLOOR: a POPULATED properties bag is still rewritten and saved', async () => {
      // The other side of the fence: a guard that refused everything satisfies
      // every case above. `Other` references the orphan, so the assertion is
      // about the rewrite LANDING, not merely about nothing throwing.
      arrange({ Name: { Ref: 'Bucket' } });
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [[, , savedState]] = mockSaveState.mock.calls;
      expect(savedState.resources.Other.properties).toEqual({ Name: 'b' });
      expect(savedState.resources.Bucket).toBeUndefined();
      // POSITIVE CONTROL for the two `not.toContain` needles above, which are
      // otherwise unfalsifiable: nothing else in this suite asserts that
      // `printRewriteSummary` emits this line at all, so renaming it or routing
      // it off `logger.info` would make all nine dominance assertions pass
      // vacuously (test review of go-to-k/cdkd#3318).
      const printed = infoSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(
        printed,
        "printRewriteSummary no longer emits 'Orphaning N resource(s):' through logger.info; " +
          'the audit-table absence assertions on the refusal paths now assert nothing'
      ).toContain('Orphaning 1 resource(s):');
    });

    it('releases the lock it took before refusing', async () => {
      // The refusal's own text says "Continuing would rewrite, save…" rather
      // than "would take a lock", because `orphan.ts` acquires the lock BEFORE
      // `getState` and therefore holds one by the time this raises. That
      // premise is only true while the command's `finally` still releases it.
      arrange('abcdef');
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(mockAcquireLock).toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('FLOOR: an EMPTY properties bag is a legitimate record and is saved', async () => {
      // `{}` is what `cdkd import` writes for a resource declaring nothing
      // (`Properties ?? {}`). Refusing it would make the command unusable on
      // ordinary state.
      arrange({});
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * What the save KEEPS beyond a survivor's `properties` map: the survivor
   * ENTRY itself (go-to-k/cdkd#3350), its `attributes` map (go-to-k/cdkd#3345)
   * and `state.orphans` (go-to-k/cdkd#3344). Each is driven through the real
   * guards and the real rewriter, with `Bucket` the orphan target and `Other`
   * the survivor unless a case says otherwise.
   */
  describe('the rest of the kept record is refused when unreadable (#3350, #3345, #3344)', () => {
    function arrange(
      resources: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ): void {
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: 'MyStack',
            displayName: 'MyStack',
            template: templateWith({ Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' }),
            region: 'us-east-1',
          },
        ],
      });
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          version: 10,
          stackName: 'MyStack',
          region: 'us-east-1',
          resources,
          outputs: {},
          lastModified: 0,
          ...extra,
        },
        etag: '"e"',
      });
    }
    const BUCKET = { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} };
    const other = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
      physicalId: 'o',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      ...fields,
    });
    const refusal = (): string => String(errorSpy.mock.calls[0]?.[0] ?? '');
    const printed = (): string => infoSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

    // Measured through the real rewrite before the guard, each saved and
    // reported as a success: `"abcdef"` as `{"0":"a",…,"dependencies":[]}`,
    // `5` / `true` as `{"dependencies":[]}`, a list as `{"0":…}` with its
    // `Ref` to the orphan left UNREWRITTEN, `null` a bare TypeError, and a
    // typeless object carried as it stands.
    for (const [label, entry] of [
      ['a string', 'abcdef'],
      ['a number', 5],
      ['a boolean', true],
      ['a list', [{ Ref: 'Bucket' }]],
      ['null', null],
      ['an object with no resource type', { physicalId: 'o', properties: {} }],
    ] as const) {
      it(`#3350: refuses a surviving ENTRY that is ${label}, and writes NOTHING`, async () => {
        arrange({ Bucket: BUCKET, Other: entry });
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        expect(mockSaveState).not.toHaveBeenCalled();
        const message = refusal();
        expect(message).toContain('holds 1 resource record(s) that cannot be read as resources');
        expect(message).toContain('Other');
        expect(message).toContain(`a record no cdkd command wrote`);
        // Not the properties refusal's "carried VERBATIM", false for this one.
        expect(message).not.toContain('carried through VERBATIM');
        // Not the shared entry refusal's "Nothing was locked", false here.
        expect(message).not.toContain('Nothing was locked');
        expect(message).toMatch(/^Drop the record: cdkd state orphan MyStack --stack-region us-east-1/m);
        expect(printed()).not.toContain('Orphaning 1 resource(s):');
      });
    }

    it('#3350: RECOVERY — orphaning the unreadable entry itself still works', async () => {
      for (const entry of ['abcdef', null]) {
        mockSaveState.mockClear();
        arrange({ Bucket: BUCKET, Other: entry });
        await runOrphan(['MyStack/Other', '--app', 'noop', '--yes']);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
        const [[, , savedState]] = mockSaveState.mock.calls;
        expect(Object.keys(savedState.resources)).toEqual(['Bucket']);
      }
    });

    it('#3350: a reference THROUGH the dropped unreadable entry aborts, not fabricates', async () => {
      // `Other` survives and references the torn `Bucket` being orphaned.
      // Before the rewriter's guard its `Fn::Sub` saved as `x-undefined`.
      arrange({
        Bucket: 'abcdef',
        Other: other({ properties: { Url: { 'Fn::Sub': 'x-${Bucket}' } } }),
      });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(refusal()).toContain('1 reference(s) could not be resolved');
    });

    for (const [label, attributes] of [
      ['a string', 'abcdef'],
      ['null', null],
      ['a list', [{ Ref: 'Bucket' }]],
      ['a number', 0],
    ] as const) {
      it(`#3345: refuses a surviving 'attributes' map that is ${label}`, async () => {
        arrange({ Bucket: BUCKET, Other: other({ attributes }) });
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        expect(mockSaveState).not.toHaveBeenCalled();
        const message = refusal();
        expect(message).toContain(`whose 'attributes' map cannot be read — Other —`);
        expect(message).toContain('only while the CDK app STILL DECLARES');
        expect(printed()).not.toContain('Orphaning 1 resource(s):');
      });
    }

    it('#3345: the ORPHANED record\'s own torn attributes do not block dropping it', async () => {
      arrange({ Bucket: { ...BUCKET, attributes: 'abcdef' }, Other: other() });
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('#3344: refuses an unreadable orphans LIST', async () => {
      arrange({ Bucket: BUCKET, Other: other() }, { orphans: 'abc' });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(mockSaveState).not.toHaveBeenCalled();
      const message = refusal();
      expect(message).toContain(`has no readable 'orphans' list`);
      expect(message).toContain('carries it into the record it saves VERBATIM');
      // The rollback text's mechanism is false here: nothing is walked.
      expect(message).not.toContain('WALKED');
    });

    for (const [label, record] of [
      ['a torn properties map', { logicalId: 'Gone', orphanedAt: 1, state: { ...BUCKET, properties: 'abcdef' } }],
      ['a torn attributes map', { logicalId: 'Gone', orphanedAt: 1, state: { ...BUCKET, attributes: [1] } }],
      ['a state with no resource type', { logicalId: 'Gone', orphanedAt: 1, state: { physicalId: 'g', properties: {} } }],
      ['a null state', { logicalId: 'Gone', orphanedAt: 1, state: null }],
    ] as const) {
      it(`#3344: refuses a rollback-orphan record with ${label}`, async () => {
        arrange({ Bucket: BUCKET, Other: other() }, { orphans: [record] });
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        expect(mockSaveState).not.toHaveBeenCalled();
        const message = refusal();
        expect(message).toContain(`holds 1 rollback-orphan record(s) in 'orphans' that cannot be read — Gone —`);
        // Its third way out is NOT `cdkd orphan <construct path>`.
        expect(message).toContain('it has no construct path');
        expect(message).not.toContain('only while the CDK app STILL DECLARES');
      });
    }

    it('#3344: FLOOR — a readable orphans list is saved, verbatim', async () => {
      const orphans = [{ logicalId: 'Gone', orphanedAt: 1, state: { ...BUCKET, attributes: { Arn: 'a' } } }];
      arrange({ Bucket: BUCKET, Other: other({ attributes: { Arn: 'x' } }) }, { orphans });
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [[, , savedState]] = mockSaveState.mock.calls;
      expect(savedState.orphans).toEqual(orphans);
      expect(savedState.resources.Other.attributes).toEqual({ Arn: 'x' });
    });

    it('each new refusal fires under --dry-run too, before the plan', async () => {
      for (const [resources, extra] of [
        [{ Bucket: BUCKET, Other: 'abcdef' }, {}],
        [{ Bucket: BUCKET, Other: other({ attributes: 'abcdef' }) }, {}],
        [{ Bucket: BUCKET, Other: other() }, { orphans: 'abc' }],
      ] as const) {
        errorSpy.mockClear();
        infoSpy.mockClear();
        arrange(resources, extra);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--dry-run'])).rejects.toThrow();
        expect(refusal()).toContain('under \'--dry-run\' too');
        expect(printed()).not.toContain('--dry-run: state will NOT be written');
      }
    });
  });

  /**
   * go-to-k/cdkd#3388: the state and outputs refusals take the region the
   * record is LISTED under, as the properties refusal does since
   * go-to-k/cdkd#3359, and name the S3 object for a region-less legacy record.
   */
  describe('the state and outputs refusals name the LISTED region (go-to-k/cdkd#3388)', () => {
    function arrange(container: 'resources' | 'outputs', listed: Array<Record<string, string>>): void {
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: 'MyStack',
            displayName: 'MyStack',
            template: templateWith({ Bucket: 'MyStack/Bucket' }),
            region: 'us-east-1',
          },
        ],
      });
      mockListStacks.mockResolvedValue(listed);
      mockGetState.mockResolvedValue({
        state: {
          version: 1,
          stackName: 'MyStack',
          resources:
            container === 'resources'
              ? 'abcdef'
              : { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
          outputs: container === 'outputs' ? 'abcdef' : {},
          lastModified: 0,
        },
        etag: '"e"',
      });
    }

    for (const container of ['resources', 'outputs'] as const) {
      it(`${container}: a region-less legacy record gets the object path, not state show`, async () => {
        arrange(container, [{ stackName: 'MyStack' }]);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        // The LOAD still uses the synthesized region.
        expect(mockGetState).toHaveBeenCalledWith('MyStack', 'us-east-1');
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(message).toContain(`no readable '${container}' map`);
        expect(message).not.toContain('us-east-1');
        // `cdkd state show` refuses a region-less legacy record with or without
        // the flag, so no command naming it may be offered.
        expect(message).not.toMatch(/cdkd state show MyStack/);
        expect(message).not.toContain('--json');
        expect(message).toMatch(/^Object key: cdkd\/MyStack\/state\.json$/m);
        expect(message).toMatch(/^State bucket: test-bucket$/m);
        expect(mockSaveState).not.toHaveBeenCalled();
      });

      it(`${container}: a region-keyed record keeps its --stack-region inspect command`, async () => {
        arrange(container, [{ stackName: 'MyStack', region: 'us-east-1' }]);
        await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
        const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
        expect(message.endsWith('cdkd state show MyStack --stack-region us-east-1 --json')).toBe(true);
      });
    }
  });

  it('skips lock + save on --dry-run', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--dry-run']);

    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('surfaces lock acquisition failure', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockAcquireLock.mockRejectedValue(new Error('locked by another process'));

    await expect(
      runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  // Issue #2161: `acquireLock` reports contention by RESOLVING false (not
  // throwing). Orphan must refuse rather than rewrite state under the foreign
  // lock and then release it. Fences the `!acquired` check specifically —
  // reverting it would let this proceed and fail these assertions.
  it('refuses when the lock is held (acquireLock resolves false)', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    // Stub state so a REVERT of the `!acquired` guard would REACH `saveState`
    // (without this, the reverted path throws "No state found" at getState
    // first and the saveState assertion below would be vacuous).
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    mockAcquireLock.mockResolvedValue(false);
    mockGetLockInfo.mockResolvedValue({
      owner: 'other@host:1',
      operation: 'deploy',
      expiresAt: Date.now() + 600_000,
    });

    // Aborts (the lock throw surfaces through the command's error handler as a
    // process.exit); the discriminator is that it does NOT proceed to write /
    // release under the foreign lock.
    await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
    // The LOCK error surfaced (not some other abort).
    const orphanMsg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(orphanMsg).toMatch(/Could not acquire lock/);
    // Holder NAMED and command QUALIFIED (issue #2170) -- the bare regex above
    // was true before this change too, so dropping `recovery: {...}` here was
    // previously green.
    expect(orphanMsg).toContain('held by other@host:1');
    // `--state-bucket` is what `recovery` supplies; `--stack-region` does NOT,
    // so asserting only the region left `recovery: {...}` droppable — the
    // probe for that came back green until this line named the bucket.
    expect(orphanMsg).toMatch(/cdkd force-unlock \S+ --stack-region \S+ --state-bucket test-bucket/);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('disambiguates with --stack-region when state has multiple regions', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
        },
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);

    // Without --stack-region: should error.
    await expect(
      runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/multiple regions/);

    // With --stack-region us-west-2: should target the right region.
    errorSpy.mockReset();
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-west-2',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes', '--stack-region', 'us-west-2']);
    expect(mockGetState).toHaveBeenLastCalledWith('MyStack', 'us-west-2');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(mockSaveState.mock.calls[0]?.[1]).toBe('us-west-2');
  });

  it('resolves an L2 construct path to the synthesized L1 child resource', async () => {
    // The user passes the L2 path (`MyStack/MyConstruct/MyBucket2`) but the
    // template's `aws:cdk:path` carries the synthesized L1 form
    // (`.../MyBucket2/Resource`). Mirrors `cdk orphan --unstable=orphan`.
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({
            Bucket1Resource: 'MyStack/MyConstruct/MyBucket1/Resource',
            Bucket2Resource: 'MyStack/MyConstruct/MyBucket2/Resource',
          }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket1Resource: { physicalId: 'b1', resourceType: 'AWS::S3::Bucket', properties: {} },
          Bucket2Resource: { physicalId: 'b2', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/MyConstruct/MyBucket2', '--app', 'noop', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [[, , savedState]] = mockSaveState.mock.calls;
    expect(savedState.resources.Bucket2Resource).toBeUndefined();
    expect(savedState.resources.Bucket1Resource).toBeDefined();
  });

  it('orphans every child under an L2 wrapper construct in one call', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({
            Bucket1Resource: 'MyStack/MyConstruct/MyBucket1/Resource',
            Bucket2Resource: 'MyStack/MyConstruct/MyBucket2/Resource',
            Other: 'MyStack/Other',
          }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket1Resource: { physicalId: 'b1', resourceType: 'AWS::S3::Bucket', properties: {} },
          Bucket2Resource: { physicalId: 'b2', resourceType: 'AWS::S3::Bucket', properties: {} },
          Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/MyConstruct', '--app', 'noop', '--yes']);

    const [[, , savedState]] = mockSaveState.mock.calls;
    expect(savedState.resources.Bucket1Resource).toBeUndefined();
    expect(savedState.resources.Bucket2Resource).toBeUndefined();
    expect(savedState.resources.Other).toBeDefined();
  });

  it('omits AWS::CDK::Metadata from the available-paths error and refuses to orphan it', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith(
            { Bucket: 'MyStack/Bucket' },
            {
              CDKMetadata: { Type: 'AWS::CDK::Metadata', cdkPath: 'MyStack/CDKMetadata/Default' },
            }
          ),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await expect(
      runOrphan(['MyStack/CDKMetadata/Default', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Construct path 'MyStack\/CDKMetadata\/Default' not found/);
    // Available-paths list must NOT mention the CDKMetadata path.
    const availableSection = message.split('Available paths:')[1] ?? '';
    expect(availableSection).not.toMatch(/CDKMetadata/);
    expect(availableSection).toMatch(/MyStack\/Bucket/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('cancels when the user answers empty at the confirmation prompt', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    readlineQuestion.mockResolvedValue('');

    await runOrphan(['MyStack/Bucket', '--app', 'noop']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  /**
   * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING
   * half. `tests/unit/cli/non-interactive-confirm-guards.test.ts` probes this
   * command's prompt HELPER directly (the `NON_INTERACTIVE_CONFIRM` code, the
   * refusal wording, the never-settling-question hang fence); what a
   * helper-level probe cannot see is whether the COMMAND's own call site
   * still reaches it, or has grown a second `readline.createInterface` of its
   * own. This case drives the real command path with no confirmation flag and
   * a non-TTY stdin, and asserts the refusal surfaces with nothing mutated.
   */
  it('REFUSES a non-interactive run, naming -y / --yes and -f / --force', async () => {
    setStdinIsTty(undefined);
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await expect(runOrphan(['MyStack/Bucket', '--app', 'noop'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('CdkdError');
    expect(message).toContain('The cdkd orphan confirmation prompt cannot run');
    expect(message).toContain('-y / --yes');
    expect(message).toContain('-f / --force');
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    // The lock is acquired BEFORE this prompt, so the refusal must release it
    // on the way out. `docs/cli-destroy.md` states that as a guarantee for
    // all four commands that hold a lock at their prompt -- `cdkd orphan`,
    // `cdkd import`, `cdkd export`, `cdkd rollback` -- and a stuck lock would
    // block every other session against this stack, not merely fail this run.
    // Asserted per command rather than once, because each acquires and
    // releases in its own `try` / `finally`.
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });
});
