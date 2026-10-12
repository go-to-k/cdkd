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
import {
  secretNamedRecordNeedles,
  secretNamesStoredIn,
  storedSecretNameNeedles,
} from '../../../src/deployment/secret-name-needles.js';
import { getLogger } from '../../../src/utils/logger.js';
import {
  hasMaskableValues,
  maskSecretsInText,
  recordLogOnlyValue,
} from '../../../src/deployment/secret-redaction.js';
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

function harness(
  state: StackState,
  parameters: Record<string, string> = {},
  extra: {
    dryRun?: boolean;
    levels?: string[][];
    update?: () => unknown;
    delete?: (...args: unknown[]) => unknown;
    beforeDag?: () => void;
    options?: Record<string, unknown>;
  } = {}
) {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'sdin-access-key-id-2' }),
    update: vi.fn(extra.update),
    delete: vi.fn(extra.delete ?? (() => undefined)),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    // The orphan-adoption pre-pass confirms a kept record still exists.
    import: vi.fn(async () => ({ physicalId: SECRET_USER })),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState: vi.fn().mockResolvedValue('etag'),
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
      getExecutionLevels: vi.fn(() => {
        extra.beforeDag?.();
        return extra.levels ?? [['SecretUser', 'PlainUser'], ['Key']];
      }),
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
    {
      dryRun: extra.dryRun ?? true,
      forceStatefulRecreation: true,
      parameters,
      ...extra.options,
    },
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

  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])(
    "masks the OLD id on a real replacement's delete line: %s",
    async (_l, userName, shown) => {
      // Not a dry run: the key IS replaced, and its old id embeds the old
      // user's name (an id like a metric filter's `<LogGroupName>|<name>`).
      const state = currentState(userName);
      state.resources['Key']!.physicalId = `${SECRET_USER}|key-1`;
      const h = harness(state, {}, { dryRun: false });
      await h.engine.deploy('s', template(userName));
      const all = logLines.join('\n');
      // Premise: the replacement ran and named the old resource.
      expect(all).toContain('Deleting old Key (');
      expect(all.includes(SECRET_USER)).toBe(shown);
    }
  );

  it.each([
    ['the parent passed it from a NoEcho source', true],
    ['negative control, an ordinary parent value', false],
  ])(
    "judges a nested child's record named from a parent-passed NoEcho value: %s",
    async (_l, inheritedNoEcho) => {
      // A nested child's parameter never says NoEcho; only the parent's bag
      // knows the value. A pre-v11 child record stores it in plaintext, and
      // RDS lower-cases the identifier the key's old side holds.
      const inherited = new Map<string, string>();
      if (inheritedNoEcho) recordLogOnlyValue(inherited, 'TeamSecretDb');
      const state = currentState(SECRET_USER);
      delete state.resources['SecretUser'];
      state.resources['SecretDb'] = {
        physicalId: 'teamsecretdb',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: 'TeamSecretDb' },
        attributes: {},
        dependencies: [],
      };
      (state.resources['Key']!.properties as Record<string, unknown>)['UserName'] = 'teamsecretdb';
      const h = harness(state, { DbName: 'TeamSecretDb' }, {
        options: {
          ...(inheritedNoEcho && { inheritedSecrets: inherited }),
          parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
        },
      });
      await h.engine.deploy('s', {
        Parameters: { DbName: { Type: 'String' } },
        Resources: {
          SecretDb: {
            Type: 'AWS::RDS::DBInstance',
            Properties: { DBInstanceIdentifier: { Ref: 'DbName' } },
          },
          PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
          Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
        },
      });
      const line = logLines.filter((l) => l.includes('requires replacement (from')).join('\n');
      expect(line).toContain('Property UserName of AWS::IAM::AccessKey');
      expect(line).toContain(PLAIN_USER);
      expect(line.includes('teamsecretdb')).toBe(!inheritedNoEcho);
    }
  );

  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])('judges a record the orphan adoption splices in too: %s', async (_l, userName, shown) => {
    // The secret-named user is a rollback orphan this deploy re-adopts before
    // its diff (adoption takes only a record the template no longer names), so
    // only the adopted record says the key's stored value is its name.
    const state = currentState(userName);
    const adopted = state.resources['SecretUser']!;
    delete state.resources['SecretUser'];
    state.orphans = [{ logicalId: 'SecretUser', orphanedAt: 1, state: adopted }];
    const h = harness(state);
    const tpl = template(userName);
    tpl.Resources['SecretUser']!.Properties = {};
    await h.engine.deploy('s', tpl);
    const line = logLines.filter((l) => l.includes('requires replacement (from')).join('\n');
    // Premise: the record was adopted (its row is no CREATE) and the line printed.
    expect(logLines.join('\n')).not.toContain('CREATE: SecretUser');
    expect(line).toContain('Property UserName of AWS::IAM::AccessKey');
    expect(line).toContain(PLAIN_USER);
    expect(line.includes(SECRET_USER)).toBe(shown);
  });

  it.each([
    ['the NoEcho values judge it', true],
    ['negative control, a non-NoEcho parameter', false],
  ])('judges a record holding a NoEcho value in plaintext: %s', async (_l, noEcho) => {
    // A pre-v11 record stores the NoEcho value itself, and RDS lower-cases the
    // identifier, so the old side is no substring of the value the masker
    // holds; only the judged record's spellings cover it.
    const state = currentState(SECRET_USER);
    delete state.resources['SecretUser'];
    state.resources['SecretDb'] = {
      physicalId: 'teamsecretdb',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { DBInstanceIdentifier: 'TeamSecretDb' },
      attributes: {},
      dependencies: [],
    };
    (state.resources['Key']!.properties as Record<string, unknown>)['UserName'] = 'teamsecretdb';
    const h = harness(state, { DbName: 'TeamSecretDb' });
    await h.engine.deploy('s', {
      Parameters: { DbName: { Type: 'String', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        SecretDb: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { DBInstanceIdentifier: { Ref: 'DbName' } },
        },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
      },
    });
    const line = logLines.filter((l) => l.includes('requires replacement (from')).join('\n');
    expect(line).toContain('Property UserName of AWS::IAM::AccessKey');
    expect(line).toContain(PLAIN_USER);
    expect(line.includes('teamsecretdb')).toBe(!noEcho);
  });
});

