import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { DeploymentApprovalRequest } from '../../../src/deployment/deploy-engine/options.js';

const mockConfirm = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/confirm-prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cli/commands/confirm-prompt.js')>()),
  confirmOrRefuse: mockConfirm,
}));
vi.mock('../../../src/cli/config-loader.js', () => ({ loadCdkJson: vi.fn(() => null) }));

import {
  createApprovalPrompter,
  renderApprovalRequest,
  resolveRequireApproval,
} from '../../../src/cli/commands/require-approval.js';

const request = (stackName: string): DeploymentApprovalRequest => ({
  stackName,
  level: 'destructive',
  counts: { create: 1, update: 2, delete: 1 },
  destructiveChanges: [
    { stackName, logicalId: 'Table', resourceType: 'AWS::DynamoDB::Table', impact: 'WILL_ORPHAN' },
  ],
});

describe('resolveRequireApproval', () => {
  const logger = { warn: vi.fn() };
  beforeEach(() => logger.warn.mockReset());

  it('takes the flag over cdk.json', () => {
    expect(resolveRequireApproval('any-change', logger, { requireApproval: 'destructive' })).toBe(
      'any-change'
    );
  });

  it('reads cdk.json, and defaults to never', () => {
    expect(resolveRequireApproval(undefined, logger, { requireApproval: 'destructive' })).toBe(
      'destructive'
    );
    expect(resolveRequireApproval(undefined, logger, {})).toBe('never');
    expect(resolveRequireApproval(undefined, logger, null)).toBe('never');
  });

  it("ignores cdk.json's broadening with a warning instead of failing the deploy", () => {
    expect(resolveRequireApproval(undefined, logger, { requireApproval: 'broadening' })).toBe(
      'never'
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"broadening" is ignored'));
  });

  it('refuses any other cdk.json value', () => {
    expect(() => resolveRequireApproval(undefined, logger, { requireApproval: 'always' })).toThrow(
      'cdk.json "requireApproval" must be one of never, any-change, destructive, got: always'
    );
  });
});

describe('createApprovalPrompter', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockConfirm.mockReset();
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => stdout.mockRestore());

  it('approves under --yes without asking or printing', async () => {
    await expect(createApprovalPrompter({ yes: true })(request('S'))).resolves.toBe(true);
    // go-to-k/cdkd#4705 review H-3: and says it asks no one.
    expect(createApprovalPrompter({ yes: true }).autoApproves).toBe(true);
    expect(createApprovalPrompter({ yes: false }).autoApproves).toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('lists the changes, then asks, refusing a non-interactive stdin with the remedy', async () => {
    mockConfirm.mockResolvedValue(false);
    await expect(createApprovalPrompter({ yes: false })(request('S'))).resolves.toBe(false);
    expect(String(stdout.mock.calls[0]![0])).toContain('  S: AWS::DynamoDB::Table Table will be orphaned');
    const [, opts] = mockConfirm.mock.calls[0]!;
    expect(opts.refusal).toContain('requires approval (--require-approval=destructive)');
    expect(opts.refusal).toContain('Re-run with --yes');
  });

  it('serializes prompts from concurrent stacks, even after one throws', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    mockConfirm
      .mockImplementationOnce(async () => {
        order.push('A asked');
        await new Promise<void>((r) => (releaseFirst = r));
        order.push('A answered');
        throw new Error('non-interactive');
      })
      .mockImplementationOnce(async () => {
        order.push('B asked');
        return true;
      });
    const prompt = createApprovalPrompter({ yes: false });
    const a = prompt(request('A'));
    const b = prompt(request('B'));
    await vi.waitFor(() => expect(order).toEqual(['A asked']));
    releaseFirst();
    await expect(a).rejects.toThrow('non-interactive');
    await expect(b).resolves.toBe(true);
    expect(order).toEqual(['A asked', 'A answered', 'B asked']);
  });
});

describe('renderApprovalRequest', () => {
  it('names the stack, the counts and the level', () => {
    const text = renderApprovalRequest(request('S'));
    expect(text).toContain('Destructive changes:\n  S: AWS::DynamoDB::Table Table will be orphaned');
    expect(text).toContain('Stack S: 1 to create, 2 to update, 1 to delete.');
    expect(text).toContain(`"--require-approval" is set to 'destructive'.`);
  });

  it('has no destructive section under any-change when there is none', () => {
    const text = renderApprovalRequest({ ...request('S'), level: 'any-change', destructiveChanges: [] });
    expect(text).not.toContain('Destructive changes:');
    expect(text).toContain(`"--require-approval" is set to 'any-change'.`);
  });

  it('says an Outputs-only change has no resource changes', () => {
    const text = renderApprovalRequest({
      ...request('S'),
      level: 'any-change',
      destructiveChanges: [],
      counts: { create: 0, update: 0, delete: 0 },
      outputsOnly: true,
    });
    expect(text).toContain('Stack S: no resource changes; its Outputs change.');
    expect(text).not.toContain('to create');
  });
});
