import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * go-to-k/cdkd#3179 / go-to-k/cdkd#3027 / go-to-k/cdkd#3950: every refusal,
 * log line and row in `src/cli/commands/state.ts` that names a stack or a
 * region renders the value through `displayIdent`'s boundary, never raw, never
 * through the bare `asciiOnly` allowlist beside cdkd's own ` (region)`
 * annotation, and never inside cdkd's own hand-written `'...'`.
 *
 * Both polarities per site family: a plain value renders BARE and
 * byte-identically, and a hostile one renders JSON-quoted -- asserted as the
 * exact `JSON.stringify` spelling, since a paste case alone would let a
 * shell-quoted head back in (go-to-k/cdkd#3950's verification plan). The
 * values a site hand-quoted before this change also get a paste case, driven
 * through the shared harness over the WHOLE message.
 *
 * The labelled-pasteable-line sites (the two confirmation prompts and the
 * legacy refusals) are pinned in `state-ref-display-boundary.test.ts` and in
 * the `state resources` / `state show` / `state refresh-observed` suites.
 */
import { setStdinIsTty } from '../../stdin-tty.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  expectOnlyDisplayResidual,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  reserveStdoutForPayload: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));

const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockGetState = vi.fn<(stackName: string, region: string) => Promise<unknown>>();
const mockSaveState = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    listStacks: mockListStacks,
    getState: mockGetState,
    saveState: mockSaveState,
    verifyBucketExists: vi.fn(async () => {}),
    deleteState: vi.fn(async () => {}),
    deleteLegacyState: vi.fn(async () => {}),
  })),
}));

const mockIsLocked = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: vi.fn(async () => {}),
    getLockInfo: mockGetLockInfo,
    acquireLock: vi.fn(async () => true),
    releaseLock: mockReleaseLock,
  })),
}));

const mockReadCurrentState = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    shouldSkipResource: () => false,
    getProviderFor: () => ({ provider: { readCurrentState: mockReadCurrentState } }),
  })),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

import { createStateCommand, resolveSingleRegion } from '../../../src/cli/commands/state.js';

/** The four paste families, whose `'` / `$( )` / backtick / `;` a hand quote let run. */
const HOSTILE = PASTE_PAYLOADS.map((p) => p.value);

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