describe("the ServiceToken refusal's masker judges the state records too (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named function', '{{resolve:secretsmanager:sdin:SecretString:fn::}}', false],
    ['negative control, an ordinary name', 'sdin-deploy-secret-fn', true],
  ])('%s', async (_l, functionName, shown) => {
    // The refusal prints the DESIRED token. Here the template spells it as a
    // literal ARN of a function named from a secret, which another record
    // stores: nothing this diff resolves reads that function.
    const secretArn = 'arn:aws:lambda:us-east-1:123456789012:function:sdin-deploy-secret-fn';
    const state = {
      version: 10,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Handler: {
          physicalId: 'sdin-deploy-secret-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { FunctionName: functionName },
          attributes: { Arn: secretArn },
          dependencies: [],
        },
        Holder: {
          physicalId: 'holder',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: secretArn },
          attributes: {},
          dependencies: [],
        },
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:plain-old' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const h = harness(state);
    const error = await h.engine
      .deploy('s', {
        Resources: {
          Handler: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: functionName } },
          Holder: { Type: 'AWS::SSM::Parameter', Properties: { Value: secretArn } },
          Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: secretArn } },
        },
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    const message = error instanceof Error ? error.message : String(error);
    // Premise: the refusal fired, naming the row.
    expect(message).toContain("a custom resource's ServiceToken changes");
    expect(message).toContain('Cr: ServiceToken changes to');
    expect(message.includes('sdin-deploy-secret-fn')).toBe(shown);
  });
});

describe("the deploy's judge takes a NoEcho value whole (go-to-k/cdkd#3869)", () => {
  it("never judges a record by a NoEcho value's Fn::Split piece", async () => {
    // Judged by the piece `AlphaQ`, the ordinary queue's lower-cased spelling
    // would become a needle and mask the key's stored copy of it.
    const state = currentState(SECRET_USER);
    delete state.resources['SecretUser'];
    state.resources['Queue'] = {
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/AlphaQ',
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'AlphaQ' },
      attributes: {},
      dependencies: [],
    };
    (state.resources['Key']!.properties as Record<string, unknown>)['UserName'] =
      'alphaq-lowercased-copy';
    const h = harness(state, { Tok: 'AlphaQ-beta' }, { levels: [['Queue', 'PlainUser'], ['Key']] });
    await h.engine.deploy('s', {
      Parameters: { Tok: { Type: 'String', NoEcho: true } },
      Resources: {
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: 'AlphaQ',
            Tags: [{ Key: 't', Value: { 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'Tok' }] }] } }],
          },
        },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
      },
    });
    const line = logLines.filter((l) => l.includes('requires replacement (from')).join('\n');
    expect(line).toContain('Property UserName of AWS::IAM::AccessKey');
    expect(line).toContain('alphaq-lowercased-copy');
  });
});

