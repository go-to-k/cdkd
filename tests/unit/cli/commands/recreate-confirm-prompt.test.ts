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
    const result = await promptRecreateConfirm({ stackName: 'S', targets: [], yes: false });
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
  });

  it('--yes short-circuits the prompt and warn-logs the plan', async () => {
    const result = await promptRecreateConfirm({
      stackName: 'MyStack',
      targets: [target()],
      yes: true,
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
    });
    expect(result).toBe(true);
  });

  it('returns false on "n" response and logs "Deploy cancelled"', async () => {
    readlineQuestion.mockResolvedValueOnce('n');
    const result = await promptRecreateConfirm({
      stackName: 'S',
      targets: [target()],
      yes: false,
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
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).toContain('**DATA LOSS** MyDB (AWS::RDS::DBInstance)');
    expect(warnLines).toContain('--force-stateful-recreation acknowledged');
    expect(warnLines).toContain('DATA: all data in MyDB will be lost (no automatic data migration)');
    // Non-stateful target has neither.
    expect(warnLines).toContain('- OtherFn (AWS::Lambda::Function)');
    expect(warnLines).not.toContain('**DATA LOSS** OtherFn');
  });

  it('renders downstream consumer enumeration when supplied (#650)', async () => {
    await promptRecreateConfirm({
      stackName: 'Producer',
      targets: [target()],
      yes: true,
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
      downstreamConsumers: [],
    });
    const warnLines = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warnLines).not.toContain("Downstream consumers of Producer's outputs");
    expect(warnLines).toContain('per-resource; sibling resources are unaffected');
  });

  it('throws an actionable error in a non-TTY environment when --yes is not set', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      promptRecreateConfirm({ stackName: 'S', targets: [target()], yes: false })
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
    });
    expect(result).toBe(true);
    expect(readlineQuestion).not.toHaveBeenCalled();
  });
});
