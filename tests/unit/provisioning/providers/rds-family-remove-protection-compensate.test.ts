/**
 * `--remove-protection` compensation on the RDS family (issue #2204): RDS
 * DBCluster + DBInstance, DocDB DBCluster, Neptune DBCluster + DBInstance.
 *
 * Every site runs the SAME cases, so a site that loses its readback, its
 * `deleteAccepted` latch or its boundary goes red on its own row. The
 * mechanism's own cases (gates, outcome split, logger-throw) are fenced once
 * for the DynamoDB wording in `dynamodb-remove-protection-compensate.test.ts`;
 * this file fences that each RDS-family site is WIRED to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const rdsSend = vi.fn();
const docdbSend = vi.fn();
const neptuneSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: docdbSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: neptuneSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RDSProvider } from '../../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../../src/provisioning/providers/neptune-provider.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  rdsFamilyProtectionSite,
} from '../../../../src/provisioning/providers/deletion-protection-compensation.js';
import { WITHHELD_AWS_COMMAND } from '../../../../src/provisioning/replacement-protection-advice.js';

interface Site {
  readonly name: string;
  readonly resourceType: string;
  readonly send: ReturnType<typeof vi.fn>;
  readonly make: () => {
    delete: (
      logicalId: string,
      physicalId: string,
      resourceType: string,
      properties?: Record<string, unknown>,
      context?: Record<string, unknown>
    ) => Promise<unknown>;
  };
  readonly describe: string;
  readonly modify: string;
  readonly del: string;
  readonly listKey: 'DBClusters' | 'DBInstances';
  readonly notFoundFault: string;
  readonly subject: string;
}

const SITES: readonly Site[] = [
  {
    name: 'RDS DBCluster',
    resourceType: 'AWS::RDS::DBCluster',
    send: rdsSend,
    make: () => new RDSProvider(),
    describe: 'DescribeDBClustersCommand',
    modify: 'ModifyDBClusterCommand',
    del: 'DeleteDBClusterCommand',
    listKey: 'DBClusters',
    notFoundFault: 'DBClusterNotFoundFault',
    subject: 'RDS DBCluster',
  },
  {
    name: 'RDS DBInstance',
    resourceType: 'AWS::RDS::DBInstance',
    send: rdsSend,
    make: () => new RDSProvider(),
    describe: 'DescribeDBInstancesCommand',
    modify: 'ModifyDBInstanceCommand',
    del: 'DeleteDBInstanceCommand',
    listKey: 'DBInstances',
    notFoundFault: 'DBInstanceNotFoundFault',
    subject: 'RDS DBInstance',
  },
  {
    name: 'DocDB DBCluster',
    resourceType: 'AWS::DocDB::DBCluster',
    send: docdbSend,
    make: () => new DocDBProvider(),
    describe: 'DescribeDBClustersCommand',
    modify: 'ModifyDBClusterCommand',
    del: 'DeleteDBClusterCommand',
    listKey: 'DBClusters',
    notFoundFault: 'DBClusterNotFoundFault',
    subject: 'DocDB DBCluster',
  },
  {
    name: 'Neptune DBCluster',
    resourceType: 'AWS::Neptune::DBCluster',
    send: neptuneSend,
    make: () => new NeptuneProvider(),
    describe: 'DescribeDBClustersCommand',
    modify: 'ModifyDBClusterCommand',
    del: 'DeleteDBClusterCommand',
    listKey: 'DBClusters',
    notFoundFault: 'DBClusterNotFoundFault',
    subject: 'Neptune DBCluster',
  },
  {
    name: 'Neptune DBInstance',
    resourceType: 'AWS::Neptune::DBInstance',
    send: neptuneSend,
    make: () => new NeptuneProvider(),
    describe: 'DescribeDBInstancesCommand',
    modify: 'ModifyDBInstanceCommand',
    del: 'DeleteDBInstanceCommand',
    listKey: 'DBInstances',
    notFoundFault: 'DBInstanceNotFoundFault',
    subject: 'Neptune DBInstance',
  },
];

/** AWS's refusal for a cluster that still has members: TERMINAL (no retryable pattern). */
function terminalRefusal(): Error {
  const e = new Error(
    'Cluster cannot be deleted, it still contains DB instances in non-deleting state.'
  );
  e.name = 'InvalidDBClusterStateFault';
  return e;
}

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