describe("a nested stack row's child masks a name the parent's records hold (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])('%s', async (_l, userName, shown) => {
    // The row's provider runs the child engine, whose stored values can hold a
    // name the row used to pass; a line it logs (the child's replacement line)
    // prints under the row's bound registry. The provider stands in for it.
    const state = currentState(userName);
    delete state.resources['Key'];
    state.resources['Child'] = {
      physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/s-Child/1',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: { Mode: 'a' } },
      attributes: {},
      dependencies: [],
    };
    const h = harness(state, {}, {
      dryRun: false,
      levels: [['SecretUser', 'PlainUser'], ['Child']],
      update: () => {
        getLogger().debug(`child: requires replacement (from "${SECRET_USER}" to "x")`);
        return { physicalId: state.resources['Child']!.physicalId, attributes: {} };
      },
    });
    await h.engine.deploy('s', {
      Resources: {
        SecretUser: { Type: 'AWS::IAM::User', Properties: { UserName: userName } },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Mode: 'b' } },
        },
      },
    });
    const line = logLines.filter((l) => l.startsWith('child: ')).join('\n');
    // Premise: the row's provider ran, inside the row's body.
    expect(line).toContain('requires replacement (from');
    expect(line.includes(SECRET_USER)).toBe(shown);
  });
});

describe("a DELETE row masks a name a record replaced earlier in the run held (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])('%s', async (_l, userName, shown) => {
    // The key leaves the template; its record still holds the old user's
    // name, which no LIVE record spells once that user was replaced earlier in
    // the run (simulated once the plan is made). Its delete line prints it.
    const state = currentState(userName);
    const h = harness(state, {}, {
      dryRun: false,
      levels: [['Key']],
      beforeDag: () => {
        // A replacement re-points the record to the new resource.
        state.resources['SecretUser']!.physicalId = 'replacement-user';
      },
      delete: () => {
        // Premise: the live record no longer carries the old id.
        expect(state.resources['SecretUser']?.physicalId).toBe('replacement-user');
        getLogger().debug(`delete: access key of ${SECRET_USER}`);
      },
    });
    const tpl = template(userName);
    delete tpl.Resources['Key'];
    await h.engine.deploy('s', tpl);
    const line = logLines.filter((l) => l.startsWith('delete: ')).join('\n');
    expect(line).toContain('delete: access key of');
    expect(line.includes(SECRET_USER)).toBe(shown);
  });
});

describe("a nested row judges the parent's NoEcho-named records (go-to-k/cdkd#3869)", () => {
  it.each([
    ['the parent NoEcho values judge it', true],
    ['negative control, a non-NoEcho parameter', false],
  ])('%s', async (_l, noEcho) => {
    // A pre-v11 parent record stores the NoEcho value itself, and RDS
    // lower-cases the identifier a child line prints.
    const state = currentState(SECRET_USER);
    delete state.resources['Key'];
    delete state.resources['SecretUser'];
    state.resources['SecretDb'] = {
      physicalId: 'teamsecretdb',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { DBInstanceIdentifier: 'TeamSecretDb' },
      attributes: {},
      dependencies: [],
    };
    state.resources['Child'] = {
      physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/s-Child/1',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: { Mode: 'a' } },
      attributes: {},
      dependencies: [],
    };
    const h = harness(state, { DbName: 'TeamSecretDb' }, {
      dryRun: false,
      levels: [['Child']],
      update: () => {
        getLogger().debug('child: requires replacement (from "teamsecretdb" to "x")');
        return { physicalId: state.resources['Child']!.physicalId, attributes: {} };
      },
    });
    await h.engine.deploy('s', {
      Parameters: { DbName: { Type: 'String', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        SecretDb: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { DBInstanceIdentifier: { Ref: 'DbName' } },
        },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Mode: 'b' } },
        },
      },
    });
    const line = logLines.filter((l) => l.startsWith('child: ')).join('\n');
    expect(line).toContain('requires replacement (from');
    expect(line.includes('teamsecretdb')).toBe(!noEcho);
  });
});

describe("a nested row masks a name a parent record replaced earlier in the run held (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
    ['negative control, an ordinary name', SECRET_USER, true],
  ])('%s', async (_l, userName, shown) => {
    // A parent record replaced before the nested row runs re-points to its new
    // id: only the records as the deploy FOUND them still spell the old name.
    // The re-point is simulated once the plan is made, as a replacement's is.
    const state = currentState(userName);
    delete state.resources['Key'];
    state.resources['Child'] = {
      physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/s-Child/1',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: { Mode: 'a' } },
      attributes: {},
      dependencies: [],
    };
    const h = harness(state, {}, {
      dryRun: false,
      levels: [['Child']],
      beforeDag: () => {
        delete state.resources['SecretUser'];
      },
      update: () => {
        // Premise: no parent record spells the old name any more.
        expect(JSON.stringify(state.resources)).not.toContain(SECRET_USER);
        getLogger().debug(`child: requires replacement (from "${SECRET_USER}" to "x")`);
        return { physicalId: state.resources['Child']!.physicalId, attributes: {} };
      },
    });
    await h.engine.deploy('s', {
      Resources: {
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Mode: 'b' } },
        },
      },
    });
    const line = logLines.filter((l) => l.startsWith('child: ')).join('\n');
    expect(line).toContain('requires replacement (from');
    expect(line.includes(SECRET_USER)).toBe(shown);
  });
});

