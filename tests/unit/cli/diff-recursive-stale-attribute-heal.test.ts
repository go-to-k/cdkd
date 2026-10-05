/**
 * Issue [go-to-k/cdkd#3456](https://github.com/go-to-k/cdkd/issues/3456): the
 * resolver contexts `computeStackDiff` / `buildDiffTree` build carry the
 * read-only stale-attribute healer, so a `Fn::GetAtt` over a record that lacks
 * the attribute previews as the value `cdkd deploy` resolves after its heal.
 *
 * One case per context the healer must reach — the resource diff (a
 * non-`*Arn` attribute that used to preview as the physical id), the Outputs
 * pass (an `*Arn` output that used to preview unresolved), and a nested
 * child's `Parameters`, resolved against the PARENT's state — each with its
 * healer-less twin as the negative control. The command-level case from the
 * issue thread is `diff-stale-attribute-heal-3456.test.ts`.
 *
 * The healer is the REAL factory with a fake provider, so what is pinned is
 * the wiring plus the read, not a stub's answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The resolver's own account lookup, kept off the network like
// `stale-attribute-heal.test.ts` does.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

import {
  buildDiffTree,
  computeStackDiff,
  diffTreeToJson,
  renderChangeLines,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { createReadOnlyAttributeHealerFactory } from '../../../src/deployment/read-only-attribute-healer.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

const NESTED = 'AWS::CloudFormation::Stack';
const PARAM_ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/app/p';
const ENDPOINT = 'db1.abc.us-east-1.rds.amazonaws.com';
const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';
/** A physical id whose read AWS denies (go-to-k/cdkd#4163). */
const DENIED = 'db-denied';

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 10, lastModified: 0 };
}

function fakeBackend(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
    saveState: async () => {
      throw new Error('cdkd diff must not save state');
    },
  } as unknown as S3StateBackend;
}

/** What AWS reports for each physical id. */
const live: Record<string, Record<string, unknown>> = {
  '/app/p': { Arn: PARAM_ARN, Type: 'String' },
  db1: { 'Endpoint.Address': ENDPOINT, 'Endpoint.Port': '5432' },
  [`arn:aws:lambda:us-east-1:123456789012:function:fn`]: { FunctionUrl: URL },
  // An endpoint whose live value equals a NoEcho parameter's (go-to-k/cdkd#4049).
  'db-secret': { 'Endpoint.Address': 'noecho-plain-7731' },
};

let importCalls: Array<{ logicalId: string; knownPhysicalId?: string; stackName: string }>;
let getProviderCalls: string[];

function healerFor(): ReturnType<typeof createReadOnlyAttributeHealerFactory> {
  const provider: ResourceProvider = {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    import: vi.fn(async (input) => {
      importCalls.push({
        logicalId: input.logicalId,
        knownPhysicalId: input.knownPhysicalId,
        stackName: input.stackName,
      });
      if (input.knownPhysicalId === DENIED) {
        throw Object.assign(new Error('not authorized to perform: rds:DescribeDBInstances'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        });
      }
      const attributes = live[input.knownPhysicalId ?? ''];
      return attributes ? { physicalId: input.knownPhysicalId!, attributes } : null;
    }),
  } as unknown as ResourceProvider;
  return createReadOnlyAttributeHealerFactory({
    getProvider: (resource) => {
      getProviderCalls.push(resource.resourceType);
      return provider;
    },
    inRegion: (_region, fn) => fn(),
  });
}

beforeEach(() => {
  importCalls = [];
  getProviderCalls = [];
});

