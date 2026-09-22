/**
 * `cdkd orphan` renders no assembly-derived value raw (issue go-to-k/cdkd#3479).
 *
 * Three families reach the terminal here — a stack's `stackName` /
 * `displayName`, a template logical id, and an `aws:cdk:path` out of the
 * template's own `Metadata` — in thrown messages AND in `logger.info` lines on a
 * NORMAL run at default verbosity (the `Target: ...` line and the success line
 * are both reached with no error involved).
 *
 * Which helper each site takes is a per-SENTENCE decision documented at the top
 * of `src/cli/commands/orphan.ts`; the cases below pin it both ways:
 *
 * - the two UNQUOTED `Available: ...` lists take `displayIdent`, so a value
 *   whose sanitization was not the identity gains a visible boundary and cannot
 *   render byte-identical to the genuine entry the message says is missing;
 * - everything else takes `displaySafe`, which neither quotes nor truncates, so
 *   an ordinary value is byte-identical.
 *
 * Both polarities per site; the hostile cases carry a DISTINCT marker per
 * interpolated value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(() => ({ getAttribute: vi.fn(async () => undefined) })),
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: vi.fn() })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';
import {
  CSI,
  ESC,
  hasForgingCharacter,
  LINE_SEP,
  LRI,
  NEL,
  PARA_SEP,
  RLO,
  ST,
} from '../_forging-characters.js';

/**
 * One hostile marker per interpolated value, each with its own sanitized twin.
 *
 * `logicalId`'s marker is deliberately `U+2029` and not ESC: the rewrite-audit
 * row passes its `before` through `JSON.stringify` first, which turns any C0
 * byte into a six-character escape sequence of printable ASCII — harmless, but
 * it means the sanitizer is never reached and the case would assert nothing
 * about it. `U+2029` is in the class `JSON.stringify` passes straight through,
 * which is exactly why that render site needs `displaySafe` at all.
 */
const HOSTILE = {
  stackA: { raw: `Stack${CSI}A`, clean: 'Stack A' },
  stackB: { raw: `Stack${NEL}B`, clean: 'Stack B' },
  displayA: { raw: `MyStage/${LINE_SEP}Api`, clean: 'MyStage/ Api' },
  displayB: { raw: `MyStage/${RLO}Db`, clean: 'MyStage/ Db' },
  cdkPathA: { raw: `Target/${ST}Bucket`, clean: 'Target/ Bucket' },
  cdkPathB: { raw: `Target/${LRI}Queue`, clean: 'Target/ Queue' },
  logicalId: { raw: `Bucket${PARA_SEP}Id`, clean: 'Bucket Id' },
  otherLogicalId: { raw: `Other${ESC}[2KId`, clean: 'Other [2KId' },
  region: { raw: `us-${NEL}east-1`, clean: 'us- east-1' },
} as const;

async function runOrphan(args: string[]): Promise<void> {
  const cmd = createOrphanCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

/** What `withErrorHandling` reported. */
function reportedError(): string {
  return String(errorSpy.mock.calls[0]?.[0] ?? '');
}

function infoLines(): string[] {
  return infoSpy.mock.calls.map((call) => String(call[0]));
}

function expectNoForgingIn(lines: readonly string[]): void {
  for (const line of lines) {
    for (const physicalLine of line.split('\n')) {
      expect(hasForgingCharacter(physicalLine)).toBe(false);
    }
  }
}

interface StackSpec {
  stackName: string;
  displayName?: string;
  /** logical id → `aws:cdk:path` */
  resources: Record<string, string>;
  region?: string;
}

function stackOf(spec: StackSpec): Record<string, unknown> {
  const Resources: Record<string, unknown> = {};
  for (const [logicalId, path] of Object.entries(spec.resources)) {
    Resources[logicalId] = { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': path } };
  }
  return {
    stackName: spec.stackName,
    displayName: spec.displayName ?? spec.stackName,
    template: { Resources },
    region: spec.region ?? 'us-east-1',
  };
}

function primeStacks(specs: StackSpec[]): void {
  mockSynthesize.mockResolvedValue({ stacks: specs.map(stackOf) });
}

function primeState(
  stackName: string,
  region: string | undefined,
  resources: Record<string, unknown>
): void {
  mockListStacks.mockResolvedValue([{ stackName, ...(region !== undefined && { region }) }]);
  mockGetState.mockResolvedValue({
    state: {
      version: 2,
      stackName,
      ...(region !== undefined && { region }),
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"e"',
  });
}

/** A plain state entry for `logicalId`. */
function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {}, ...extra };
}

let originalIsTTY: boolean | undefined;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
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
  errorSpy.mockReset();
  infoSpy.mockReset();
  warnSpy.mockReset();
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
  vi.restoreAllMocks();
});

