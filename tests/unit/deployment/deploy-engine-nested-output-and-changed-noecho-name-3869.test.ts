import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3869, items 2 and 3, at the deploy engine's printing sites.
//
// Item 2: a parent resource reads a nested child's output holding the name of
// a child resource NAMED from a secret (one the child's provider rewrote or
// case-folded, which no recorded plaintext spells). The row's record names
// that output in `secretNamedAttributes`; on a later deploy the row is
// NO_CHANGE (its provider never runs), so only the persisted field says so.
//
// Item 3: a pre-v11 record holds a name minted from a `NoEcho` value since
// CHANGED, or from a short value under the needle floor. The replacement's
// `Deleting old <id> (<old id>)` line prints the old id.
const logLines = vi.hoisted(() => [] as string[]);
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
// refusal falls back to the bundled schema, so nothing leaves the process.
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
import { getLogger } from '../../../src/utils/logger.js';

function harness(
  state: StackState,
  levels: string[][],
  parameters: Record<string, string> = {},
  create: (logicalId: string) => unknown = () => ({ physicalId: 'new-physical-id', attributes: {} }),
  extra: {
    update?: (logicalId: string, physicalId: string) => unknown;
    dryRun?: boolean;
    import?: (input: { knownPhysicalId?: string }) => unknown;
  } = {}
) {
  const saveState = vi.fn().mockResolvedValue('etag');
  const provider = {
    create: vi.fn(async (logicalId: string) => create(logicalId)),
    update: vi.fn(async (logicalId: string, physicalId: string) =>
      extra.update ? extra.update(logicalId, physicalId) : { physicalId, wasReplaced: false }
    ),
    delete: vi.fn(() => undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    ...(extra.import && { import: vi.fn(async (input: { knownPhysicalId?: string }) => extra.import!(input)) }),
  };
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
      getExecutionLevels: vi.fn(() => levels),
      // Each level waits for the one before it.
      getDirectDependencies: vi.fn((_dag: unknown, id: string) => {
        const at = levels.findIndex((level) => level.includes(id));
        return at > 0 ? levels[at - 1]! : [];
      }),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: extra.dryRun ?? false, forceStatefulRecreation: true, parameters },
    'us-east-1'
  );
  return { engine, provider, saveState };
}

beforeEach(() => {
  logLines.length = 0;
});

describe("a parent reader of a nested child's secret-named output, the row NO_CHANGE (go-to-k/cdkd#3869)", () => {
  // The child's role was named from a secret; its provider prefixed and
  // folded the name, so the output holds a spelling no plaintext matches.
  const ROLE_NAME = 'ChildStack-Team-Secret-Role-a1b2';
  const CHILD_ARN = 'arn:aws:cloudformation:us-east-1:123456789012:stack/P-Child/cdkd';

  function state(secretNamed: boolean): StackState {
    return {
      version: 12,
      stackName: 'P',
      region: 'us-east-1',
      resources: {
        Child: {
          physicalId: CHILD_ARN,
          resourceType: 'AWS::CloudFormation::Stack',
          properties: { TemplateURL: 'https://example.com/child.json' },
          attributes: { 'Outputs.RoleName': ROLE_NAME, 'Outputs.Plain': 'plain-output-value' },
          ...(secretNamed && { secretNamedAttributes: ['Outputs.RoleName'] }),
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-param',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Type: 'String', Value: 'previous-value' },
          attributes: {},
          dependencies: ['Child'],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
  }

  const template: CloudFormationTemplate = {
    Resources: {
      Child: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'https://example.com/child.json' },
      },
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Type: 'String',
          Value: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Child', 'Outputs.RoleName'] }, ':x']] },
        },
      },
    },
  };

  it.each([
    ['the row names the output', true],
    ['negative control, a record without the field (an older cdkd)', false],
  ])('%s', async (_l, secretNamed) => {
    const h = harness(state(secretNamed), [['Child'], ['Reader']]);
    await h.engine.deploy('P', template);
    // Premise: only the reader was provisioned (the row is NO_CHANGE), and
    // the resolver printed what it read.
    expect(h.provider.update.mock.calls.map((call) => call[0])).toEqual(['Reader']);
    const all = logLines.join('\n');
    expect(all).toContain('Resolved Fn::GetAtt');
    expect(all).toContain('Child');
    expect(all.includes(ROLE_NAME)).toBe(!secretNamed);
  });

  it.each([
    ['the provider names the output', ['Outputs.RoleName'], true],
    ['negative control, it names none', [], false],
  ])(
    'the FIRST deploy records the field before the reader resolves, and persists it: %s',
    async (_l, names, masked) => {
      const empty = { ...state(false), resources: {} } as StackState;
      const h = harness(empty, [['Child'], ['Reader']], {}, (logicalId) =>
        logicalId === 'Child'
          ? {
              physicalId: CHILD_ARN,
              attributes: { 'Outputs.RoleName': ROLE_NAME, 'Outputs.Plain': 'plain-output-value' },
              secretNamedAttributeNames: names,
            }
          : { physicalId: 'reader-param', attributes: {} }
      );
      await h.engine.deploy('P', template);
      const all = logLines.join('\n');
      expect(all).toContain('Resolved Fn::GetAtt');
      expect(all.includes(ROLE_NAME)).toBe(!masked);
      const saved = h.saveState.mock.calls.at(-1)?.[2] as StackState;
      expect(saved.resources['Child']?.secretNamedAttributes).toEqual(
        masked ? ['Outputs.RoleName'] : undefined
      );
    }
  );
});

