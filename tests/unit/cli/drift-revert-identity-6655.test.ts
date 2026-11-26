/**
 * go-to-k/cdkd#6655: a `drift --revert` in-place update that answers with
 * another identity id than the recorded one keeps the recorded id and warns,
 * naming the attribute only (as the deploy and rollback paths do).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { applyRevertUpdate } from '../../../src/cli/commands/drift/revert-apply.js';
import type { ApplyRevertUpdateArgs } from '../../../src/cli/commands/drift/revert-outcome.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

function harness(update: ResourceProvider['update'], recorded: Record<string, unknown>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tally = { totalFailed: 0, totalUnsupported: 0, totalSucceeded: 0, totalUnresolvable: 0, reverted: [] };
  const stateResource = {
    physicalId: 'my-role',
    resourceType: 'AWS::IAM::Role',
    properties: { MaxSessionDuration: 3600 },
    attributes: recorded,
    dependencies: [],
  } as unknown as ResourceState;
  const args = {
    logger,
    tally,
    report: { stackName: 'MyStack', region: 'us-east-1', state: { resources: {} } },
    narrowedByLogicalId: new Map(),
    reRecordedByLogicalId: new Map(),
    settledByRevert: new Map(),
    outcome: {
      kind: 'drifted',
      logicalId: 'AppRole',
      resourceType: 'AWS::IAM::Role',
      changes: [],
      awsProperties: { MaxSessionDuration: 7200 },
      uncertifiedPaths: [],
    },
    stateResource,
    provider: { create: vi.fn(), update: vi.fn(update), delete: vi.fn() },
    secrets: new Map<string, string>(),
    revertBaseline: { MaxSessionDuration: 3600 },
    newProperties: { MaxSessionDuration: 3600 },
  } as unknown as ApplyRevertUpdateArgs;
  return { args, logger };
}

const warned = (fn: ReturnType<typeof vi.fn>): string =>
  fn.mock.calls.map((c) => String(c[0])).join('\n');

describe('drift --revert and the recorded identity id (go-to-k/cdkd#6655)', () => {
  it('another RoleId answered: warned, attribute only', async () => {
    const h = harness(
      () =>
        Promise.resolve({
          physicalId: 'my-role',
          wasReplaced: false,
          attributes: { RoleId: 'role-id-other' },
        }),
      { RoleId: 'role-id-recorded' }
    );
    await applyRevertUpdate(h.args);
    expect(warned(h.logger.warn)).toContain(
      'AppRole (AWS::IAM::Role): the update answered with another RoleId than the recorded one'
    );
    expect(warned(h.logger.warn)).not.toContain('role-id-other');
    expect(warned(h.logger.warn)).not.toContain('role-id-recorded');
  });

  it('the same RoleId, or a legacy record acquiring one: no warning', async () => {
    for (const recorded of [{ RoleId: 'role-id-recorded' }, {}]) {
      const h = harness(
        () =>
          Promise.resolve({
            physicalId: 'my-role',
            wasReplaced: false,
            attributes: { RoleId: 'role-id-recorded' },
          }),
        recorded
      );
      await applyRevertUpdate(h.args);
      expect(warned(h.logger.warn)).not.toContain('another RoleId');
    }
  });
});
