/**
 * go-to-k/cdkd#7057 through the real `DeployEngine` / `DiffCalculator` /
 * resolver: a DBInstance record written before #5640 holds no
 * `AvailabilityZone` where the template declares one. Since #7044 that read as
 * a zone added, and every deploy refused the replacement. The deploy now reads
 * the instance's zone (one `DescribeDBInstances`, for that record only) before
 * its diff; an ordinary deploy reads nothing (#6438).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const rds = vi.hoisted(() => ({
  zone: 'us-east-1a' as string | Error,
  sent: [] as { input: unknown; region: unknown }[],
  destroyed: 0,
}));

const infos = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: (m: unknown): void => void infos.push(String(m)),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  class FakeRDSClient {
    constructor(private readonly config: { region?: unknown }) {}
    async send(command: { input: { DBInstanceIdentifier: string } }): Promise<unknown> {
      rds.sent.push({ input: command.input, region: this.config.region });
      if (rds.zone instanceof Error) throw rds.zone;
      return {
        DBInstances: [
          { DBInstanceIdentifier: command.input.DBInstanceIdentifier, AvailabilityZone: rds.zone },
        ],
      };
    }
    destroy(): void {
      rds.destroyed += 1;
    }
  }
  return { ...actual, RDSClient: FakeRDSClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { StackState } from '../../../src/types/state.js';

type Record_ = StackState['resources'][string];

interface Run {
  calls: string[];
  persisted: Record_ | undefined;
  saves: number;
  thrown: unknown;
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>,
  options: { dryRun?: boolean } = {}
): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push('update:' + id);
      return { physicalId: resources[id]!.physicalId, attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push('delete:' + id);
    }),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Db']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: options.dryRun ?? false },
    'eu-west-1'
  );
  let thrown: unknown;
  await engine.deploy('s', { Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return {
    calls,
    persisted: saved[saved.length - 1]?.resources['Db'],
    saves: saved.length,
    thrown,
  };
}

function chainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join('\n');
}

const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro', AllocatedStorage: '20' };

const template = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  Db: {
    Type: 'AWS::RDS::DBInstance',
    Properties: { ...BASE, AvailabilityZone: 'eu-west-1a', ...extra },
  },
});

const zoneless = (): StackState['resources'] =>
  ({
    Db: {
      physicalId: 'db-legacy',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { ...BASE },
      attributes: {},
      dependencies: [],
    },
  }) as StackState['resources'];

beforeEach(() => {
  rds.zone = 'eu-west-1a';
  rds.sent.length = 0;
  rds.destroyed = 0;
  infos.length = 0;
});

describe('a zone-less pre-#5640 DBInstance record (go-to-k/cdkd#7057)', () => {
  it('the instance runs in the declared zone: no change, one read in the stack region, and the record heals', async () => {
    const run = await deploy(zoneless(), template());
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(rds.sent).toEqual([
      { input: { DBInstanceIdentifier: 'db-legacy' }, region: 'eu-west-1' },
    ]);
    // The one-shot client is destroyed after its call.
    expect(rds.destroyed).toBe(1);
    // Saved by the no-change path, so the next deploy reads nothing.
    expect(run.saves).toBeGreaterThan(0);
    expect(run.persisted?.properties['AvailabilityZone']).toBe('eu-west-1a');
  });

  it('the healed record deploys again with no read', async () => {
    const first = await deploy(zoneless(), template());
    rds.sent.length = 0;
    const second = await deploy({ Db: first.persisted! }, template());
    expect(second.thrown).toBeUndefined();
    expect(second.calls).toEqual([]);
    expect(rds.sent).toEqual([]);
  });

  it('another property changed: updated in place, not refused, and the zone recorded', async () => {
    const run = await deploy(zoneless(), template({ AllocatedStorage: '30' }));
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Db']);
    expect(rds.sent).toHaveLength(1);
    expect(run.persisted?.properties['AvailabilityZone']).toBe('eu-west-1a');
  });

  it('the instance runs in another zone: the replacement stands and the stateful guard refuses it', async () => {
    rds.zone = 'eu-west-1b';
    const run = await deploy(zoneless(), template());
    // The refusal's reason is named at info: the instance's own zone.
    expect(infos.some((m) => m.includes('runs in eu-west-1b, not the declared eu-west-1a'))).toBe(true);
    expect(chainText(run.thrown)).toContain('--force-stateful-recreation');
    expect(run.calls).toEqual([]);
    expect(rds.sent).toHaveLength(1);
  });

  it('the zone cannot be read: fails closed toward the refusal', async () => {
    rds.zone = Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
    const run = await deploy(zoneless(), template());
    // Destroyed on a rejected call too.
    expect(rds.destroyed).toBe(1);
    expect(chainText(run.thrown)).toContain('--force-stateful-recreation');
    expect(run.calls).toEqual([]);
  });

  it('--dry-run reads the zone (read-only) and saves nothing', async () => {
    const run = await deploy(zoneless(), template(), { dryRun: true });
    expect(run.thrown).toBeUndefined();
    expect(rds.sent).toHaveLength(1);
    expect(run.saves).toBe(0);
  });
});

describe('an ordinary deploy reads no zone (#6438)', () => {
  it('a record holding the declared zone, unchanged or updated', async () => {
    const recorded = (): StackState['resources'] => {
      const r = zoneless();
      r['Db']!.properties = { ...BASE, AvailabilityZone: 'eu-west-1a' };
      return r;
    };
    expect((await deploy(recorded(), template())).thrown).toBeUndefined();
    const updated = await deploy(recorded(), template({ AllocatedStorage: '30' }));
    expect(updated.calls).toEqual(['update:Db']);
    expect(rds.sent).toEqual([]);
  });

  it('a zone-less record whose template declares no zone either', async () => {
    const { AvailabilityZone: _dropped, ...props } = (template()['Db'] as { Properties: Record<string, unknown> })
      .Properties;
    const run = await deploy(zoneless(), {
      Db: { Type: 'AWS::RDS::DBInstance', Properties: props },
    });
    expect(run.thrown).toBeUndefined();
    expect(rds.sent).toEqual([]);
  });

  it('a genuine zone move on a record holding a zone: refused, with no read', async () => {
    const r = zoneless();
    r['Db']!.properties = { ...BASE, AvailabilityZone: 'eu-west-1b' };
    const run = await deploy(r, template());
    expect(chainText(run.thrown)).toContain('--force-stateful-recreation');
    expect(rds.sent).toEqual([]);
  });

  it('a first deploy (no record)', async () => {
    const run = await deploy({}, template());
    expect(run.calls).toEqual(['create:Db']);
    expect(rds.sent).toEqual([]);
  });
});