describe("an in-place update of the row rewrites or carries secretNamedAttributes (go-to-k/cdkd#3869)", () => {
  const CHILD_ARN = 'arn:aws:cloudformation:us-east-1:123456789012:stack/P-Child/cdkd';
  const state = (): StackState =>
    ({
      version: 12,
      stackName: 'P',
      region: 'us-east-1',
      resources: {
        Child: {
          physicalId: CHILD_ARN,
          resourceType: 'AWS::CloudFormation::Stack',
          properties: { TemplateURL: 'https://example.com/old.json' },
          attributes: { 'Outputs.RoleName': 'old-role-name' },
          secretNamedAttributes: ['Outputs.RoleName'],
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;
  const template: CloudFormationTemplate = {
    Resources: {
      Child: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'https://example.com/new.json' },
      },
    },
  };

  it.each([
    [
      'fresh attributes naming none drop the field',
      { attributes: { 'Outputs.RoleName': 'plain-role' }, secretNamedAttributeNames: [] },
      undefined,
    ],
    [
      'fresh attributes rewrite it',
      {
        attributes: { 'Outputs.Other': 'x', 'Outputs.RoleName': 'y' },
        secretNamedAttributeNames: ['Outputs.Other'],
      },
      ['Outputs.Other'],
    ],
    ['carried attributes keep the previous names', {}, ['Outputs.RoleName']],
  ])('%s', async (_l, result, expected) => {
    const h = harness(state(), [['Child']], {}, undefined, {
      update: (_id, physicalId) => ({ physicalId, wasReplaced: false, ...result }),
    });
    await h.engine.deploy('P', template);
    expect(h.provider.update.mock.calls.map((call) => call[0])).toEqual(['Child']);
    const saved = h.saveState.mock.calls.at(-1)?.[2] as StackState;
    expect(saved.resources['Child']?.secretNamedAttributes).toEqual(expected);
  });
});

describe("the deploy's diff pass judges a record named from a NoEcho value since CHANGED (go-to-k/cdkd#3869)", () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("masks a reader's stored copy on the replacement line's old side: %s", async (_l, noEcho, shown) => {
    // The key moves from the user named from the old value (RDS-folded) to an
    // ordinary one; `UserName` is create-only, so the line prints both sides.
    const state = {
      version: 10,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId: 'teamolddb1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'TeamOldDb1' },
          attributes: {},
          dependencies: [],
        },
        PlainUser: {
          physicalId: 's-PlainUser-ABC123',
          resourceType: 'AWS::IAM::User',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        Key: {
          physicalId: 'access-key-1',
          resourceType: 'AWS::IAM::AccessKey',
          properties: { UserName: 'teamolddb1' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const h = harness(state, [['Db', 'PlainUser'], ['Key']], { DbName: 'TeamNewDb2' }, undefined, {
      dryRun: true,
    });
    await h.engine.deploy('s', {
      Parameters: { DbName: { Type: 'String', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: { Ref: 'DbName' } } },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
      },
    } as CloudFormationTemplate);
    const line = logLines.filter((l) => l.includes('Property UserName of AWS::IAM::AccessKey')).join('\n');
    expect(line).toContain('s-PlainUser-ABC123');
    expect(line.includes('teamolddb1')).toBe(shown);
  });
});

describe('a replacement deleting a record named from a NoEcho value since CHANGED (go-to-k/cdkd#3869)', () => {
  it.each([
    // RDS folds the identifier; the record holds value A, the deploy binds B.
    [
      'a changed value',
      'Db',
      'AWS::RDS::DBInstance',
      { DbIdParam: { Type: 'String', NoEcho: true } },
      { DBInstanceIdentifier: { Ref: 'DbIdParam' } },
      { DBInstanceIdentifier: 'OldSecretDb1' },
      'oldsecretdb1',
      { DbIdParam: 'NewSecretDb2' },
      true,
    ],
    // A short value, changed: the whole leaf is judged, and RDS folds it (the
    // record's own leaf as written would not match the lower-cased id).
    [
      'a short value embedded in a folded name',
      'Db',
      'AWS::RDS::DBInstance',
      { Short: { Type: 'String', NoEcho: true } },
      { DBInstanceIdentifier: { 'Fn::Sub': 'TeamDb${Short}' } },
      { DBInstanceIdentifier: 'TeamDb41' },
      'teamdb41',
      { Short: '42' },
      true,
    ],
    [
      'negative control, an ordinary parameter',
      'Db',
      'AWS::RDS::DBInstance',
      { DbIdParam: { Type: 'String' } },
      { DBInstanceIdentifier: { Ref: 'DbIdParam' } },
      { DBInstanceIdentifier: 'OldSecretDb1' },
      'oldsecretdb1',
      { DbIdParam: 'NewSecretDb2' },
      false,
    ],
  ])(
    '%s',
    async (_l, logicalId, resourceType, parameters, templateProps, recordProps, oldId, values, masked) => {
      const state = {
        version: 10,
        stackName: 's',
        region: 'us-east-1',
        resources: {
          [logicalId]: {
            physicalId: oldId,
            resourceType,
            properties: recordProps,
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      } as StackState;
      const h = harness(state, [[logicalId]], values);
      await h.engine.deploy('s', {
        Parameters: parameters,
        Resources: { [logicalId]: { Type: resourceType, Properties: templateProps } },
      } as CloudFormationTemplate);
      const all = logLines.join('\n');
      // Premise: the replacement ran and named the old resource.
      expect(all).toContain(`Deleting old ${logicalId} (`);
      expect(all.includes(oldId)).toBe(!masked);
    }
  );
});

describe('a replacement records the new resource\'s secretNamedAttributes from its create result (go-to-k/cdkd#3869)', () => {
  // The field is generic over the result: whichever provider reports it.
  const state = (): StackState =>
    ({
      version: 12,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId: 'olddb',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'OldDb' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;

  it.each([
    ['the create names one', ['Endpoint.Address'], ['Endpoint.Address']],
    ['negative control, it names none', [], undefined],
  ])('a create-only change (update-replace): %s', async (_l, names, expected) => {
    const h = harness(state(), [['Db']], {}, () => ({
      physicalId: 'newdb',
      attributes: { 'Endpoint.Address': 'x' },
      secretNamedAttributeNames: names,
    }));
    await h.engine.deploy('s', {
      Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'NewDb' } } },
    } as CloudFormationTemplate);
    // Premise: the replacement's create ran, not an update.
    expect(h.provider.create).toHaveBeenCalled();
    expect(h.provider.update).not.toHaveBeenCalled();
    const saved = h.saveState.mock.calls.at(-1)?.[2] as StackState;
    expect(saved.resources['Db']?.physicalId).toBe('newdb');
    expect(saved.resources['Db']?.secretNamedAttributes).toEqual(expected);
  });

  it.each([
    ['the create names one', ['Endpoint.Address'], ['Endpoint.Address']],
    ['negative control, it names none', [], undefined],
  ])('the update-unsupported fallback (update-in-place): %s', async (_l, names, expected) => {
    const h = harness(
      state(),
      [['Db']],
      {},
      () => ({ physicalId: 'newdb', attributes: { 'Endpoint.Address': 'x' }, secretNamedAttributeNames: names }),
      {
        update: () => {
          // Cloud Control's refusal of an UPDATE, by exception name.
          throw Object.assign(new Error('Resource type does not support UPDATE action'), {
            name: 'UnsupportedActionException',
          });
        },
      }
    );
    await h.engine.deploy('s', {
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'OldDb', Port: '5433' } },
      },
    } as CloudFormationTemplate);
    // Premise: the update was refused and the fallback created the new one.
    expect(h.provider.update).toHaveBeenCalled();
    expect(h.provider.create).toHaveBeenCalled();
    const saved = h.saveState.mock.calls.at(-1)?.[2] as StackState;
    expect(saved.resources['Db']?.physicalId).toBe('newdb');
    expect(saved.resources['Db']?.secretNamedAttributes).toEqual(expected);
  });
});

describe("a nested row's registry judges the records with what each stored at a NoEcho position (go-to-k/cdkd#3869)", () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("masks a CHANGED value's old name on a line the row's child prints: %s", async (_l, noEcho, shown) => {
    const CHILD_ARN = 'arn:aws:cloudformation:us-east-1:123456789012:stack/s-Child/cdkd';
    const state = {
      version: 10,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Child: {
          physicalId: CHILD_ARN,
          resourceType: 'AWS::CloudFormation::Stack',
          properties: { TemplateURL: 'https://example.com/old.json' },
          attributes: {},
          dependencies: [],
        },
        Db: {
          physicalId: 'teamolddb1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'TeamOldDb1' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const h = harness(state, [['Child'], ['Db']], { DbName: 'TeamNewDb2' }, undefined, {
      update: (logicalId, physicalId) => {
        // The child's own stored value, printed inside the row's update.
        if (logicalId === 'Child') getLogger().info('child: requires replacement (from teamolddb1)');
        return { physicalId, wasReplaced: false };
      },
    });
    await h.engine.deploy('s', {
      Parameters: { DbName: { Type: 'String', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'https://example.com/new.json' } },
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: { Ref: 'DbName' } } },
      },
    } as CloudFormationTemplate);
    const line = logLines.filter((l) => l.startsWith('child: requires replacement')).join('\n');
    // Premise: the row's update ran and printed.
    expect(line).not.toBe('');
    expect(line.includes('teamolddb1')).toBe(shown);
  });
});