function notFound(fault: string): Error {
  const e = new Error(`${fault}: not found`);
  e.name = fault;
  return e;
}

interface Script {
  /** The pre-flip readback: the guard value, or an error to throw. */
  observe?: boolean | Error;
  /** The flip-off `Modify*`: resolves unless given an error. */
  disable?: Error;
  /** The `Delete*`: resolves unless given an error. */
  del?: Error;
  /** A readback AFTER an accepted delete (the gone-wait). Default: not found. */
  afterDelete?: Error;
  /** The compensating `Modify*(DeletionProtection: true)`. */
  reEnable?: Error;
}

/** Route every command by name, so a case states only what it changes. */
function script(site: Site, s: Script): void {
  let deleteAccepted = false;
  site.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    if (name === site.describe) {
      if (deleteAccepted) throw s.afterDelete ?? notFound(site.notFoundFault);
      if (s.observe instanceof Error) throw s.observe;
      return { [site.listKey]: [{ DeletionProtection: s.observe ?? false }] };
    }
    if (name === site.modify) {
      if (cmd.input['DeletionProtection'] === false) {
        if (s.disable) throw s.disable;
        return {};
      }
      if (s.reEnable) throw s.reEnable;
      return {};
    }
    if (name === site.del) {
      if (s.del) throw s.del;
      deleteAccepted = true;
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  });
}

function reEnableCalls(site: Site): unknown[] {
  return site.send.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((c) => c.constructor.name === site.modify && c.input['DeletionProtection'] === true);
}

const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };

beforeEach(() => {
  vi.clearAllMocks();
  rdsSend.mockReset();
  docdbSend.mockReset();
  neptuneSend.mockReset();
});