describe('computeStackDiff heals the resource diff and the Outputs pass (go-to-k/cdkd#3456)', () => {
  // A `--no-wait` DBInstance's record holds no endpoint, and the parameter
  // reading it was written under the warn-and-fallback: it holds the physical
  // id. The next deploy heals the record and UPDATES the parameter.
  const dbState = (): StackState =>
    st('S', {
      Db: {
        physicalId: 'db1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { Engine: 'postgres' },
        attributes: {},
      },
      Endpoint: {
        physicalId: 'endpoint-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: 'db1' },
        attributes: {},
      },
    });
  const dbTemplate: CloudFormationTemplate = {
    Resources: {
      Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
      Endpoint: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
      },
    },
  };

  it('previews a non-*Arn attribute as the endpoint the deploy serves, not the physical id', async () => {
    const state = dbState();
    const { changes } = await computeStackDiff(
      state,
      dbTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { attributeHealer: healerFor()('S', 'us-east-1') }
    );
    const update = changes.get('Endpoint');
    expect(update?.changeType).toBe('UPDATE');
    expect(update?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: 'db1', newValue: ENDPOINT }),
    ]);
    expect(importCalls).toEqual([{ logicalId: 'Db', knownPhysicalId: 'db1', stackName: 'S' }]);
    // Read-only: nothing merged into the loaded record.
    expect(state.resources['Db']?.attributes).toEqual({});
  });

  it('without a healer the same diff previews the physical id, so no change (the pre-fix preview)', async () => {
    const { changes } = await computeStackDiff(
      dbState(),
      dbTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(changes.get('Endpoint')?.changeType).toBe('NO_CHANGE');
    expect(importCalls).toEqual([]);
  });

  it('evaluates Conditions over the healed value, as the deploy engine does', async () => {
    // CloudFormation itself refuses a resource attribute inside `Conditions`,
    // but cdkd's evaluator resolves one, and the deploy engine puts its healer
    // on the condition context too — so the preview must prune the same way.
    const template: CloudFormationTemplate = {
      Conditions: {
        EndpointKnown: { 'Fn::Equals': [{ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ENDPOINT] },
      },
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
        Gated: {
          Type: 'AWS::SSM::Parameter',
          Condition: 'EndpointKnown',
          Properties: { Type: 'String', Value: 'x' },
        },
      },
    };
    const run = (withHealer: boolean) =>
      computeStackDiff(dbState(), template, 'us-east-1', 'S', fakeBackend({}), new DiffCalculator(), {
        ...(withHealer && { attributeHealer: healerFor()('S', 'us-east-1') }),
      });
    expect((await run(true)).changes.get('Gated')?.changeType).toBe('CREATE');
    expect((await run(false)).changes.get('Gated')).toBeUndefined();
  });

  // A record written before `AWS::SSM::Parameter.Arn` was recorded (#1824).
  const paramState = (): StackState =>
    st('S', {
      Param: {
        physicalId: '/app/p',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/p', Type: 'String', Value: 'v' },
        attributes: { Type: 'String' },
      },
    });
  const paramTemplate: CloudFormationTemplate = {
    Resources: {
      Param: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/app/p', Type: 'String', Value: 'v' },
      },
    },
    Outputs: { ParamArn: { Value: { 'Fn::GetAtt': ['Param', 'Arn'] } } },
  };

  it('previews an *Arn output as the ARN the re-read serves', async () => {
    const { outputChanges } = await computeStackDiff(
      paramState(),
      paramTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { attributeHealer: healerFor()('S', 'us-east-1') }
    );
    expect(outputChanges).toContainEqual(
      expect.objectContaining({ name: 'ParamArn', changeType: 'ADD', newValue: PARAM_ARN })
    );
  });

  it('without a healer the same output does not preview the ARN (the pre-fix preview)', async () => {
    const { outputChanges } = await computeStackDiff(
      paramState(),
      paramTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(outputChanges).not.toContainEqual(expect.objectContaining({ newValue: PARAM_ARN }));
  });

  it('never reads a custom resource: its attributes are handler Data, not an AWS read-back', async () => {
    const state = st('S', {
      Thing: { physicalId: 'thing-1', resourceType: 'Custom::Thing', properties: {}, attributes: {} },
      // Recorded, so the row diffs as an UPDATE and its `Fn::GetAtt` is
      // RESOLVED — a CREATE row never reaches the healer at all.
      Reader: {
        physicalId: 'reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: 'old' },
        attributes: {},
      },
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Thing: { Type: 'Custom::Thing', Properties: {} },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Thing', 'Secret'] } },
        },
      },
    };
    await computeStackDiff(state, template, 'us-east-1', 'S', fakeBackend({}), new DiffCalculator(), {
      attributeHealer: healerFor()('S', 'us-east-1'),
    });
    expect(getProviderCalls).toEqual([]);
    expect(importCalls).toEqual([]);
  });
});