describe("the deploy's heal judges with the deploy's per-record NoEcho bags (go-to-k/cdkd#3869)", () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])('masks a name minted from a short NoEcho value on the heal\'s provider line: %s', async (_l, noEcho, shown) => {
    // `41` is under the needle floor, so only the record's own leaf at the
    // NoEcho position (`TeamDb41`, RDS-folded) judges the name.
    const state = {
      version: 10,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId: 'teamdb41',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'TeamDb41' },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-param',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Type: 'String', Value: 'previous-value' },
          attributes: {},
          dependencies: ['Db'],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const h = harness(state, [['Db'], ['Reader']], { Short: '41' }, undefined, {
      import: (input) => {
        getLogger().debug(`Describing DB instance ${input.knownPhysicalId}`);
        return { physicalId: input.knownPhysicalId!, attributes: { 'Endpoint.Address': 'db.example.com' } };
      },
    });
    await h.engine.deploy('s', {
      Parameters: { Short: { Type: 'String', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: { 'Fn::Sub': 'TeamDb${Short}' } } },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
        },
      },
    } as CloudFormationTemplate);
    const line = logLines.filter((l) => l.startsWith('Describing DB instance')).join('\n');
    // Premise: the heal's read ran.
    expect(line).not.toBe('');
    expect(line.includes('teamdb41')).toBe(shown);
  });
});