describe('storedSecretNameNeedles: the names a STORED value holds (go-to-k/cdkd#3869)', () => {
  const REF = '{{resolve:secretsmanager:sdin:SecretString:filter::}}';
  const records = (readerValue: string): StackState['resources'] => ({
    // A metric filter named from the secret: its composite id carries its log
    // group's ordinary name, which the judge takes as a name segment.
    SecretFilter: {
      physicalId: 'plain-log-group|sdin-secret-filter',
      resourceType: 'AWS::Logs::MetricFilter',
      properties: { FilterName: REF, LogGroupName: 'plain-log-group' },
      attributes: {},
      dependencies: [],
    },
    Reader: {
      physicalId: 'reader',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Value: readerValue },
      attributes: {},
      dependencies: [],
    },
  });

  it("records a needle another record's leaf embeds", () => {
    const bag = storedSecretNameNeedles(records('arn:x:plain-log-group|sdin-secret-filter'), undefined);
    expect(maskSecretsInText('old: plain-log-group|sdin-secret-filter', bag)).not.toContain(
      'sdin-secret-filter'
    );
  });

  it("leaves a segment only the named record's own leaf spells", () => {
    // SecretFilter stores its own log group's name; no OTHER record does, so
    // the group's ordinary name stays readable.
    const bag = storedSecretNameNeedles(records('unrelated'), undefined);
    expect(maskSecretsInText('plain-log-group', bag)).toBe('plain-log-group');
  });

  it("leaves the named record's own public segment where another record embeds it too", () => {
    // A log-group ARN in another record holds the ordinary group name, which
    // SecretFilter's own LogGroupName stores in the clear: it is public.
    const r = records('arn:aws:logs:us-east-1:123:log-group:plain-log-group:*');
    const arn = 'arn:aws:logs:us-east-1:123:log-group:plain-log-group:*';
    expect(maskSecretsInText(arn, storedSecretNameNeedles(r, undefined))).toBe(arn);
    expect(maskSecretsInText(arn, secretNamedRecordNeedles(r, undefined))).toBe(arn);
  });

  it("keeps a needle the record's own case-folded copy of a NoEcho value spells", () => {
    // A pre-v11 record holding its NoEcho name in plaintext AND a lower-cased
    // copy of it: the copy is the secret, not a public segment.
    const noEcho = new Map<string, string>();
    recordLogOnlyValue(noEcho, 'TeamSecretDb');
    const r: StackState['resources'] = {
      Db: {
        physicalId: 'teamsecretdb',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: 'TeamSecretDb', Tags: [{ Key: 'id', Value: 'teamsecretdb' }] },
        attributes: {},
        dependencies: [],
      },
      Reader: {
        physicalId: 'reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'teamsecretdb' },
        attributes: {},
        dependencies: [],
      },
    };
    expect(maskSecretsInText('teamsecretdb', storedSecretNameNeedles(r, noEcho))).not.toContain(
      'teamsecretdb'
    );
  });

  it('secretNamesStoredIn finds a name a leaf EMBEDS, as in an ARN', () => {
    const record = {
      properties: {
        Policy: { Resource: 'arn:aws:logs:us-east-1:123:log-group:sdin-secret-group:*' },
      },
    };
    expect(secretNamesStoredIn(record, ['sdin-secret-group', 'not-held-anywhere'])).toEqual([
      'sdin-secret-group',
    ]);
  });

  it("records a needle a stored OUTPUT holds", () => {
    const r = records('unrelated');
    const out = 'plain-log-group|sdin-secret-filter';
    // Premise: no record holds it, so only the outputs bag can.
    expect(maskSecretsInText(out, storedSecretNameNeedles(r, undefined))).toBe(out);
    expect(
      maskSecretsInText(out, storedSecretNameNeedles(r, undefined, new Map(), { Out: out }))
    ).not.toContain('sdin-secret-filter');
  });

  it('negative control: no record named from a secret records nothing', () => {
    const plain = records('arn:x:plain-log-group|sdin-secret-filter');
    (plain['SecretFilter']!.properties as Record<string, unknown>)['FilterName'] =
      'sdin-secret-filter';
    expect(hasMaskableValues(storedSecretNameNeedles(plain, undefined))).toBe(false);
  });
});