describe("buildDiffTree heals a nested child's Parameters against the parent's state (go-to-k/cdkd#3456)", () => {
  const FN = 'arn:aws:lambda:us-east-1:123456789012:function:fn';

  async function diffTree(withHealer: boolean): Promise<Awaited<ReturnType<typeof buildDiffTree>>> {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3456-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Parameters: { UrlIn: { Type: 'String' } },
          Resources: {
            Consumer: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Type: 'String', Value: { Ref: 'UrlIn' } },
            },
          },
        })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Url: { Type: 'AWS::Lambda::Url', Properties: { TargetFunctionArn: FN, AuthType: 'NONE' } },
          // The parent reads the same attribute, so the child's parameter and
          // the parent's own diff ask for ONE record: one read, not two.
          ParentReader: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] } },
          },
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { UrlIn: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] } } },
          },
        },
      };
      const factory = healerFor();
      return await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fakeBackend({
          S: st('S', {
            Url: {
              physicalId: FN,
              resourceType: 'AWS::Lambda::Url',
              properties: { TargetFunctionArn: FN, AuthType: 'NONE' },
              attributes: {},
            },
            ParentReader: {
              physicalId: 'parent-reader',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Type: 'String', Value: URL },
              attributes: {},
            },
            Child: { physicalId: 'child-arn', resourceType: NESTED, properties: {}, attributes: {} },
          }),
          // The child the healed deploy wrote: its parameter holds the URL.
          'S~Child': st('S~Child', {
            Consumer: {
              physicalId: 'consumer',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Type: 'String', Value: URL },
              attributes: {},
            },
          }),
        }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        ...(withHealer && { attributeHealerFor: factory }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('resolves the parameter from the re-read, so the healed child previews no change', async () => {
    const node = await diffTree(true);
    expect(node.changes.get('ParentReader')?.changeType).toBe('NO_CHANGE');
    const child = node.children.find((c) => c.stackName === 'S~Child');
    expect(child?.changes.get('Consumer')?.changeType).toBe('NO_CHANGE');
    // One read for the parent's diff and the child's parameter together.
    expect(importCalls).toEqual([{ logicalId: 'Url', knownPhysicalId: FN, stackName: 'S' }]);
  });

  it("heals a record in the nested child's OWN state, keyed to the child stack", async () => {
    // The child deploys through its own engine, which heals its own records.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3456-own-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: {
            Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
            Endpoint: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
            },
          },
        })
      );
      const run = (withHealer: boolean) =>
        buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: {
            Resources: {
              Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
            },
          },
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: fakeBackend({
            S: st('S', {
              Child: { physicalId: 'child-arn', resourceType: NESTED, properties: {}, attributes: {} },
            }),
            'S~Child': st('S~Child', {
              Db: {
                physicalId: 'db1',
                resourceType: 'AWS::RDS::DBInstance',
                properties: { Engine: 'postgres' },
                attributes: {},
              },
              Endpoint: {
                physicalId: 'endpoint-param',
                resourceType: 'AWS::SSM::Parameter',
                properties: { Type: 'String', Value: 'db1' },
                attributes: {},
              },
            }),
          }),
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
          ...(withHealer && { attributeHealerFor: healerFor() }),
        });
      const healed = await run(true);
      const child = healed.children.find((c) => c.stackName === 'S~Child');
      expect(child?.changes.get('Endpoint')?.changeType).toBe('UPDATE');
      expect(importCalls).toEqual([{ logicalId: 'Db', knownPhysicalId: 'db1', stackName: 'S~Child' }]);

      const unhealed = await run(false);
      const child2 = unhealed.children.find((c) => c.stackName === 'S~Child');
      expect(child2?.changes.get('Endpoint')?.changeType).toBe('NO_CHANGE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a healer the parameter is dropped and the child previews a spurious update', async () => {
    const node = await diffTree(false);
    const child = node.children.find((c) => c.stackName === 'S~Child');
    expect(child?.changes.get('Consumer')?.changeType).toBe('UPDATE');
    // Dropped, not resolved to something else: the child keeps its raw `Ref`.
    expect(child?.changes.get('Consumer')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: URL, newValue: { Ref: 'UrlIn' } }),
    ]);
    expect(importCalls).toEqual([]);
  });
});