describe('cdkd orphan renders assembly-derived values display-safe (#3479)', () => {
  describe("the stack-not-found `Available:` list — an IDENTITY sentence, so displayIdent", () => {
    it('gives each altered display name a visible boundary, one marker per value', async () => {
      primeStacks([
        { stackName: HOSTILE.stackA.raw, displayName: HOSTILE.displayA.raw, resources: {} },
        { stackName: HOSTILE.stackB.raw, displayName: HOSTILE.displayB.raw, resources: {} },
      ]);
      await expect(runOrphan(['Nope/Thing', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).toContain(
        `Available: "${HOSTILE.displayA.clean}", "${HOSTILE.displayB.clean}"`
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves ordinary display names UNQUOTED and byte-identical', async () => {
      primeStacks([
        { stackName: 'MyStage-Api', displayName: 'MyStage/Api', resources: {} },
        { stackName: 'MyStage-Db', displayName: 'MyStage/Db', resources: {} },
      ]);
      await expect(runOrphan(['Nope/Thing', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).toContain('Available: MyStage/Api, MyStage/Db');
    });
  });

  describe('the different-stacks refusal names both stacks', () => {
    it('sanitizes each stack name, one marker per value', async () => {
      primeStacks([
        { stackName: HOSTILE.stackA.raw, resources: { A: `${HOSTILE.stackA.raw}/A` } },
        { stackName: HOSTILE.stackB.raw, resources: { B: `${HOSTILE.stackB.raw}/B` } },
      ]);
      await expect(
        runOrphan([
          `${HOSTILE.stackA.raw}/A`,
          `${HOSTILE.stackB.raw}/B`,
          '--app',
          'noop',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `Got '${HOSTILE.stackA.clean}' and '${HOSTILE.stackB.clean}'.`
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves ordinary stack names byte-identical', async () => {
      primeStacks([
        { stackName: 'StackA', resources: { A: 'StackA/A' } },
        { stackName: 'StackB', resources: { B: 'StackB/B' } },
      ]);
      await expect(
        runOrphan(['StackA/A', 'StackB/B', '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain("Got 'StackA' and 'StackB'.");
    });
  });

  describe("the `Available paths:` list — the template's own aws:cdk:path values", () => {
    it('sanitizes the stack name and gives each altered path a boundary', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          displayName: HOSTILE.stackA.raw,
          resources: { A: HOSTILE.cdkPathA.raw, B: HOSTILE.cdkPathB.raw },
        },
      ]);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Nope`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain(`not found in template for stack '${HOSTILE.stackA.clean}'.`);
      expect(message).toContain(`"${HOSTILE.cdkPathA.clean}"`);
      expect(message).toContain(`"${HOSTILE.cdkPathB.clean}"`);
      // Scoped to the ASSEMBLY-DERIVED tail. The head echoes the operator's own
      // `<path>` argument verbatim, which this command deliberately does not
      // sanitize (`renderNoStackMatch` renders a user pattern the same way), so
      // a whole-message check would assert a boundary that was not drawn here.
      const availableTail = message.slice(message.indexOf('Available paths:'));
      expectNoForgingIn([availableTail]);
    });

    it('leaves ordinary paths UNQUOTED and byte-identical', async () => {
      primeStacks([
        {
          stackName: 'MyStack',
          resources: { A: 'MyStack/Bucket/Resource', B: 'MyStack/Queue/Resource' },
        },
      ]);
      await expect(runOrphan(['MyStack/Nope', '--app', 'noop', '--yes'])).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain("not found in template for stack 'MyStack'.");
      expect(message).toContain('Available paths:\n  MyStack/Bucket/Resource\n  MyStack/Queue/Resource');
    });
  });

  describe('the no-state refusal names the stack and the region', () => {
    it('sanitizes both, one marker per value', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: HOSTILE.region.raw,
          resources: { [HOSTILE.logicalId.raw]: `${HOSTILE.stackA.raw}/Bucket` },
        },
      ]);
      mockListStacks.mockResolvedValue([
        { stackName: HOSTILE.stackA.raw, region: HOSTILE.region.raw },
      ]);
      mockGetState.mockResolvedValue(undefined);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `No state found for stack '${HOSTILE.stackA.clean}' (${HOSTILE.region.clean}).`
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves an ordinary stack and region byte-identical', async () => {
      primeStacks([{ stackName: 'MyStack', resources: { Bucket: 'MyStack/Bucket' } }]);
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(undefined);
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).toContain("No state found for stack 'MyStack' (us-east-1).");
    });
  });

  describe('the multi-region disambiguation refusal names the stack', () => {
    it('sanitizes the stack name and every listed region', async () => {
      primeStacks([
        { stackName: HOSTILE.stackA.raw, region: undefined, resources: { A: 'A/B' } },
      ]);
      // No synthesized region to match, two records listed → ambiguous.
      mockSynthesize.mockResolvedValue({
        stacks: [
          {
            stackName: HOSTILE.stackA.raw,
            displayName: HOSTILE.stackA.raw,
            template: {
              Resources: {
                A: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': `${HOSTILE.stackA.raw}/A` } },
              },
            },
            region: undefined,
          },
        ],
      });
      mockListStacks.mockResolvedValue([
        { stackName: HOSTILE.stackA.raw, region: HOSTILE.region.raw },
        { stackName: HOSTILE.stackA.raw, region: 'eu-west-1' },
      ]);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/A`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `Stack '${HOSTILE.stackA.clean}' has state in multiple regions: ` +
          `${HOSTILE.region.clean}, eu-west-1.`
      );
      expectNoForgingIn([reportedError()]);
    });
  });

  describe('the missing-from-state refusal names the stack, the misses and what IS there', () => {
    it('sanitizes the stack, the requested ids and the available ids', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          resources: { [HOSTILE.logicalId.raw]: `${HOSTILE.stackA.raw}/Bucket` },
        },
      ]);
      primeState(HOSTILE.stackA.raw, 'us-east-1', {
        [HOSTILE.otherLogicalId.raw]: entry(),
      });
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain(
        `Resource(s) not in state for stack '${HOSTILE.stackA.clean}' (us-east-1): ` +
          `${HOSTILE.logicalId.clean}.`
      );
      expect(message).toContain(`Available logical IDs: "${HOSTILE.otherLogicalId.clean}"`);
      expectNoForgingIn([message]);
    });

    it('leaves ordinary ids byte-identical and UNQUOTED in the available list', async () => {
      primeStacks([{ stackName: 'MyStack', resources: { Bucket: 'MyStack/Bucket' } }]);
      primeState('MyStack', 'us-east-1', { Other: entry() });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain(
        "Resource(s) not in state for stack 'MyStack' (us-east-1): Bucket.\n" +
          'Available logical IDs: Other'
      );
    });
  });

  describe('the NORMAL-RUN progress lines — logger.info at default verbosity, no error', () => {
    function arrangeSuccess(stackName: string, logicalId: string, otherId: string): void {
      primeStacks([
        {
          stackName,
          resources: { [logicalId]: `${stackName}/Bucket`, [otherId]: `${stackName}/Other` },
        },
      ]);
      primeState(stackName, 'us-east-1', {
        [logicalId]: entry(),
        [otherId]: entry({ dependencies: [logicalId] }),
      });
    }

    it('sanitizes the target line, the rewrite audit and the success line', async () => {
      arrangeSuccess(HOSTILE.stackA.raw, HOSTILE.logicalId.raw, HOSTILE.otherLogicalId.raw);
      await runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes']);
      const lines = infoLines();
      expect(lines).toContain(
        `Target: ${HOSTILE.stackA.clean} (us-east-1); orphaning 1 resource(s): ` +
          `${HOSTILE.logicalId.clean}`
      );
      expect(lines).toContain(
        `Orphaned 1 resource(s) from state: ${HOSTILE.stackA.clean} (us-east-1). ` +
          'AWS resources are still in AWS; cdkd will no longer manage them.'
      );
      // The rewrite audit row names the SIBLING that referenced the orphan, and
      // its `before` is the orphan's own logical id serialized into the line.
      expect(lines).toContain(
        `  [dependency] ${HOSTILE.otherLogicalId.clean}.dependencies: ` +
          `"${HOSTILE.logicalId.clean}" → (dropped)`
      );
      expectNoForgingIn(lines);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('leaves ordinary names byte-identical on the same lines', async () => {
      arrangeSuccess('MyStack', 'Bucket', 'Other');
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      const lines = infoLines();
      expect(lines).toContain('Target: MyStack (us-east-1); orphaning 1 resource(s): Bucket');
      expect(lines).toContain(
        'Orphaned 1 resource(s) from state: MyStack (us-east-1). ' +
          'AWS resources are still in AWS; cdkd will no longer manage them.'
      );
      expect(lines).toContain('Orphaning 1 resource(s): Bucket');
      expect(lines).toContain('  [dependency] Other.dependencies: "Bucket" → (dropped)');
    });
  });

  describe('the named-region miss names the stack and the regions that ARE listed', () => {
    it('sanitizes the stack name and every listed region', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: undefined,
          resources: { A: `${HOSTILE.stackA.raw}/A` },
        },
      ]);
      mockListStacks.mockResolvedValue([
        { stackName: HOSTILE.stackA.raw, region: HOSTILE.region.raw },
      ]);
      await expect(
        runOrphan([
          `${HOSTILE.stackA.raw}/A`,
          '--stack-region',
          'eu-west-1',
          '--app',
          'noop',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `No state found for stack '${HOSTILE.stackA.clean}' in region 'eu-west-1'. ` +
          `Available regions: ${HOSTILE.region.clean}.`
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves an ordinary stack and region byte-identical', async () => {
      primeStacks([
        { stackName: 'MyStack', region: undefined, resources: { A: 'MyStack/A' } },
      ]);
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      await expect(
        runOrphan(['MyStack/A', '--stack-region', 'eu-west-1', '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        "No state found for stack 'MyStack' in region 'eu-west-1'. " +
          'Available regions: us-east-1.'
      );
    });
  });

  describe('the unresolvable-reference report names each site', () => {
    /**
     * A sibling holding `Fn::GetAtt` on the orphan, whose provider answers no
     * attribute, is what reaches `printUnresolvable` — a `logger.error` list
     * with four interpolations per row.
     */
    function arrangeUnresolvable(stackName: string, orphanId: string, siblingId: string): void {
      primeStacks([
        {
          stackName,
          resources: { [orphanId]: `${stackName}/Bucket`, [siblingId]: `${stackName}/Other` },
        },
      ]);
      primeState(stackName, 'us-east-1', {
        [orphanId]: entry(),
        [siblingId]: entry({
          properties: { BucketName: { 'Fn::GetAtt': [orphanId, 'Arn'] } },
        }),
      });
    }

    it('sanitizes the sibling id, the property path, the orphan id and the attribute', async () => {
      arrangeUnresolvable(HOSTILE.stackA.raw, HOSTILE.logicalId.raw, HOSTILE.otherLogicalId.raw);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some(
          (line) =>
            line.includes(`  ${HOSTILE.otherLogicalId.clean}.`) &&
            line.includes(`${HOSTILE.logicalId.clean}.Arn`)
        )
      ).toBe(true);
      expectNoForgingIn(lines.filter((line) => line.startsWith('  ')));
    });

    it('leaves ordinary ids byte-identical on the same rows', async () => {
      arrangeUnresolvable('MyStack', 'Bucket', 'Other');
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some(
          (line) => line.startsWith('  Other.') && line.includes('Bucket.Arn')
        )
      ).toBe(true);
    });
  });

  describe('the confirmation prompt names the stack it is about to rewrite', () => {
    it('sanitizes the stack name in the question the operator answers', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          resources: { [HOSTILE.logicalId.raw]: `${HOSTILE.stackA.raw}/Bucket` },
        },
      ]);
      primeState(HOSTILE.stackA.raw, 'us-east-1', { [HOSTILE.logicalId.raw]: entry() });
      readlineQuestion.mockResolvedValue('n');
      await runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop']);
      const question = String(readlineQuestion.mock.calls[0]?.[0] ?? '');
      expect(question).toContain(
        `from cdkd state for ${HOSTILE.stackA.clean} (us-east-1)?`
      );
      expectNoForgingIn([question]);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('leaves an ordinary stack name byte-identical in the question', async () => {
      primeStacks([{ stackName: 'MyStack', resources: { Bucket: 'MyStack/Bucket' } }]);
      primeState('MyStack', 'us-east-1', { Bucket: entry() });
      readlineQuestion.mockResolvedValue('n');
      await runOrphan(['MyStack/Bucket', '--app', 'noop']);
      expect(String(readlineQuestion.mock.calls[0]?.[0] ?? '')).toBe(
        'Orphan 1 resource(s) from cdkd state for MyStack (us-east-1)? ' +
          'AWS resources will NOT be deleted. [y/N] '
      );
    });
  });
});
