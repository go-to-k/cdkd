import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, debug, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: rds:X';
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const SG = { DBSubnetGroupName: 'sg-1', DBSubnetGroupDescription: 'd', SubnetIds: ['a', 'b'] };
const CLUSTER = { DBClusterIdentifier: 'db-1', BackupRetentionPeriod: 7 };
const INSTANCE = { DBInstanceIdentifier: 'in-1', DBInstanceClass: 'db.r5.large' };

const cases: Array<{ wrap: string; run: (p: NeptuneProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create Neptune DBSubnetGroup Sg',
    run: (p) => p.create('Sg', 'AWS::Neptune::DBSubnetGroup', SG, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update Neptune DBSubnetGroup Sg',
    run: (p) =>
      p.update('Sg', 'sg-1', 'AWS::Neptune::DBSubnetGroup', SG, SG, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to delete Neptune DBSubnetGroup Sg',
    run: (p) =>
      p.delete('Sg', 'sg-1', 'AWS::Neptune::DBSubnetGroup', undefined, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to create Neptune DBCluster Db',
    run: (p) => p.create('Db', 'AWS::Neptune::DBCluster', CLUSTER, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update Neptune DBCluster Db',
    run: (p) =>
      p.update(
        'Db',
        'db-1',
        'AWS::Neptune::DBCluster',
        CLUSTER,
        { ...CLUSTER, BackupRetentionPeriod: 1 },
        { maskSecrets: mask }
      ),
  },
  {
    wrap: 'Failed to delete Neptune DBCluster Db',
    run: (p) => p.delete('Db', 'db-1', 'AWS::Neptune::DBCluster', {}, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to create Neptune DBInstance In',
    run: (p) => p.create('In', 'AWS::Neptune::DBInstance', INSTANCE, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update Neptune DBInstance In',
    run: (p) =>
      p.update(
        'In',
        'in-1',
        'AWS::Neptune::DBInstance',
        INSTANCE,
        { ...INSTANCE, DBInstanceClass: 'db.r5.xlarge' },
        { maskSecrets: mask }
      ),
  },
  {
    wrap: 'Failed to delete Neptune DBInstance In',
    run: (p) => p.delete('In', 'in-1', 'AWS::Neptune::DBInstance', {}, { maskSecrets: mask }),
  },
];

describe('NeptuneProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: NeptuneProvider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new NeptuneProvider();
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    mockSend.mockRejectedValue(denied());

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('111122223333');
    expect(failure.message).not.toContain('not authorized');
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    mockSend.mockRejectedValue('raw s3cr3t value');

    const failure = await caught(provider.delete('Sg', 'sg-1', 'AWS::Neptune::DBSubnetGroup'));

    expect(failure.message).toBe(
      `Failed to delete Neptune DBSubnetGroup Sg: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('restates an "already exists" from CreateDBCluster', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('DB Cluster already exists'), {
        name: 'DBClusterAlreadyExistsFault',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.create('Db', 'AWS::Neptune::DBCluster', CLUSTER));

    expect(failure.message).toBe(
      `Failed to create Neptune DBCluster Db: DBClusterAlreadyExistsFault. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  it('restates an "already exists" from CreateDBSubnetGroup', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('DB subnet group already exists'), {
        name: 'DBSubnetGroupAlreadyExistsFault',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.create('Sg', 'AWS::Neptune::DBSubnetGroup', SG));

    expect(failure.message).toBe(
      `Failed to create Neptune DBSubnetGroup Sg: DBSubnetGroupAlreadyExistsFault. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('DB subnet group already exists');
  });

  // A transport error the SDK retried carries `$metadata` with only the retry
  // counters (no `$fault`, no `httpStatusCode`): cdkd-side text, kept and masked.
  it('a retried transport error keeps its text, masked', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('socket hang up near s3cr3t'), {
        name: 'TimeoutError',
        $metadata: { attempts: 3, totalRetryDelay: 120 },
      })
    );

    const failure = await caught(
      provider.create('Sg', 'AWS::Neptune::DBSubnetGroup', SG, { maskSecrets: mask })
    );

    expect(failure.message).toBe(
      `Failed to create Neptune DBSubnetGroup Sg: socket hang up near ***`
    );
    expect(failure.message).not.toContain('TimeoutError');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    expect(failure.message).not.toContain('s3cr3t');
  });

  // The #5161 leak shape: a failure AFTER the create returned (a denied status
  // read while waiting for `available`) must still reach the wrap, mark intact.
  it.each([
    {
      type: 'AWS::Neptune::DBCluster',
      create: 'CreateDBClusterCommand',
      created: { DBCluster: { DBClusterIdentifier: 'db-1', DbClusterResourceId: 'cluster-R' } },
      props: CLUSTER,
      wrap: 'Failed to create Neptune DBCluster Db',
      id: 'db-1',
    },
    {
      type: 'AWS::Neptune::DBInstance',
      create: 'CreateDBInstanceCommand',
      created: { DBInstance: { DBInstanceIdentifier: 'in-1', DbiResourceId: 'db-R' } },
      props: INSTANCE,
      wrap: 'Failed to create Neptune DBInstance Db',
      id: 'in-1',
    },
  ])('$type: a denied settle read after the create is withheld', async (c) => {
    delete process.env['CDKD_NO_WAIT'];
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === c.create) return c.created;
      throw denied();
    });

    const failure = await caught(provider.create('Db', c.type, c.props, { maskSecrets: mask }));

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Db', c.type)).toBe(c.id);
    const warns = warn.mock.calls.map((w) => String(w[0]));
    expect([...warns, ...debugLines()].join('\n')).not.toContain('s3cr3t');
  });
});
