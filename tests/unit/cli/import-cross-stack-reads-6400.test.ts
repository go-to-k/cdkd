/**
 * `cdkd import` records the stack's cross-stack reads (go-to-k/cdkd#6400).
 * `state.imports` is what the destroy-time strong-reference scan refuses a
 * producer destroy on, and an imported consumer used to be written without it,
 * so `cdkd destroy <producer>` deleted an export the consumer still read.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const warnLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => void warnLines.push(args.map(String).join(' ')),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const SECRET_ID = 'import-6400-secret';
const PASSWORD = 'hunter2-import-6400-plaintext';

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string } }): Promise<unknown> {
      if (command.input?.SecretId !== SECRET_ID) throw new Error('unexpected secret id');
      return { SecretString: JSON.stringify({ password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties, buildStackState } = await import(
  '../../../src/cli/commands/import.js'
);
const { TemplateParser } = await import('../../../src/analyzer/template-parser.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const REGION = 'us-east-1';
const SECRET_EXPORT = `exp-${PASSWORD}`;
const SECRET_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
/** The spelling a deploy persists for the same name (`redactCrossStackReads`). */
const REDACTED_EXPORT = `exp-${SECRET_REF}`;
const secretImport = () => ({ 'Fn::ImportValue': { 'Fn::Join': ['', ['exp-', SECRET_REF]] } });

/** A state backend holding one producer that exports the given names. */
function producerBackend(exports: Record<string, string>) {
  return {
    listStacks: vi.fn(async () => [{ stackName: 'Producer', region: REGION }]),
    getState: vi.fn(async (stackName: string) =>
      stackName === 'Producer'
        ? {
            state: {
              version: STATE_SCHEMA_VERSION_CURRENT,
              stackName: 'Producer',
              region: REGION,
              resources: {},
              outputs: exports,
              exportNames: Object.keys(exports),
              lastModified: 1,
            },
            etag: '"e"',
          }
        : null
    ),
  };
}

const PARAM_PROPS = { Type: 'String', Value: { 'Fn::ImportValue': 'SharedTable' } };

function consumerState(extra: Partial<StackState> = {}): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'Consumer',
    region: REGION,
    resources: {
      Param: {
        physicalId: 'consumer-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { ...PARAM_PROPS },
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  } satisfies StackState;
}

const TEMPLATE = {
  Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: PARAM_PROPS } },
} as CloudFormationTemplate;

const SHARED_TABLE = { exportName: 'SharedTable', sourceStack: 'Producer', sourceRegion: REGION };

async function importInto(
  state: StackState,
  template: CloudFormationTemplate,
  exports: Record<string, string> = { SharedTable: 'table-1' }
): Promise<StackState> {
  await resolveImportedProperties(
    state,
    template,
    REGION,
    producerBackend(exports) as never,
    getLogger()
  );
  return state;
}