describe('a healed value that equals a NoEcho parameter value previews masked (go-to-k/cdkd#4049 x go-to-k/cdkd#3456)', () => {
  const NOECHO = 'noecho-plain-7731';

  it('masks it in the property row, the Outputs row and --json', async () => {
    const state = st('S', {
      Db: {
        physicalId: 'db-secret',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { Engine: 'postgres' },
        attributes: {},
      },
      Endpoint: {
        physicalId: 'endpoint-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: 'db-secret' },
        attributes: {},
      },
    });
    const template = {
      Parameters: { DbUser: { Type: 'String', NoEcho: true, Default: NOECHO } },
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
        Endpoint: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
        },
      },
      Outputs: { DbEndpoint: { Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } } },
    } as unknown as CloudFormationTemplate;

    const result = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { attributeHealer: healerFor()('S', 'us-east-1') }
    );
    // Premise: the heal served the value (the row changed because of it).
    expect(importCalls).toEqual([{ logicalId: 'Db', knownPhysicalId: 'db-secret', stackName: 'S' }]);

    expect(result.changes.get('Endpoint')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', newValue: '***' }),
    ]);
    expect(result.outputChanges).toEqual([
      expect.objectContaining({ name: 'DbEndpoint', changeType: 'ADD', newValue: '***' }),
    ]);

    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: result.changes,
      ccApiRoutes: new Map(),
      outputChanges: result.outputChanges,
      adoptedOrphans: [],
      blocking: [],
      unreadable: [],
      unreadableContainers: [],
      unreadableOrphans: [],
      destructiveChanges: [],
      children: [],
    };
    const lines: string[] = [];
    renderChangeLines(node.changes, (line) => lines.push(line));
    renderOutputChangeLines(node.outputChanges, (line) => lines.push(line));
    const human = lines.join('\n');
    const json = JSON.stringify(diffTreeToJson(node));
    expect(human).toContain('new: "***"');
    expect(human).not.toContain(NOECHO);
    expect(json).toContain('"newValue":"***"');
    expect(json).not.toContain(NOECHO);
  });
});

describe('a denied re-read during the diff is worded as the preview (go-to-k/cdkd#4163)', () => {
  // Through `buildDiffTree`, so the healer the command builds is the one the
  // resolver sees: a wrapper between the factory and the context would drop
  // its `readOnly` flag and bring back the deploy's "tried to heal" wording.
  it('warns that the preview re-read the record, not that cdkd tried to heal it', async () => {
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: {
          Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
          Endpoint: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
          },
        },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({
        S: st('S', {
          Db: {
            physicalId: DENIED,
            resourceType: 'AWS::RDS::DBInstance',
            properties: { Engine: 'postgres' },
            attributes: {},
          },
          Endpoint: {
            physicalId: 'endpoint-param',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Type: 'String', Value: DENIED },
            attributes: {},
          },
        }),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      attributeHealerFor: healerFor(),
    });
    // The read was issued and failed, so the row falls back to the physical id.
    expect(importCalls).toEqual([{ logicalId: 'Db', knownPhysicalId: DENIED, stackName: 'S' }]);
    expect(node.changes.get('Endpoint')?.changeType).toBe('NO_CHANGE');
    const warned = warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('holds no'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      'This preview re-read the attributes from AWS, but the provider read failed (AccessDeniedException, HTTP 403)'
    );
    expect(warned[0]).not.toContain('tried to re-read');
    expect(warned[0]).not.toContain('retries the read on every deploy');
  });

  // The nested walk hands `attributeHealerFor` to each child's own
  // `buildDiffTree`: a wrapper there would drop `readOnly` for every child.
  it("words a nested child's denied re-read as the preview too", async () => {
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4163-nested-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: {
            Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres' } },
            Endpoint: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
            },
          },
        })
      );
      const node = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: {
          Resources: {
            Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
          },
        },
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fakeBackend({
          S: st('S', {
            Child: { physicalId: 'child-arn', resourceType: NESTED, properties: {}, attributes: {} },
          }),
          'S~Child': st('S~Child', {
            Db: {
              physicalId: DENIED,
              resourceType: 'AWS::RDS::DBInstance',
              properties: { Engine: 'postgres' },
              attributes: {},
            },
            Endpoint: {
              physicalId: 'endpoint-param',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Type: 'String', Value: DENIED },
              attributes: {},
            },
          }),
        }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        attributeHealerFor: healerFor(),
      });
      // The CHILD's record was read, keyed to the child stack, and failed.
      expect(importCalls).toEqual([{ logicalId: 'Db', knownPhysicalId: DENIED, stackName: 'S~Child' }]);
      const child = node.children.find((c) => c.stackName === 'S~Child');
      expect(child?.changes.get('Endpoint')?.changeType).toBe('NO_CHANGE');
      const warned = warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('holds no'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(
        'This preview re-read the attributes from AWS, but the provider read failed (AccessDeniedException, HTTP 403)'
      );
      expect(warned[0]).not.toContain('tried to re-read');
      expect(warned[0]).not.toContain('retries the read on every deploy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
