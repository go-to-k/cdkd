import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3869, the deploy's half of `cdkd diff --verbose`'s replacement
// line: a create-only property whose OLD value (the state record's resolved
// copy) is a name derived from a secret, and which the template no longer
// reads. The diff pass resolves nothing that names it, so only the state
// records can say it is secret-derived. The REAL resolver and diff calculator.
const logLines = vi.hoisted(() => [] as string[]);
// Each line through the sink masker the real logger applies, so a line masked
// only by a bag bound around it reads as printed.
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const capture = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    logLines.push(sink()?.(line) ?? line);
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));
// A changed row asks CloudFormation for the type's create-only properties; a
// refusal falls back to the bundled schema (`UserName` is create-only for an
// access key), so nothing leaves the process.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const SECRET_USER = 'sdin-deploy-secret-user';
const PLAIN_USER = 's-PlainUser-ABC123';

function template(userName: string): CloudFormationTemplate {
  return {
    Resources: {
      SecretUser: { Type: 'AWS::IAM::User', Properties: { UserName: userName } },
      PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
      // The access key moves from the secret-named user to the ordinary one;
      // `UserName` is create-only (the bundled schema snapshot).
      Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
    },
  };
}

function currentState(userName: string): StackState {
  return {
    version: 10,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretUser: {
        physicalId: SECRET_USER,
        resourceType: 'AWS::IAM::User',
        properties: { UserName: userName },
        attributes: {},
        dependencies: [],
      },
      PlainUser: {
        physicalId: PLAIN_USER,
        resourceType: 'AWS::IAM::User',
        properties: {},
        attributes: {},
        dependencies: [],
      },
      Key: {
        physicalId: 'sdin-access-key-id-1',
        resourceType: 'AWS::IAM::AccessKey',
        properties: { UserName: SECRET_USER },
        attributes: {},
        dependencies: ['SecretUser'],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function harness(state: StackState) {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'sdin-access-key-id-2' }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState: vi.fn().mockResolvedValue('etag'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['SecretUser', 'PlainUser'], ['Key']]),
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
    { dryRun: true, forceStatefulRecreation: true },
    'us-east-1'
  );
  return { engine };
}

beforeEach(() => {
  logLines.length = 0;
});

describe("cdkd deploy's replacement line masks a name only the OLD state value holds (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])('%s', async (_l, userName, shown) => {
    const h = harness(currentState(userName));
    await h.engine.deploy('s', template(userName));
    const line = logLines.filter((l) => l.includes('requires replacement (from')).join('\n');
    // Premise: the replacement line printed, its new side in the clear.
    expect(line).toContain('Property UserName of AWS::IAM::AccessKey');
    expect(line).toContain(PLAIN_USER);
    expect(line.includes(SECRET_USER)).toBe(shown);
  });
});