describe('cdkd import records state.imports (go-to-k/cdkd#6400)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warnLines.length = 0;
  });

  it("records an Fn::ImportValue a resource's properties read", async () => {
    const state = await importInto(consumerState(), TEMPLATE);
    expect(state.resources['Param']!.properties).toEqual({ Type: 'String', Value: 'table-1' });
    expect(state.imports).toEqual([SHARED_TABLE]);
  });

  it('records an Fn::ImportValue only an Output reads', async () => {
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: { Imported: { Value: { 'Fn::ImportValue': 'SharedBucket' } } },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template, { SharedBucket: 'bucket-1' });
    expect(state.imports).toEqual([{ ...SHARED_TABLE, exportName: 'SharedBucket' }]);
    // The Output's value is not derived: an import carries the previous bag.
    expect(state.outputs).toEqual({});
  });

  it('skips an Output whose Condition is false', async () => {
    const template = {
      Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: { Imported: { Condition: 'Never', Value: { 'Fn::ImportValue': 'SharedBucket' } } },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template, { SharedBucket: 'bucket-1' });
    expect(state.imports).toBeUndefined();
  });

  it('unions with the imports the record already holds, without a duplicate', async () => {
    const other = { exportName: 'OtherExport', sourceStack: 'Other', sourceRegion: REGION };
    const added = await importInto(consumerState({ imports: [other] }), TEMPLATE);
    expect(added.imports).toEqual([other, SHARED_TABLE]);
    const held = await importInto(consumerState({ imports: [other, SHARED_TABLE] }), TEMPLATE);
    expect(held.imports).toEqual([other, SHARED_TABLE]);
  });

  it('redacts an export name assembled around a secret to the spelling a deploy persists', async () => {
    const props = { Type: 'String', Value: secretImport() };
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: props } },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { ...props };
    await importInto(state, template, { [SECRET_EXPORT]: 'table-2' });
    expect(state.imports).toEqual([{ ...SHARED_TABLE, exportName: REDACTED_EXPORT }]);
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
  });

  it('rewrites a previous record\'s plaintext spelling of the same read, keeping one row', async () => {
    const props = { Type: 'String', Value: secretImport() };
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: props } },
    } as unknown as CloudFormationTemplate;
    // A record written before #3289 redacted these names.
    const state = consumerState({ imports: [{ ...SHARED_TABLE, exportName: SECRET_EXPORT }] });
    state.resources['Param']!.properties = { ...props };
    await importInto(state, template, { [SECRET_EXPORT]: 'table-2' });
    expect(state.imports).toEqual([{ ...SHARED_TABLE, exportName: REDACTED_EXPORT }]);
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
  });

  it('redacts a secret only the Outputs pass resolves', async () => {
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: { Imported: { Value: secretImport() } },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template, { [SECRET_EXPORT]: 'table-2' });
    expect(state.imports).toEqual([{ ...SHARED_TABLE, exportName: REDACTED_EXPORT }]);
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
  });

  it('records an Fn::GetStackOutput read into outputReads', async () => {
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: {
        Read: { Value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'SharedTable' } } },
      },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template);
    expect(state.outputReads).toEqual([
      { sourceStack: 'Producer', sourceRegion: REGION, outputName: 'SharedTable' },
    ]);
    expect(state.imports).toBeUndefined();
  });

  it('records the read in an Output that also names an unimported resource, without a warning', async () => {
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: {
        Plain: { Value: { Ref: 'NotImported' } },
        // Reads nothing across stacks, so nothing in it is resolved: resolving
        // it would warn about the attribute for a pass that records reads.
        Attr: { Value: { 'Fn::GetAtt': ['Param', 'NoSuchAttribute'] } },
        Mixed: {
          Value: { 'Fn::Join': [',', [{ 'Fn::ImportValue': 'SharedBucket' }, { 'Fn::GetAtt': ['NotImported', 'Arn'] }]] },
        },
        Subbed: { Value: { 'Fn::Sub': ['${NotImported}-${X}', { X: { 'Fn::ImportValue': 'SharedTable' } }] } },
        // The read's OWN argument names the unimported resource: skipped.
        Named: { Value: { 'Fn::ImportValue': { 'Fn::Sub': '${NotImported}-export' } } },
      },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template, { SharedBucket: 'bucket-1', SharedTable: 'table-1' });
    expect(warnLines).toEqual([]);
    expect(state.imports).toEqual([{ ...SHARED_TABLE, exportName: 'SharedBucket' }, SHARED_TABLE]);
  });

  it('reads only the selected branch of an Fn::If whose condition is known', async () => {
    const template = {
      Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } } },
      Outputs: {
        Picked: {
          Value: { 'Fn::If': ['Never', { 'Fn::ImportValue': 'SharedBucket' }, { 'Fn::ImportValue': 'SharedTable' }] },
        },
        // The untaken branch of an Fn::If inside the read's argument names an
        // unimported resource: it must not make the read unresolvable.
        Argued: {
          Value: { 'Fn::ImportValue': { 'Fn::If': ['Never', { Ref: 'NotImported' }, 'SharedBucket'] } },
        },
      },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { Type: 'String', Value: 'x' };
    await importInto(state, template, { SharedBucket: 'bucket-1', SharedTable: 'table-1' });
    expect(state.imports).toEqual([SHARED_TABLE, { ...SHARED_TABLE, exportName: 'SharedBucket' }]);
  });

  it("records the read of a resource whose bag failed before the resolver reached it", async () => {
    // `Ref` to a resource this import did not take throws on the FIRST key,
    // before the resolver walks the key holding the import.
    const props = {
      Description: { Ref: 'NotImported' },
      Type: 'String',
      Value: { 'Fn::ImportValue': 'SharedTable' },
    };
    const template = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: props } },
    } as unknown as CloudFormationTemplate;
    const state = consumerState();
    state.resources['Param']!.properties = { ...props };
    await importInto(state, template);
    // The bag failed: it is persisted as it was.
    expect(state.resources['Param']!.properties).toEqual(props);
    expect(state.imports).toEqual([SHARED_TABLE]);
  });
});


describe('the import state literal carries the cross-stack reads (go-to-k/cdkd#6400)', () => {
  it('keeps an existing record’s imports and outputReads', () => {
    const read = { outputName: 'Out', sourceStack: 'Producer', sourceRegion: REGION };
    const existing = consumerState({ imports: [SHARED_TABLE], outputReads: [read] });
    const built = buildStackState(
      'Consumer',
      REGION,
      [{ logicalId: 'Param', resourceType: 'AWS::SSM::Parameter', outcome: 'imported', physicalId: 'consumer-param' }],
      new TemplateParser(),
      TEMPLATE,
      existing,
      true
    );
    expect(built.imports).toEqual([SHARED_TABLE]);
    expect(built.outputReads).toEqual([read]);
  });
});