async function runState(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } catch {
    // A refusal: `handleError` logged it and the exit mock threw.
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

const lines = (spy: typeof infoSpy): string[] => spy.mock.calls.map((c) => String(c[0]));

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('resolveSingleRegion refusals (go-to-k/cdkd#3179, go-to-k/cdkd#3950)', () => {
  it('names a plain stack bare, and a hostile one only inside a JSON boundary', () => {
    expect(refusal(() => resolveSingleRegion('ProdStack', [], undefined))).toBe(
      "No state found for stack ProdStack.\nRun 'cdkd state list' to see available stacks."
    );
    for (const value of HOSTILE) {
      const message = refusal(() => resolveSingleRegion(value, [], undefined));
      expect(message).toContain(`No state found for stack ${JSON.stringify(value)}.`);
      expect(message).not.toContain(`'${value}'`);
    }
  });

  it('bounds the requested region and every listed candidate', () => {
    const refs = [
      { stackName: 'S', region: 'us-east-1' },
      // A planted segment carrying a bare comma: it would read as TWO
      // candidates in a `, `-joined list.
      { stackName: 'S', region: 'eu-west-1,ap-south-1' },
      { stackName: 'S' },
    ];
    expect(refusal(() => resolveSingleRegion('S', refs, 'x (us-east-1)'))).toBe(
      'No state found for stack S in region "x (us-east-1)". ' +
        'Available regions: us-east-1, "eu-west-1,ap-south-1", (legacy).'
    );
  });

  it('bounds every candidate of the multi-region refusal', () => {
    const refs = [
      { stackName: 'S', region: 'us-east-1' },
      { stackName: 'S', region: 'eu-west-1\nForged: all clear' },
    ];
    expect(refusal(() => resolveSingleRegion('S', refs, undefined))).toBe(
      'Stack S has state in multiple regions: us-east-1, "eu-west-1 Forged: all clear".' +
        "\nRe-run with --stack-region '<region>' to disambiguate."
    );
  });

  it('a legitimate refusal is byte-identical apart from the dropped quotes', () => {
    const refs = [
      { stackName: 'Parent~Child', region: 'us-east-1' },
      { stackName: 'Parent~Child', region: 'us-gov-west-1' },
    ];
    expect(refusal(() => resolveSingleRegion('Parent~Child', refs, undefined))).toBe(
      'Stack Parent~Child has state in multiple regions: us-east-1, us-gov-west-1.' +
        "\nRe-run with --stack-region '<region>' to disambiguate."
    );
  });

  it('no pasted span of a hostile refusal runs anything but its display residual', () => {
    withPasteDir((dir) => {
      for (const value of HOSTILE) {
        const refs = [
          { stackName: value, region: 'us-east-1' },
          { stackName: value, region: 'us-west-2' },
        ];
        for (const message of [
          refusal(() => resolveSingleRegion(value, [], undefined)),
          refusal(() => resolveSingleRegion(value, refs, 'eu-west-1')),
          refusal(() => resolveSingleRegion(value, refs, undefined)),
        ]) {
          // Under the harness's OPERATOR_FLIP a displayed value holding `'` runs:
          // the go-to-k/cdkd#3950 residual, tracked for its fix by go-to-k/cdkd#4229.
          expectOnlyDisplayResidual(message, dir, value);
        }
      }
    });
  }, 120_000);
});

describe('the command sites (go-to-k/cdkd#3179, go-to-k/cdkd#3027)', () => {
  let originalIsTty: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalIsTty = process.stdin.isTTY;
    setStdinIsTty(true);
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue();
    mockIsLocked.mockReset();
    mockIsLocked.mockResolvedValue(false);
    mockReleaseLock.mockReset();
    mockReleaseLock.mockResolvedValue();
    mockGetLockInfo.mockReset();
    mockGetLockInfo.mockResolvedValue(null);
    mockReadCurrentState.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    setStdinIsTty(originalIsTty);
    vi.clearAllMocks();
  });

  describe('state destroy', () => {
    it('bounds each name of the missing-stack refusal', async () => {
      mockListStacks.mockResolvedValue([]);
      await runState(['destroy', 'Plain', 'A, B', 'C,', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        'No state found for stack(s): Plain, "A, B", "C,".\n'
      );
    });

    it('keeps a hostile missing-stack name off the remedy line, and no pasted span runs a command fragment', async () => {
      mockListStacks.mockResolvedValue([]);
      const messages: Array<{ value: string; message: string }> = [];
      for (const value of HOSTILE) {
        errorSpy.mockClear();
        // eslint-disable-next-line no-await-in-loop
        await runState(['destroy', value, '--yes']);
        messages.push({ value, message: lines(errorSpy).join('\n') });
      }
      withPasteDir((dir) => {
        for (const { value, message } of messages) {
          expect(message, value).toContain(JSON.stringify(value));
          // The own-line property itself (go-to-k/cdkd#3950): the paste case
          // alone passes on the joined shape too, because bash stops at
          // `stack(s):`'s `(` before the name's substitution runs.
          const nameLine = message.split('\n').find((l) => l.includes(JSON.stringify(value)));
          expect(nameLine, value).toBeDefined();
          expect(nameLine, value).not.toContain('cdkd');
          expect(message.split('\n'), value).toContain(
            "Run 'cdkd state list' to see available stacks."
          );
          // Under the harness's OPERATOR_FLIP a displayed value holding `'` runs:
          // the go-to-k/cdkd#3950 residual, tracked for its fix by go-to-k/cdkd#4229.
          expectOnlyDisplayResidual(message, dir, value);
        }
      });
    }, 120_000);

    it('bounds each name of the found-stacks line', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Plain', region: 'us-east-1' },
        { stackName: 'A, B', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'Plain', 'A, B', '--yes']);
      expect(lines(infoSpy)).toContain('Found 2 stack(s) to destroy: Plain, "A, B"');
    });

    it('spells the multi-region remedy with a quoted region hole', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'S', region: 'us-east-1' },
        { stackName: 'S', region: 'us-west-2' },
      ]);
      await runState(['destroy', 'S', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        "Stack S has state in multiple regions: us-east-1, us-west-2.\nUse --stack-region '<region>' to pick one."
      );
    });

    it('bounds a non-plain name on the no-record skip line', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'Decoy (x)', '--yes']);
      expect(lines(warnSpy)).toContain('No state found for stack "Decoy (x)" in us-east-1, skipping');
    });

    it('does not cut the longest legitimate nested name on the found-stacks line', async () => {
      // The stack-ref cap, not displayIdent's 255 default. `Other` leads the
      // argv so the commander-parse convention fence can count a literal
      // operand before the computed one.
      const deepest = `${'R'.repeat(128)}${`~${'L'.repeat(255)}`.repeat(4)}`;
      mockListStacks.mockResolvedValue([
        { stackName: 'Other', region: 'us-east-1' },
        { stackName: deepest, region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'Other', deepest, '--yes']);
      const found = lines(infoSpy).find((l) => l.startsWith('Found 2 stack(s) to destroy: ')) ?? '';
      expect(found).toBe(`Found 2 stack(s) to destroy: Other, ${deepest}`);
      expect(found).not.toContain('[cut:');
    });

    it('quotes a found name carrying a bare comma', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Plain', region: 'us-east-1' },
        { stackName: 'C,', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'Plain', 'C,', '--yes']);
      expect(lines(infoSpy)).toContain('Found 2 stack(s) to destroy: Plain, "C,"');
    });

    it('names a planted region in its boundary on the preparing and skip lines', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'x) (us-east-1' }]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'S', '--yes']);

      expect(lines(infoSpy)).toContain('\nPreparing to destroy stack: S ("x) (us-east-1")');
      expect(lines(warnSpy)).toContain('No state found for stack S in "x) (us-east-1", skipping');
    });

    it('a legitimate preparing and skip line is byte-identical', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', 'S', '--yes']);

      expect(lines(infoSpy)).toContain('\nPreparing to destroy stack: S (us-east-1)');
      expect(lines(warnSpy)).toContain('No state found for stack S in us-east-1, skipping');
    });

    it('describes a hostile name on the --stack-region skip line, and no pasted span runs under either shell', async () => {
      // A former S1 row (go-to-k/cdkd#3950, classified in the go-to-k/cdkd#4127
      // review M1): the line carries `--stack-region eu-west-1`, a `--flag` in
      // prose, so a name that is not plain is described rather than displayed.
      // Under bash the ` (` after a displayed name stopped a pasted line; zsh
      // ran a `$( )` name past it.
      const messages: Array<{ value: string; message: string }> = [];
      for (const value of HOSTILE) {
        warnSpy.mockClear();
        mockListStacks.mockResolvedValue([{ stackName: value, region: 'us-east-1' }]);
        // eslint-disable-next-line no-await-in-loop
        await runState(['destroy', value, '--stack-region', 'eu-west-1', '--yes']);
        messages.push({ value, message: lines(warnSpy).join('\n') });
      }
      withPasteDir((dir) => {
        for (const { value, message } of messages) {
          expect(message, value).toContain(
            'Skipping a stack name that is not a plain identifier (no state record matches --stack-region eu-west-1)'
          );
          expect(message, value).not.toContain(value);
          expectNoCommandBesideDisplay(message, value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
    }, 120_000);

    it('names the --stack-region skip without cdkd quotes', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      await runState(['destroy', 'S', '--stack-region', "eu-west-1' x", '--yes']);
      expect(lines(warnSpy)).toContain(
        `Skipping S (no state record matches --stack-region ${JSON.stringify("eu-west-1' x")})`
      );
    });
  });

  describe('state orphan', () => {
    it('describes a non-plain requested region and candidate on the no-record refusal', async () => {
      // Described rather than quoted (go-to-k/cdkd#3760): in a multi-stack run
      // this refusal prints below an earlier stack's `Destroy with:` row.
      mockListStacks.mockResolvedValue([
        { stackName: 'S', region: 'us-east-1' },
        { stackName: 'S', region: 'eu-west-1,x' },
      ]);
      await runState(['orphan', 'S', '--stack-region', 'ap-south-1 (x)', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        'No state found for stack S in region a region that is not a plain identifier. ' +
          'Available regions: us-east-1, a region that is not a plain identifier. ' +
          "'cdkd state list --long' shows the records as stored."
      );
    });

    it('describes a non-plain stack name on the no-record refusal', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
      await runState(['orphan', 'Decoy (x)', '--stack-region', 'eu-west-1', '--yes']);
      const message = lines(errorSpy).join('\n');
      expect(message).toContain(
        'No state found for a stack whose name is not a plain identifier in region eu-west-1. ' +
          'Available regions: us-east-1. ' +
          "'cdkd state list --long' shows the records as stored."
      );
      expect(message).not.toContain('Decoy');
    });

    it('adds the pointer when only the requested region is described', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      await runState(['orphan', 'S', '--stack-region', 'ap-south-1 (x)', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        'No state found for stack S in region a region that is not a plain identifier. ' +
          'Available regions: us-east-1. ' +
          "'cdkd state list --long' shows the records as stored."
      );
    });

    it('adds no pointer for a legacy candidate, which prints its own literal', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S' }]);
      await runState(['orphan', 'S', '--stack-region', 'eu-west-1', '--yes']);
      const message = lines(errorSpy).join('\n');
      expect(message).toContain(
        'No state found for stack S in region eu-west-1. Available regions: (legacy).'
      );
      expect(message).not.toContain('state list --long');
    });

    it('adds no pointer when every value is plain', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      await runState(['orphan', 'S', '--stack-region', 'eu-west-1', '--yes']);
      const message = lines(errorSpy).join('\n');
      expect(message).toContain(
        'No state found for stack S in region eu-west-1. Available regions: us-east-1.'
      );
      expect(message).not.toContain('state list --long');
    });

    it('a later stack cannot print a counterfeit Destroy with: row below an earlier one', async () => {
      // The go-to-k/cdkd#4004 security review's multi-stack shape: StackA's
      // real banner prints, then StackB's only record carries a padded region
      // and the no-record refusal names it last.
      const padded = `x${' '.repeat(80)}Destroy with: cdkd destroy --all --force #`;
      mockListStacks.mockResolvedValue([
        { stackName: 'StackA', region: 'us-east-1' },
        { stackName: 'StackB', region: padded },
      ]);
      const out = await runState(['orphan', 'StackA', 'StackB', '--stack-region', 'us-east-1', '--yes']);
      const all = [out, ...lines(infoSpy), ...lines(warnSpy), ...lines(errorSpy)].join('\n');
      expect(all).not.toContain('--all --force');
      expect(lines(errorSpy).join('\n')).toContain(
        'No state found for stack StackB in region us-east-1. ' +
          'Available regions: a region that is not a plain identifier. ' +
          "'cdkd state list --long' shows the records as stored."
      );
    });

    it('describes a non-plain name on the skip line, and shows a plain one', async () => {
      mockListStacks.mockResolvedValue([]);
      await runState(['orphan', 'Decoy (x)', 'Plain', '--yes']);
      expect(lines(infoSpy)).toContain(
        'No state found for stack: a stack name that is not a plain identifier, skipping. ' +
          "'cdkd state list --long' shows the records as stored."
      );
      expect(lines(infoSpy)).toContain('No state found for stack: Plain, skipping');
    });

    it('describes a non-plain name on the LEGACY live-lock warning, and shows a plain one', async () => {
      const live = { owner: 'someone@host:1', expiresAt: Date.now() + 60_000 };
      mockGetLockInfo.mockResolvedValue(live);
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)' }, { stackName: 'LegacyStack' }]);
      await runState(['orphan', 'Decoy (x)', 'LegacyStack', '--yes']);
      const warned = lines(warnSpy).join('\n');
      expect(warned).toContain(
        'Force-releasing a LIVE lock on a stack name that is not a plain identifier (legacy lock key)'
      );
      expect(warned).toContain('Force-releasing a LIVE lock on LegacyStack (legacy lock key)');
    });

    it('bounds a planted region on the lock refusal', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'x) is free (us-east-1' }]);
      mockIsLocked.mockResolvedValue(true);
      await runState(['orphan', 'S', '--yes']);
      // Described, not quoted: a padded region could otherwise wrap into a
      // counterfeit `Run:` row (go-to-k/cdkd#3760).
      expect(lines(errorSpy).join('\n')).toContain(
        'Stack S (a region that is not a plain identifier) is locked.'
      );
    });
  });

  describe('state refresh-observed', () => {
    it('routes a named stack through resolveSingleRegion, bounding every candidate', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'S', region: 'us-east-1' },
        { stackName: 'S', region: 'eu-west-1\nForged: done' },
      ]);
      await runState(['refresh-observed', 'S', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        'Stack S has state in multiple regions: us-east-1, "eu-west-1 Forged: done".' +
          "\nRe-run with --stack-region '<region>' to disambiguate."
      );
    });

    it('names a hostile stack of the no-record refusal inside a boundary', async () => {
      mockListStacks.mockResolvedValue([]);
      const value = "x'$(touch OWNED) #";
      await runState(['refresh-observed', value, '--yes']);
      const message = lines(errorSpy).join('\n');
      expect(message).toContain(`No state found for stack ${JSON.stringify(value)}.`);
      expect(message).not.toContain(`'${value}'`);
    });

    it('bounds the record on the --dry-run plan line', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          resources: { L: { resourceType: 'AWS::S3::Bucket', physicalId: 'p', properties: {} } },
        },
        etag: 'e',
      });
      await runState(['refresh-observed', '--all', '--yes', '--dry-run']);
      expect(lines(infoSpy)).toContain(
        'Plan "Decoy (x)" (us-east-1): 1 resource(s) would be refreshed, 0 unsupported'
      );
    });

    it('bounds the record on the per-stack no-record refusal', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(null);
      await runState(['refresh-observed', '--all', '--yes']);
      expect(lines(errorSpy).join('\n')).toContain(
        'No state found for stack "Decoy (x)" (us-east-1). '
      );
    });

    it('bounds a planted resource type on the failure line', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          resources: {
            L: { resourceType: 'AWS::S3::Bucket) (x', physicalId: 'p', properties: {} },
          },
        },
        etag: 'e',
      });
      mockReadCurrentState.mockRejectedValue(new Error('boom'));
      await runState(['refresh-observed', '--all', '--yes']);
      expect(lines(warnSpy)).toContain(
        '  ✗ S/L ("AWS::S3::Bucket) (x"): readCurrentState failed — boom'
      );
    });

    it('bounds the record on every per-stack line', async () => {
      const ref = { stackName: 'Decoy (x)', region: 'us-east-1' };
      mockListStacks.mockResolvedValue([ref]);
      mockGetState.mockResolvedValue({
        state: {
          stackName: ref.stackName,
          region: ref.region,
          resources: {
            'L (x)': { resourceType: 'AWS::S3::Bucket', physicalId: 'p', properties: {} },
          },
        },
        etag: 'e',
      });
      mockReadCurrentState.mockRejectedValue(new Error('boom'));
      mockReleaseLock.mockRejectedValue(new Error('gone'));
      await runState(['refresh-observed', '--all', '--yes']);

      expect(lines(warnSpy)).toContain(
        '  ✗ "Decoy (x)"/"L (x)" (AWS::S3::Bucket): readCurrentState failed — boom'
      );
      expect(lines(warnSpy)).toContain('Failed to release lock for "Decoy (x)" (us-east-1): gone');
      expect(lines(infoSpy)).toContain(
        '✓ "Decoy (x)" (us-east-1): 0 refreshed, 0 unsupported, 1 failed'
      );
    });

    it('a legitimate per-stack line is byte-identical', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({ state: { resources: {} }, etag: 'e' });
      await runState(['refresh-observed', '--all', '--yes', '--dry-run']);
      expect(lines(infoSpy)).toContain('✓ S (us-east-1): no resources in state, skipping');
    });
  });

  describe('state list --long / state show rows', () => {
    it('bounds the --long Region row', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'S', region: 'us-east-1  Resources: 0' },
        { stackName: 'T', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });
      const out = await runState(['list', '--long']);
      expect(out).toContain('\n  Region: "us-east-1  Resources: 0"\n');
      expect(out).toContain('\n  Region: us-east-1\n');
    });

    it('does not cut the longest legitimate nested name on the Stack and Parent rows', async () => {
      const deepest = `${'R'.repeat(128)}${`~${'L'.repeat(255)}`.repeat(4)}`;
      // The rows render the RECORD's fields, so the listed name the command
      // resolves stays short and literal.
      mockListStacks.mockResolvedValue([{ stackName: 'C', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          version: 2,
          stackName: deepest,
          region: 'us-east-1',
          parentStack: deepest,
          parentRegion: 'us-east-1',
          parentLogicalId: 'PL',
          resources: {},
          outputs: {},
          lastModified: 0,
        },
      });
      const out = await runState(['show', 'C']);
      expect(out).toContain(`Stack: ${deepest}\n`);
      expect(out).toContain(`  Parent: ${deepest} (us-east-1), logical id: PL`);
      expect(out).not.toContain('[cut:');
    });

    it('bounds the Parent row, and keeps a legitimate one byte-identical', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'C', region: 'us-east-1' }]);
      const render = async (parent: Record<string, string>): Promise<string> => {
        mockGetState.mockResolvedValue({
          state: {
            version: 2,
            stackName: 'C',
            region: 'us-east-1',
            resources: {},
            outputs: {},
            lastModified: 0,
            ...parent,
          },
        });
        const out = await runState(['show', 'C']);
        return out.split('\n').find((l) => l.startsWith('  Parent: ')) ?? '';
      };

      expect(
        await render({ parentStack: 'P', parentRegion: 'us-east-1', parentLogicalId: 'PL' })
      ).toBe('  Parent: P (us-east-1), logical id: PL');
      // A planted parent name carrying the row's own annotation.
      expect(
        await render({
          parentStack: 'Real (us-east-1), logical id: X',
          parentRegion: 'eu-west-1',
          parentLogicalId: 'PL',
        })
      ).toBe('  Parent: "Real (us-east-1), logical id: X" (eu-west-1), logical id: PL');
      expect(
        await render({
          parentStack: 'P',
          parentRegion: 'us-east-1), logical id: Y (x',
          parentLogicalId: 'PL, extra',
        })
      ).toBe('  Parent: P ("us-east-1), logical id: Y (x"), logical id: "PL, extra"');
    });
  });
});
