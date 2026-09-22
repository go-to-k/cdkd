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
 * - every UNQUOTED `Available: ...` list takes `displayIdent`, so a value whose
 *   sanitization was not the identity gains a visible boundary and cannot render
 *   byte-identical to the genuine entry the message says is missing;
 * - everything else takes `displaySafe`, which neither quotes nor truncates, so
 *   an ordinary value is byte-identical.
 *
 * One case pins the JOINED-list choice, which nothing else here can: every
 * hostile marker below sits MID-value, and `displaySafe` replaces globally, so
 * per-element and whole-string sanitization agree on all of them. They diverge
 * only at an element EDGE, so `edgeLogicalId` carries its marker there.
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
    // `getProviderFor` is the method `orphan-rewriter.ts` actually calls.
    // Stubbing only `getProvider` made the registry throw a TypeError, which
    // the rewriter's catch turned into `no provider available for <type>` — so
    // the unresolvable report was reached through a MOCK-SHAPE MISMATCH rather
    // than through the condition the case claims to model. With the real method
    // present the run takes the modelled arm instead: the provider resolves and
    // `getAttribute` answers `undefined`.
    getProviderFor: vi.fn(() => ({
      provider: { getAttribute: vi.fn(async () => undefined) },
    })),
    getProvider: vi.fn(() => ({ getAttribute: vi.fn(async () => undefined) })),
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: vi.fn() })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';
import {
  AWS_MESSAGE_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../src/utils/display-safe.js';
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
  ZWSP,
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
  // Carries BOTH a forging character and a ZWSP. The ZWSP is what discriminates
  // the two `displaySafe` MODES: `NEL` is removed by the denylist and the
  // allowlist alike, so a region marked with it alone cannot tell them apart,
  // and every `targetRegion` render here passes `{ asciiOnly: true }`.
  region: { raw: `us-${NEL}east${ZWSP}-1`, clean: 'us- east -1' },
  // TRAILING-edge marker: the only position at which sanitizing per element and
  // sanitizing the joined string differ (`A, B` vs `A , B`).
  edgeLogicalId: { raw: `EdgeId${PARA_SEP}`, clean: 'EdgeId' },
  propKey: { raw: `Bucket${CSI}Name`, clean: 'Bucket Name' },
  attribute: { raw: `Arn${LINE_SEP}x`, clean: 'Arn x' },
  resourceType: { raw: `AWS::S3${RLO}::Bucket`, clean: 'AWS::S3 ::Bucket' },
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
    // `'region' in spec` rather than `??`: a spec that names `region: undefined`
    // is asking for a stack with NO synthesized region, which is what makes
    // `pickStackRegion` reach its ambiguity refusal.
    region: 'region' in spec ? spec.region : 'us-east-1',
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
      // No synthesized region to match, two records listed → ambiguous.
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: undefined,
          resources: { A: `${HOSTILE.stackA.raw}/A` },
        },
      ]);
      mockListStacks.mockResolvedValue([
        { stackName: HOSTILE.stackA.raw, region: HOSTILE.region.raw },
        { stackName: HOSTILE.stackA.raw, region: 'eu-west-1' },
      ]);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/A`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `Stack '${HOSTILE.stackA.clean}' has state in multiple regions: ` +
          `"${HOSTILE.region.clean}", eu-west-1.`
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves ordinary regions UNQUOTED, and cdkd\'s own (legacy) literal bare', async () => {
      // `(legacy)` is outside `PLAIN_IDENT`, so routing it through `displayIdent`
      // would quote a string no assembly controls.
      primeStacks([
        { stackName: 'MyStack', region: undefined, resources: { A: 'MyStack/A' } },
      ]);
      mockListStacks.mockResolvedValue([
        { stackName: 'MyStack', region: 'us-east-1' },
        { stackName: 'MyStack' },
      ]);
      await expect(runOrphan(['MyStack/A', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).toContain(
        "Stack 'MyStack' has state in multiple regions: us-east-1, (legacy)."
      );
    });
  });

  describe('the missing-from-state refusal names the stack, the misses and what IS there', () => {
    it('sanitizes the stack, the requested ids and the available ids', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: HOSTILE.region.raw,
          resources: { [HOSTILE.logicalId.raw]: `${HOSTILE.stackA.raw}/Bucket` },
        },
      ]);
      primeState(HOSTILE.stackA.raw, HOSTILE.region.raw, {
        [HOSTILE.otherLogicalId.raw]: entry(),
      });
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain(
        `Resource(s) not in state for stack '${HOSTILE.stackA.clean}' ` +
          `(${HOSTILE.region.clean}): "${HOSTILE.logicalId.clean}".`
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
      // Neither half gains quotes for an ordinary logical id, which is what
      // makes one helper across the whole sentence safe to adopt.
      expect(message).not.toContain('"');
    });
  });

  describe("the rewrite audit's AFTER value is sanitized too", () => {
    it('sanitizes a substituted physical id, not just the (dropped) arm', async () => {
      // `after` was only ever exercised on the `dependency` arm, whose value is
      // the literal `(dropped)` — so nothing reached `stringifyForAudit` with
      // hostile AFTER text. A `Ref` rewrite substitutes the orphan's
      // physicalId, which is STATE-derived and attacker-shaped on a planted
      // record. `U+2029` again, because `JSON.stringify` would escape a C0 to
      // printable ASCII before the sanitizer is reached.
      primeStacks([
        {
          stackName: 'MyStack',
          resources: { Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' },
        },
      ]);
      primeState('MyStack', 'us-east-1', {
        Bucket: entry({ physicalId: `bucket${PARA_SEP}name` }),
        Other: entry({ properties: { BucketName: { Ref: 'Bucket' } } }),
      });
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      const lines = infoLines();
      expect(lines).toContain(
        '  [ref] Other.properties.BucketName: {"Ref":"Bucket"} → "bucket name"'
      );
      expectNoForgingIn(lines);
    });
  });

  describe('a joined list is sanitized per ELEMENT, so the separator stays exact', () => {
    it('keeps `, ` exact for a marker at an element EDGE', async () => {
      // The one position at which per-element and whole-string sanitization
      // differ: `displaySafe` replaces globally, so a MID-value marker is
      // stripped either way, but sanitizing the joined string would leave the
      // replacement space beside the separator and print `EdgeId , Bucket Id`.
      primeStacks([
        {
          stackName: 'MyStack',
          resources: {
            [HOSTILE.edgeLogicalId.raw]: 'MyStack/Edge',
            [HOSTILE.logicalId.raw]: 'MyStack/Bucket',
          },
        },
      ]);
      primeState('MyStack', 'us-east-1', {
        [HOSTILE.edgeLogicalId.raw]: entry(),
        [HOSTILE.logicalId.raw]: entry(),
      });
      await runOrphan(['MyStack/Edge', 'MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(infoLines()).toContain(
        `Target: MyStack (us-east-1); orphaning 2 resource(s): ` +
          `${HOSTILE.edgeLogicalId.clean}, ${HOSTILE.logicalId.clean}`
      );
    });
  });

  describe('the unlisted-stack refusal names the stack', () => {
    it('sanitizes the stack name', async () => {
      // No ref listed, no `--stack-region`, and no synthesized region — the one
      // branch of `pickStackRegion` that refuses before `getState` is reached.
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: undefined,
          resources: { A: `${HOSTILE.stackA.raw}/A` },
        },
      ]);
      mockListStacks.mockResolvedValue([]);
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/A`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      expect(reportedError()).toContain(
        `No state found for stack '${HOSTILE.stackA.clean}'. ` +
          "Run 'cdkd state list' to see available stacks."
      );
      expectNoForgingIn([reportedError()]);
    });

    it('leaves an ordinary stack name byte-identical', async () => {
      primeStacks([{ stackName: 'MyStack', region: undefined, resources: { A: 'MyStack/A' } }]);
      mockListStacks.mockResolvedValue([]);
      await expect(runOrphan(['MyStack/A', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).toContain(
        "No state found for stack 'MyStack'. Run 'cdkd state list' to see available stacks."
      );
    });
  });

  describe('the NORMAL-RUN progress lines — logger.info at default verbosity, no error', () => {
    /**
     * `region` is threaded rather than fixed because the `Target:` and success
     * lines render `targetRegion` beside the stack name, and the state record's
     * own region is what `pickStackRegion` hands them. A probe deleting the
     * sanitizer from THAT interpolation stayed green while this was pinned to a
     * clean `us-east-1`.
     */
    function arrangeSuccess(
      stackName: string,
      logicalId: string,
      otherId: string,
      region: string
    ): void {
      primeStacks([
        {
          stackName,
          region,
          resources: { [logicalId]: `${stackName}/Bucket`, [otherId]: `${stackName}/Other` },
        },
      ]);
      primeState(stackName, region, {
        [logicalId]: entry(),
        [otherId]: entry({ dependencies: [logicalId] }),
      });
    }

    it('sanitizes the target line, the rewrite audit and the success line', async () => {
      arrangeSuccess(
        HOSTILE.stackA.raw,
        HOSTILE.logicalId.raw,
        HOSTILE.otherLogicalId.raw,
        HOSTILE.region.raw
      );
      await runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes']);
      const lines = infoLines();
      expect(lines).toContain(
        `Target: ${HOSTILE.stackA.clean} (${HOSTILE.region.clean}); ` +
          `orphaning 1 resource(s): ${HOSTILE.logicalId.clean}`
      );
      expect(lines).toContain(
        `Orphaned 1 resource(s) from state: ${HOSTILE.stackA.clean} ` +
          `(${HOSTILE.region.clean}). ` +
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
      arrangeSuccess('MyStack', 'Bucket', 'Other', 'us-east-1');
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
          `Available regions: "${HOSTILE.region.clean}".`
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
     * attribute, is what reaches `printUnresolvable` — a `logger.error` row with
     * FIVE interpolations, each needing its own marker. `path` is derived from
     * the property KEY, `attribute` from the template's `Fn::GetAtt`, and
     * `reason` embeds the orphan's `resourceType` AND the attribute, so all
     * three are supplied from the fixture rather than left as clean cdkd text
     * (a probe on any of them was VACUOUS while they were).
     *
     * The row is reached through the MODELLED condition — the provider resolves
     * and its `getAttribute` answers `undefined`. It used to be reached through
     * a mock-shape mismatch instead: the `ProviderRegistry` double exposed only
     * `getProvider` while the rewriter calls `getProviderFor`, so a TypeError
     * took the `no provider available` arm and the case pinned a row cdkd does
     * not produce here. The assertions are `toBe` on the whole row rather than
     * `startsWith`, so the tail cannot hide a change either.
     */
    function arrangeUnresolvable(args: {
      stackName: string;
      orphanId: string;
      siblingId: string;
      propKey: string;
      attribute: string;
      resourceType: string;
    }): void {
      const { stackName, orphanId, siblingId, propKey, attribute, resourceType } = args;
      primeStacks([
        {
          stackName,
          resources: { [orphanId]: `${stackName}/Bucket`, [siblingId]: `${stackName}/Other` },
        },
      ]);
      primeState(stackName, 'us-east-1', {
        [orphanId]: { physicalId: 'p', resourceType, properties: {} },
        [siblingId]: entry({
          properties: { [propKey]: { 'Fn::GetAtt': [orphanId, attribute] } },
        }),
      });
    }

    /** The `logger.error` rows, which are the ones this report indents. */
    function errorRows(): string[] {
      return errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('  '));
    }

    it('sanitizes all five interpolations, one marker per value', async () => {
      arrangeUnresolvable({
        stackName: HOSTILE.stackA.raw,
        orphanId: HOSTILE.logicalId.raw,
        siblingId: HOSTILE.otherLogicalId.raw,
        propKey: HOSTILE.propKey.raw,
        attribute: HOSTILE.attribute.raw,
        resourceType: HOSTILE.resourceType.raw,
      });
      await expect(
        runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes'])
      ).rejects.toThrow();
      const rows = errorRows();
      expect(rows.length).toBe(1);
      expect(rows[0]).toBe(
        `  ${HOSTILE.otherLogicalId.clean}.properties.${HOSTILE.propKey.clean}: ` +
          `${HOSTILE.logicalId.clean}.${HOSTILE.attribute.clean} — ` +
          `provider returned undefined for ${HOSTILE.resourceType.clean}.` +
          `${HOSTILE.attribute.clean}`
      );
      expectNoForgingIn(rows);
    });

    it('leaves ordinary values byte-identical on the same row', async () => {
      arrangeUnresolvable({
        stackName: 'MyStack',
        orphanId: 'Bucket',
        siblingId: 'Other',
        propKey: 'BucketName',
        attribute: 'Arn',
        resourceType: 'AWS::S3::Bucket',
      });
      await expect(runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])).rejects.toThrow();
      const rows = errorRows();
      expect(rows.length).toBe(1);
      expect(rows[0]).toBe(
        '  Other.properties.BucketName: Bucket.Arn — ' +
          'provider returned undefined for AWS::S3::Bucket.Arn'
      );
    });
  });

  describe('the identity lists are capped at STACK_REF_MAX_CODE_POINTS, not 255', () => {
    it('does not cut a legitimate construct path longer than the default cap', async () => {
      // `displayIdent`'s DEFAULT is 255 code points, and a deep CDK path passes
      // it easily — `[cut: N more characters withheld]` inside the list whose
      // only job is to name the paths would be the failure
      // `STACK_REF_MAX_CODE_POINTS` exists to prevent. Dropping the
      // `maxCodePoints` option was green without this.
      const deepPath = `MyStack/${'Nested/'.repeat(60)}Resource`;
      expect(deepPath.length).toBeGreaterThan(255);
      expect(deepPath.length).toBeLessThan(STACK_REF_MAX_CODE_POINTS);
      primeStacks([{ stackName: 'MyStack', resources: { A: deepPath } }]);
      await expect(runOrphan(['MyStack/Nope', '--app', 'noop', '--yes'])).rejects.toThrow();
      const message = reportedError();
      expect(message).toContain(deepPath);
      expect(message).not.toContain('characters withheld');
    });

    it('does not cut a legitimate region list either', async () => {
      primeStacks([
        { stackName: 'MyStack', region: undefined, resources: { A: 'MyStack/A' } },
      ]);
      mockListStacks.mockResolvedValue([
        { stackName: 'MyStack', region: 'us-east-1' },
        { stackName: 'MyStack', region: 'eu-west-1' },
      ]);
      await expect(runOrphan(['MyStack/A', '--app', 'noop', '--yes'])).rejects.toThrow();
      expect(reportedError()).not.toContain('characters withheld');
    });
  });

  describe("the lock-release warn quotes AWS's own text", () => {
    /**
     * The lock key is `cdkd/{stackName}/{region}/lock.json`, so an S3 error
     * naming the key echoes the manifest-derived stack name back through AWS's
     * reply — the same echo path as CloudFormation's `StatusReason`.
     */
    function arrangeReleaseFailure(stackName: string, logicalId: string, reason: string): void {
      primeStacks([{ stackName, resources: { [logicalId]: `${stackName}/Bucket` } }]);
      primeState(stackName, 'us-east-1', { [logicalId]: entry() });
      mockReleaseLock.mockRejectedValue(new Error(reason));
    }

    function warnLines(): string[] {
      return warnSpy.mock.calls.map((call) => String(call[0]));
    }

    it('sanitizes the SDK text', async () => {
      arrangeReleaseFailure(
        HOSTILE.stackA.raw,
        HOSTILE.logicalId.raw,
        `NoSuchKey: cdkd/${HOSTILE.stackA.raw}/us-east-1/lock.json`
      );
      await runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop', '--yes']);
      expect(warnLines()).toContain(
        `Failed to release lock: NoSuchKey: cdkd/${HOSTILE.stackA.clean}/us-east-1/lock.json`
      );
      expectNoForgingIn(warnLines());
    });

    it('CAPS an oversized SDK message and MARKS the cut', async () => {
      // Without this the cap at that site is undiscriminated — swapping
      // `displayAwsMessage` for bare `displaySafe` stayed green.
      const flood = `NoSuchKey: ${'k'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 300)}`;
      arrangeReleaseFailure('MyStack', 'Bucket', flood);
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      const withheld = flood.length - AWS_MESSAGE_MAX_CODE_POINTS;
      expect(withheld).toBeGreaterThan(0);
      expect(
        warnLines().some((line) =>
          line.endsWith(`[cut: ${withheld} more characters withheld]`)
        )
      ).toBe(true);
    });

    it('leaves ordinary SDK text byte-identical', async () => {
      arrangeReleaseFailure('MyStack', 'Bucket', 'NoSuchKey: cdkd/MyStack/us-east-1/lock.json');
      await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);
      expect(warnLines()).toContain(
        'Failed to release lock: NoSuchKey: cdkd/MyStack/us-east-1/lock.json'
      );
    });
  });

  describe('the confirmation prompt names the stack it is about to rewrite', () => {
    it('sanitizes the stack name in the question the operator answers', async () => {
      primeStacks([
        {
          stackName: HOSTILE.stackA.raw,
          region: HOSTILE.region.raw,
          resources: { [HOSTILE.logicalId.raw]: `${HOSTILE.stackA.raw}/Bucket` },
        },
      ]);
      primeState(HOSTILE.stackA.raw, HOSTILE.region.raw, {
        [HOSTILE.logicalId.raw]: entry(),
      });
      readlineQuestion.mockResolvedValue('n');
      await runOrphan([`${HOSTILE.stackA.raw}/Bucket`, '--app', 'noop']);
      const question = String(readlineQuestion.mock.calls[0]?.[0] ?? '');
      expect(question).toContain(
        `from cdkd state for ${HOSTILE.stackA.clean} (${HOSTILE.region.clean})?`
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
