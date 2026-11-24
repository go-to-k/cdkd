/**
 * go-to-k/cdkd#6958: the failed-op arm for a delete-first link whose new copy
 * failed to create. A destroy's replay (`forDestroy`) drops the stack's
 * records, so it must not re-create the old link: the record would go
 * nowhere and the link would stay in AWS, holding the VPC the destroy deletes
 * next. It takes the warned skip instead.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { replayReplacedDeleted } from '../../../src/deployment/rollback-executor/replay-failed-replaced-deleted.js';
import type { ReplacedDeletedScope } from '../../../src/deployment/rollback-executor/replay-failed-replaced-deleted.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor/types.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const TYPE = 'AWS::EC2::VPCGatewayAttachment';

function scope(forDestroy: boolean) {
  const create = vi.fn();
  const getProviderFor = vi.fn(() => ({ provider: { create }, provisionedBy: 'sdk' }));
  const warn = vi.fn();
  const recordEvent = vi.fn();
  const op = {
    logicalId: 'Att',
    changeType: 'UPDATE',
    resourceType: TYPE,
    physicalId: 'IGW|igw-1|vpc-a',
    oldDeletedBeforeCreate: true,
    previousState: {
      physicalId: 'IGW|igw-1|vpc-a',
      resourceType: TYPE,
      properties: { InternetGatewayId: 'igw-1', VpcId: 'vpc-a' },
      attributes: {},
    },
  } as unknown as FailedOperation;
  const s = {
    op,
    stateResources: { Att: { ...op.previousState! } },
    stackName: 'S',
    ctx: {
      logger: { warn, info: vi.fn(), debug: vi.fn() },
      recordEvent,
      providerRegistry: { getProviderFor },
      region: 'us-east-1',
    },
    result: { failures: 0, warnings: 0, skipped: 0 },
    mask: (t: string) => t,
    secrets: new Map(),
    resolver: {},
    options: { forDestroy },
  } as unknown as ReplacedDeletedScope;
  return { s, create, getProviderFor, warn, recordEvent };
}

describe('recreate-failed-replaced-deleted under a destroy (#6958)', () => {
  it('a destroy skips the re-create with the warned skip, and creates nothing', async () => {
    const { s, create, getProviderFor, warn, recordEvent } = scope(true);
    await replayReplacedDeleted('recreate-failed-replaced-deleted', s);
    expect(getProviderFor).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('the destroy drops its record with the stack');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ROLLBACK_RESOURCE_SKIPPED', logicalId: 'Att' })
    );
  });

  it('outside a destroy the same action routes to the re-create (negative control)', async () => {
    const { s, getProviderFor, warn } = scope(false);
    // The re-create's own wiring is the engine suite's; here it only has to be
    // reached, which the stubbed registry proves before anything else runs.
    await replayReplacedDeleted('recreate-failed-replaced-deleted', s).catch(() => undefined);
    expect(getProviderFor).toHaveBeenCalledWith({ resourceType: TYPE, provisionedBy: undefined });
    expect(warn).not.toHaveBeenCalled();
  });
});