describe.each(SITES)('$name: --remove-protection compensation (issue #2204)', (site) => {
  it('restores a guard this run turned off when the delete fails terminally, re-throwing the ORIGINAL error', async () => {
    script(site, { observe: true, del: terminalRefusal() });
    const provider = site.make();

    const thrown = await provider
      .delete('Res', 'db-1', site.resourceType, undefined, CTX)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    // The delete failure stays the outcome, unannotated.
    expect((thrown as Error).message).toContain('non-deleting state');
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    // The TARGET, not only the shape: each site's `reEnable` is hand-written,
    // and one addressing the wrong identifier would restore nothing.
    const idKey = site.listKey === 'DBClusters' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier';
    expect(reEnables[0]).toMatchObject({
      input: { [idKey]: 'db-1', DeletionProtection: true, ApplyImmediately: true },
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${site.subject} Res: the delete failed after --remove-protection`)
    );
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('re-enabled on db-1'));
  });

  it('NEGATIVE CONTROL: leaves a guard that was already OFF before the run alone', async () => {
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not touch the guard when the pre-flip readback failed ("do not know")', async () => {
    script(site, { observe: new Error('boom'), del: terminalRefusal() });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    // The flip itself still went out: the readback is best-effort.
    const disables = site.send.mock.calls.filter(
      (c) =>
        (c[0] as { constructor: { name: string } }).constructor.name === site.modify &&
        (c[0] as { input: Record<string, unknown> }).input['DeletionProtection'] === false
    );
    expect(disables).toHaveLength(1);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate a flip AWS rejected', async () => {
    script(site, { observe: true, disable: new Error('flip refused'), del: terminalRefusal() });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate once AWS ACCEPTED the delete (a later throw is the wait failing)', async () => {
    script(site, { observe: true, afterDelete: new Error('wait broke') });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('wait broke');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not flip or compensate anything without --remove-protection', async () => {
    script(site, { observe: true, del: terminalRefusal() });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow('non-deleting state');
    expect(
      site.send.mock.calls.filter(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name === site.modify
      )
    ).toHaveLength(0);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    const provider = site.make();
    // Attempt 1: guard observed ON, flipped, throttled -> retryable, no compensation.
    script(site, { observe: true, del: throttle() });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('Rate exceeded');
    expect(reEnableCalls(site)).toHaveLength(0);

    // Attempt 2 (the outer loop's re-entry): the readback now reports OFF --
    // attempt 1 is why -- and the delete fails terminally.
    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(1);
  });

  it('a FAILED re-enable is an ERROR line naming the restore command, and the original error still wins', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `${site.subject} Res: could NOT re-enable DeletionProtection on db-1 .*LIVE.*` +
            `modify-db-${site.listKey === 'DBClusters' ? 'cluster' : 'instance'} .*db-1.*` +
            `--region us-east-1 --deletion-protection --apply-immediately`
        )
      )
    );
  });

  it('a FAILED re-enable keeps the record, so a later delete of the same key retries it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(1);
  });

  it('a RESTORED guard releases the record, so a later delete of the same key does not inherit it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal() });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(1);

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      provider.delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a not-found re-enable is a WARN that names the check first, not an ERROR claiming it is live', async () => {
    script(site, {
      observe: true,
      del: terminalRefusal(),
      reEnable: notFound(site.notFoundFault),
    });
    await expect(
      site.make().delete('Res', 'db-1', site.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `could not re-enable DeletionProtection on db-1 .*answered ${site.notFoundFault}.*` +
            `Check with: aws \\w+ describe-db-`
        )
      )
    );
  });
});

describe('RDS: a cluster and an instance of the same name do not share a flip record', () => {
  it('keys by resource type', async () => {
    const provider = new RDSProvider();
    const cluster = SITES[0]!;
    const instance = SITES[1]!;
    // The cluster's attempt is retryable, so its record is RETAINED latched.
    script(cluster, { observe: true, del: throttle() });
    await expect(
      provider.delete('C', 'db-1', cluster.resourceType, undefined, CTX)
    ).rejects.toThrow('Rate exceeded');

    // The same-named instance observed OFF and failed terminally: it must
    // compensate nothing, where a type-less key would hand it the cluster's latch.
    rdsSend.mockReset();
    script(instance, { observe: false, del: terminalRefusal() });
    await expect(
      provider.delete('I', 'db-1', instance.resourceType, undefined, CTX)
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(instance)).toHaveLength(0);
  });
});

describe('RDS: the flip record is keyed by region', () => {
  it('a retained record in one region is not inherited by the same name in another', async () => {
    const provider = new RDSProvider();
    const cluster = SITES[0]!;
    script(cluster, { observe: true, del: throttle() });
    await expect(
      provider.delete('C', 'db-1', cluster.resourceType, undefined, CTX)
    ).rejects.toThrow('Rate exceeded');

    rdsSend.mockReset();
    script(cluster, { observe: false, del: terminalRefusal() });
    await expect(
      provider.delete('C', 'db-1', cluster.resourceType, undefined, {
        removeProtection: true,
        expectedRegion: 'eu-west-1',
      })
    ).rejects.toThrow('non-deleting state');
    expect(reEnableCalls(cluster)).toHaveLength(0);
  });
});

describe('rdsFamilyProtectionSite', () => {
  it.each([
    ['rds', 'cluster', 'aws rds describe-db-clusters --db-cluster-identifier'],
    ['docdb', 'cluster', 'aws docdb describe-db-clusters --db-cluster-identifier'],
    ['neptune', 'instance', 'aws neptune describe-db-instances --db-instance-identifier'],
  ] as const)('renders the %s %s commands with --region', (cliService, kind, checkPrefix) => {
    const site = rdsFamilyProtectionSite({
      cliService,
      serviceLabel: 'X',
      kind,
      physicalId: 'db-1',
      region: 'eu-west-1',
      notFoundFault: 'F',
      isNotFound: () => false,
    });
    const commands = site.commands();
    expect(commands.check).toBe(`${checkPrefix} db-1 --region eu-west-1`);
    expect(commands.restoreLive).toBe(
      `aws ${cliService} modify-db-${kind} --db-${kind}-identifier db-1 --region eu-west-1 --deletion-protection --apply-immediately`
    );
    expect(commands.restoreAfterNotFound).toBe(commands.restoreLive);
  });

  // A shell-active character withholds them (go-to-k/cdkd#3950).
  it.each([
    ['a space', 'db 1'],
    ['a quote', "db'1"],
  ])('WITHHOLDS every command for a state-borne identifier carrying %s', (_label, id) => {
    const commands = rdsFamilyProtectionSite({
      cliService: 'rds',
      serviceLabel: 'RDS',
      kind: 'cluster',
      physicalId: id,
      region: 'us-east-1',
      notFoundFault: 'F',
      isNotFound: () => false,
    }).commands();
    expect(commands).toEqual({
      check: WITHHELD_AWS_COMMAND,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
  });

  it('WITHHOLDS every command for an identifier that cannot be printed exactly (a newline)', () => {
    const commands = rdsFamilyProtectionSite({
      cliService: 'rds',
      serviceLabel: 'RDS',
      kind: 'cluster',
      physicalId: 'db\n1',
      region: 'us-east-1',
      notFoundFault: 'F',
      isNotFound: () => false,
    }).commands();
    // Withheld, never rendered with the argument dropped: a command missing its
    // identifier addresses something else (#3136).
    expect(commands).toEqual({
      check: WITHHELD_AWS_COMMAND,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
  });

  it('omits --region when the state carries none', () => {
    const site = rdsFamilyProtectionSite({
      cliService: 'rds',
      serviceLabel: 'RDS',
      kind: 'cluster',
      physicalId: 'db-1',
      region: undefined,
      notFoundFault: 'F',
      isNotFound: () => false,
    });
    expect(site.commands().check).toBe('aws rds describe-db-clusters --db-cluster-identifier db-1');
  });
});

describe('deleteWithProtectionCompensation', () => {
  it('a throwing compensation logger neither replaces the delete error nor releases the record', async () => {
    const registry = new ProtectionFlipRegistry();
    const original = terminalRefusal();
    const throwingLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger died');
      }),
      error: vi.fn(() => {
        throw new Error('logger died');
      }),
    };
    const thrown = await deleteWithProtectionCompensation({
      registry,
      key: 'k',
      run: async (flip) => {
        flip.flippedOffByThisRun = true;
        throw original;
      },
      compensation: {
        logicalId: 'Res',
        physicalId: 'db-1',
        logger: throwingLogger as never,
        site: rdsFamilyProtectionSite({
          cliService: 'rds',
          serviceLabel: 'RDS',
          kind: 'cluster',
          physicalId: 'db-1',
          region: undefined,
          notFoundFault: 'F',
          isNotFound: () => false,
        }),
        reEnable: async () => undefined,
      },
    }).catch((e: unknown) => e);
    expect(thrown).toBe(original);
    expect(registry.size).toBe(1);
  });

  it('releases the record on a normal return', async () => {
    const registry = new ProtectionFlipRegistry();
    await deleteWithProtectionCompensation({
      registry,
      key: 'k',
      run: async (flip) => {
        flip.flippedOffByThisRun = true;
      },
      compensation: {
        logicalId: 'Res',
        physicalId: 'db-1',
        logger: childLogger as never,
        site: rdsFamilyProtectionSite({
          cliService: 'rds',
          serviceLabel: 'RDS',
          kind: 'cluster',
          physicalId: 'db-1',
          region: undefined,
          notFoundFault: 'F',
          isNotFound: () => false,
        }),
        reEnable: async () => undefined,
      },
    });
    expect(registry.size).toBe(0);
  });
});
