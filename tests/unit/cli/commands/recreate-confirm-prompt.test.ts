/**
 * Unit tests for the #649 interactive prompt for `--recreate-via-cc-api`.
 *
 * Covers:
 *   - `--yes` short-circuit (prompt skipped, plan still warn-logged)
 *   - interactive `y` / `n` / EOL responses
 *   - DATA LOSS prefix + DATA caveat for stateful targets
 *   - generic downstream caveat appended once per call
 *   - empty target list → no-op (returns true)
 *   - non-TTY without --yes → throws actionable error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RecreateTarget } from '../../../../src/deployment/recreate-targets.js';

const warnSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    warn: warnSpy,
    info: infoSpy,
    debug: vi.fn(),
    error: vi.fn(),
    child: () => ({ warn: warnSpy, info: infoSpy, debug: vi.fn(), error: vi.fn() }),
  }),
}));

const readlineQuestion = vi.fn();
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: readlineQuestion, close: vi.fn() }),
  },
}));

const { promptRecreateConfirm } = await import(
  '../../../../src/cli/commands/recreate-confirm-prompt.js'
);

function target(overrides: Partial<RecreateTarget> = {}): RecreateTarget {
  return {
    logicalId: 'MyLambda',
    resourceType: 'AWS::Lambda::Function',
    physicalId: 'fn-pid',
    statefulReason: null,
    direction: 'to-cc-api',
    ...overrides,
  };
}

describe('promptRecreateConfirm (#649)', () => {
  const origIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    warnSpy.mockReset();
    infoSpy.mockReset();
    readlineQuestion.mockReset();
    // Default to TTY=true so prompt path runs; per-test overrides.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('returns true without prompting when target list is empty', async () => {
    const result = await promptRecreateConfirm({ stackName: 'S', targets: [], yes: false, forceStatefulRecreation: false });
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
  });

  it('--yes short-circuits the prompt and warn-logs the plan', async () => {
    const result = await promptRecreateConfirm({
      stackName: 'MyStack',
      targets: [target()],
      yes: true,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(true);
    expect(readlineQuestion).not.toHaveBeenCalled();
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toContain('--recreate-via-cc-api will destroy + recreate 1');
    expect(warnLines).toContain('MyLambda (AWS::Lambda::Function)');
    expect(warnLines).toContain('per-resource; sibling resources are unaffected');
  });

  it('returns true on "y" response', async () => {
    readlineQuestion.mockResolvedValueOnce('y');
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: false,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(true);
    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(readlineQuestion.mock.calls[0]![0]).toMatch(/Continue\? \(y\/N\)/);
  });

  it('returns true on "yes" / case-insensitive', async () => {
    readlineQuestion.mockResolvedValueOnce('YES');
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: false,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(true);
  });

  it('returns false on "n" response and logs "Deploy cancelled"', async () => {
    readlineQuestion.mockResolvedValueOnce('n');
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: false,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(false);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('Deploy cancelled'))).toBe(true);
  });

  it('returns false on bare EOL (empty input) — default-no', async () => {
    readlineQuestion.mockResolvedValueOnce('');
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: false,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(false);
  });

  it('prefixes stateful targets with **DATA LOSS** and appends DATA caveat', async () => {
    readlineQuestion.mockResolvedValueOnce('y');
    await promptRecreateConfirm({
      stackName: 'S',
      targets: [
        target({ logicalId: 'MyDB', resourceType: 'AWS::RDS::DBInstance', statefulReason: 'always' }),
        target({ logicalId: 'OtherFn' }),
      ],
      yes: false,
      // A non-null reason only reaches this prompt under the force flag (the
      // probe path throws the refusal instead), so the realistic pairing is
      // `true` — and it also pins that the flag does not DOWNGRADE a verdict.
      forceStatefulRecreation: true,
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toContain('**DATA LOSS** MyDB (AWS::RDS::DBInstance)');
    expect(warnLines).toContain('--force-stateful-recreation acknowledged');
    // `renderStatefulReason`, not the raw discriminator — a reader of the plan
    // is shown the sentence, not the enum member.
    expect(warnLines).toContain('stateful (destroy loses all data in the resource)');
    expect(warnLines).not.toContain('stateful (always)');
    expect(warnLines).toContain('DATA: all data in MyDB will be lost (no automatic data migration)');
    // Non-stateful target has neither.
    expect(warnLines).toContain('- OtherFn (AWS::Lambda::Function)');
    expect(warnLines).not.toContain('**DATA LOSS** OtherFn');
  });

  describe('conditional types under --force-stateful-recreation (#2558)', () => {
    // `probeAndRevalidateStateful` returns EARLY under the force flag, so the
    // live emptiness probes never run and every target still carries the SYNC
    // verdict — which for the two conditional types is `null` (DEFER), not
    // "no data". Reading that `null` as "not stateful" is the exact mistake
    // #2558 retired one layer down; these pin that the prompt does not repeat
    // it.
    it('shows **DATA LOSS** for a never-expiring log group whose sync reason is null', async () => {
      await promptRecreateConfirm({
        stackName: 'S',
        targets: [
          target({
            logicalId: 'NeverExpireLg',
            resourceType: 'AWS::Logs::LogGroup',
            physicalId: '/aws/lambda/fn',
            statefulReason: null,
          }),
        ],
        yes: true,
        forceStatefulRecreation: true,
      });
      const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(warnLines).toContain('**DATA LOSS** NeverExpireLg (AWS::Logs::LogGroup)');
      expect(warnLines).toContain('DATA: all data in NeverExpireLg will be lost');
      // A RE-DERIVED reason gets its own wording, not `renderStatefulReason`'s.
      // The probe did not run here, so the plan may report that emptiness was
      // not established — and must not borrow a sentence that asserts what
      // WAS found (`renderStatefulReason('has-objects')` is the assertive "S3
      // bucket is non-empty", and the two types share this line).
      expect(warnLines).toContain(
        'stateful (emptiness not established — --force-stateful-recreation skips the probe)'
      );
      expect(warnLines).not.toContain('log group is not provably empty');
    });

    it('shows **DATA LOSS** for an S3 bucket whose sync reason is null', async () => {
      // The bucket half was already wrong before #2558 — its sync verdict has
      // ALWAYS deferred — so it is pinned alongside rather than assumed.
      await promptRecreateConfirm({
        stackName: 'S',
        targets: [
          target({
            logicalId: 'DataBucket',
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'data-bucket',
            statefulReason: null,
          }),
        ],
        yes: true,
        forceStatefulRecreation: true,
      });
      const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(warnLines).toContain('**DATA LOSS** DataBucket (AWS::S3::Bucket)');
      // And the bucket is the reason the re-derived wording exists at all: it
      // must NOT be told it is non-empty on a path where nothing was probed.
      expect(warnLines).not.toContain('S3 bucket is non-empty');
      expect(warnLines).toContain(
        'stateful (emptiness not established — --force-stateful-recreation skips the probe)'
      );
    });

    it('does NOT escalate a null reason when the probe DID run', async () => {
      // The other polarity, and the reason the flag is a parameter rather than
      // an unconditional conservative render: without the force flag the probe
      // RAN, so its `null` is the answer of something that actually measured,
      // and warning over it would be a false alarm on the one path that did.
      //
      // Precisely for the LOG GROUP, which is what this case pins. The S3 arm
      // fails OPEN, so a bucket whose `ListObjectVersions` THREW also reaches
      // here with `null` and no data-loss line — an under-warning that is
      // still open. Issue #2578 closed the arm's non-ANSWER handling (a
      // truncated page now refuses) but deliberately did not touch the
      // fail-open posture of a probe that never answered at all, which is
      // where this case lives.
      await promptRecreateConfirm({
        stackName: 'S',
        targets: [
          target({
            logicalId: 'ProvenEmptyLg',
            resourceType: 'AWS::Logs::LogGroup',
            physicalId: '/aws/lambda/fn',
            statefulReason: null,
          }),
        ],
        yes: true,
        forceStatefulRecreation: false,
      });
      const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(warnLines).toContain('- ProvenEmptyLg (AWS::Logs::LogGroup)');
      expect(warnLines).not.toContain('**DATA LOSS**');
      expect(warnLines).not.toContain('DATA: all data in ProvenEmptyLg');
    });

    it('trusts a bag-derived reason as-is instead of re-deriving it', async () => {
      // The discriminating case for "a recorded reason is trusted as-is": a
      // `has-retention` log group under the force flag. `null` is what triggers
      // the re-derivation, so a non-null reason must reach the renderer
      // untouched — and the two now render DIFFERENTLY, which is what makes the
      // case checkable at all (before the re-derived wording split off, both
      // sides produced the same sentence and nothing here could tell them
      // apart).
      await promptRecreateConfirm({
        stackName: 'S',
        targets: [
          target({
            logicalId: 'RetainingLg',
            resourceType: 'AWS::Logs::LogGroup',
            physicalId: '/aws/lambda/fn',
            statefulReason: 'has-retention',
          }),
        ],
        yes: true,
        forceStatefulRecreation: true,
      });
      const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(warnLines).toContain('**DATA LOSS** RetainingLg (AWS::Logs::LogGroup)');
      expect(warnLines).toContain('stateful (log group retains data (RetentionInDays > 0))');
      expect(warnLines).not.toContain('emptiness not established');
    });

    it('leaves a non-conditional type alone when its sync reason is null', async () => {
      // Guard-the-guard: the escalation is keyed on the TYPE, so a Lambda must
      // not pick up a DATA LOSS line merely because the flag is set.
      await promptRecreateConfirm({
        stackName: 'S',
        targets: [target({ logicalId: 'PlainFn' })],
        yes: true,
        forceStatefulRecreation: true,
      });
      const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(warnLines).toContain('- PlainFn (AWS::Lambda::Function)');
      expect(warnLines).not.toContain('**DATA LOSS**');
    });
  });

  it('renders downstream consumer enumeration when supplied (#650)', async () => {
    await promptRecreateConfirm({
      stackName: 'Producer',
      targets: [target()],
      yes: true,
      forceStatefulRecreation: false,
      downstreamConsumers: [
        {
          consumerStack: 'StackB',
          consumerRegion: 'us-east-1',
          exportName: 'ProducerArn',
          intrinsic: 'ImportValue',
        },
        {
          consumerStack: 'StackC',
          consumerRegion: 'us-east-1',
          exportName: 'OtherArn',
          intrinsic: 'ImportValue',
        },
      ],
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toContain("Downstream consumers of Producer's outputs");
    expect(warnLines).toContain('- StackB (us-east-1) reads ProducerArn via Fn::ImportValue');
    expect(warnLines).toContain('- StackC (us-east-1) reads OtherArn via Fn::ImportValue');
    expect(warnLines).toContain('per-resource; sibling resources are unaffected');
  });

  it('skips downstream enumeration section when the list is empty (#650)', async () => {
    await promptRecreateConfirm({
      stackName: 'Producer',
      targets: [target()],
      yes: true,
      forceStatefulRecreation: false,
      downstreamConsumers: [],
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).not.toContain("Downstream consumers of Producer's outputs");
    expect(warnLines).toContain('per-resource; sibling resources are unaffected');
  });

  it('throws an actionable error in a non-TTY environment when --yes is not set', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      promptRecreateConfirm({ stackName: 'S', targets: [target()], yes: false, forceStatefulRecreation: false })
    ).rejects.toThrow(/--recreate-via-cc-api confirm prompt cannot run in a non-interactive/);
    expect(readlineQuestion).not.toHaveBeenCalled();
  });

  it('renders the [CC → SDK] direction tag for to-sdk targets (#651)', async () => {
    await promptRecreateConfirm({
      stackName: 'S',
      targets: [
        target({ direction: 'to-sdk', logicalId: 'BackLambda' }),
      ],
      yes: true,
      forceStatefulRecreation: false,
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toContain('--recreate-via-sdk-provider will destroy + recreate 1');
    expect(warnLines).toContain('SDK Provider');
    expect(warnLines).toContain('BackLambda (AWS::Lambda::Function) [CC → SDK]');
  });

  it('renders mixed-direction header when both lists are non-empty (#651)', async () => {
    await promptRecreateConfirm({
      stackName: 'S',
      targets: [
        target({ direction: 'to-cc-api', logicalId: 'FwdLambda' }),
        target({ direction: 'to-sdk', logicalId: 'BackLambda' }),
      ],
      yes: true,
      forceStatefulRecreation: false,
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toMatch(
      /recreate-via-cc-api \/ recreate-via-sdk-provider will destroy \+ recreate 2 resource\(s\) on stack S \(1 → Cloud Control, 1 → SDK Provider\)/
    );
    expect(warnLines).toContain('FwdLambda (AWS::Lambda::Function) [SDK → CC]');
    expect(warnLines).toContain('BackLambda (AWS::Lambda::Function) [CC → SDK]');
  });

  it('still skips the prompt in a non-TTY environment when --yes IS set (CI path)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: true,
      forceStatefulRecreation: false,
    });
    expect(result).toBe(true);
    expect(readlineQuestion).not.toHaveBeenCalled();
  });
});

// The prompt's `forceStatefulRecreation` input is a REQUIRED field, so no call
// site can omit it — but "required" only forces PRESENCE. Every case above
// constructs its own input, so hard-coding `false` at the single production
// call site reinstates exactly the bug this field exists to fix and leaves the
// whole suite green. A behavioural pin is out of reach: the call sits inside
// `deployCommand`, past synth and past the AWS clients. So it is pinned at the
// source, the same shape `recreate-targets.test.ts` uses for the probe's
describe('a bucket whose probe FAILED is a third display state (#2595)', () => {
  const origIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    warnSpy.mockReset();
    infoSpy.mockReset();
    readlineQuestion.mockReset();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  const bucket = (overrides: Partial<RecreateTarget> = {}): RecreateTarget =>
    target({
      logicalId: 'MyBucket',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'my-bucket',
      ...overrides,
    });

  async function planFor(t: RecreateTarget): Promise<string> {
    await promptRecreateConfirm({
      stackName: 'S',
      targets: [t],
      yes: true,
      forceStatefulRecreation: false,
    });
    return warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
  }

  it('says the emptiness was not established, and what that costs', async () => {
    const plan = await planFor(bucket({ probeUnresolved: true }));
    expect(plan).toContain('emptiness NOT established: the live probe failed');
    expect(plan).toContain(
      'UNKNOWN: if MyBucket holds data, the destroy + recreate loses it'
    );
    // NOT the data-loss shape: cdkd observed no contents and must not assert
    // any. Asserted as the ABSENCE of both halves, because either alone would
    // make this row read as measured-non-empty.
    expect(plan).not.toContain('**DATA LOSS**');
    expect(plan).not.toContain('DATA: all data in MyBucket will be lost');
  });

  it('is distinguishable from a bucket the probe MEASURED as empty', async () => {
    // The defect this closes was that these two rendered identically. Compare
    // them directly rather than asserting one in isolation — an assertion on
    // the unresolved row alone passes even if the measured row grew the same
    // sentence.
    const unresolved = await planFor(bucket({ probeUnresolved: true }));
    warnSpy.mockReset();
    const measuredEmpty = await planFor(bucket());
    expect(measuredEmpty).toContain('MyBucket (AWS::S3::Bucket)');
    expect(measuredEmpty).not.toContain('emptiness NOT established');
    expect(measuredEmpty).not.toContain('UNKNOWN:');
    expect(unresolved).not.toBe(measuredEmpty);
  });

  it('lets a MEASURED verdict win — the flag never downgrades a real reason', async () => {
    // `probeUnresolved` is a display sibling, not a verdict. If both are set
    // (which the probe never does today) the stateful reason must still drive
    // the row, or the flag would silently soften a genuine refusal.
    //
    // What this pins is the ORDERING of the two consumers, measured: swapping
    // either to test `unresolved` first reds four cases here. It does NOT pin
    // the `!stateful` conjunct in the source, which is redundant precisely
    // because that ordering holds — deleting it leaves the suite green, and
    // the source says so rather than letting a reader infer a guard that is
    // doing work.
    const plan = await planFor(bucket({ statefulReason: 'has-objects', probeUnresolved: true }));
    expect(plan).toContain('**DATA LOSS**');
    expect(plan).toContain('DATA: all data in MyBucket will be lost');
    expect(plan).not.toContain('emptiness NOT established');
  });
});

// clients, and for the same reason — the wrong value is invisible to every
// mock in this file and would surface only against real AWS.
describe('deploy.ts tells the prompt whether the probe ran (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', 'deploy.ts'), 'utf8');
  // Live lines only: a commented-out spelling must fail this pin, not satisfy
  // it — the failure mode a whole-file `toContain` walks straight into.
  const liveLines = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');

  it('forwards the CLI flag, not a literal', () => {
    const callIdx = liveLines.indexOf('promptRecreateConfirm({');
    expect(callIdx, 'live promptRecreateConfirm call not found').toBeGreaterThan(-1);
    // Bound the window to the call itself, so a matching spelling elsewhere in
    // this 1000-line command cannot satisfy the pin.
    const call = liveLines.slice(callIdx, callIdx + 500);
    expect(call).toContain('forceStatefulRecreation: options.forceStatefulRecreation');
    // The discriminating half: a literal would still satisfy a bare
    // "the key is present" check, and `false` is the value that hides a
    // never-expiring log group's **DATA LOSS** line.
    expect(call).not.toMatch(/forceStatefulRecreation:\s*(?:true|false)\b/);
  });
});
