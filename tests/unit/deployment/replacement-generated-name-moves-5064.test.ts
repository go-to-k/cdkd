/**
 * go-to-k/cdkd#5064 phase 2: `replacementGeneratedNameMoves`, the name-change
 * arm that lets a replacement of an UN-NAMED resource create first, and the
 * orphan-adoption planner on a stack with an instance id.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import { replacementGeneratedNameMoves } from '../../../src/deployment/replacement-name-holder.js';
import { planOrphanAdoption } from '../../../src/deployment/orphan-adoption.js';
import {
  generatedReplacementHolderAdvice,
  isReplacementNameRefusal,
} from '../../../src/deployment/deploy-engine/name-collision.js';
import { CdkdError, ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  stackInstanceNameSuffix,
  withNameGeneration,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackOrphanRecord } from '../../../src/types/state.js';

const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const v13 = { stackName: 'App', stackInstanceId: ID, nameGenerations: new Map<string, number>() };
const legacy = { stackName: 'App', stackInstanceId: undefined, nameGenerations: undefined };
const name = (logicalId: string, g: number) =>
  `App-${logicalId}-${stackInstanceNameSuffix(ID, logicalId, g)}`;

/** The arm, asked at generation 1 for `logicalId` (as `update.ts` binds it). */
const atNext = (
  input: Partial<Parameters<typeof replacementGeneratedNameMoves>[0]> & { logicalId: string },
  scope: typeof v13 | typeof legacy = v13
) =>
  withStackScope(scope, () =>
    withNameGeneration({ logicalId: input.logicalId, generation: 1 }, () =>
      replacementGeneratedNameMoves({
        oldResourceType: 'AWS::DynamoDB::Table',
        newResourceType: 'AWS::DynamoDB::Table',
        createdVia: 'sdk',
        desiredProperties: {},
        physicalId: name(input.logicalId, 0),
        ...input,
      })
    )
  );

describe('replacementGeneratedNameMoves', () => {
  it('a verbatim-generated type moves to the next generation name, marked generated', () => {
    expect(atNext({ logicalId: 'Table' })).toEqual({
      property: 'TableName',
      desiredName: name('Table', 1),
      heldName: undefined,
      heldProperty: undefined,
      physicalId: name('Table', 0),
      generated: true,
    });
  });

  it('a rewriting provider (IAM role) and a derived one (S3 bucket) move too', () => {
    expect(
      atNext({
        logicalId: 'Role',
        oldResourceType: 'AWS::IAM::Role',
        newResourceType: 'AWS::IAM::Role',
        physicalId: name('Role', 0),
      })?.desiredName
    ).toBe(name('Role', 1));
    const bucket = atNext({
      logicalId: 'Bucket',
      oldResourceType: 'AWS::S3::Bucket',
      newResourceType: 'AWS::S3::Bucket',
      physicalId: name('Bucket', 0).toLowerCase(),
    });
    expect(bucket?.desiredName).toBe(name('Bucket', 1).toLowerCase());
  });

  it('an ARN-shaped old id is read by its name segment (an SNS topic)', () => {
    expect(
      atNext({
        logicalId: 'Topic',
        oldResourceType: 'AWS::SNS::Topic',
        newResourceType: 'AWS::SNS::Topic',
        physicalId: `arn:aws:sns:us-east-1:123456789012:${name('Topic', 1)}`,
      })
    ).toBeUndefined();
  });

  it('answers nothing on a legacy stack, a Type change, a declared name or an unknown type', () => {
    expect(atNext({ logicalId: 'Table' }, legacy)).toBeUndefined();
    expect(
      atNext({ logicalId: 'Table', oldResourceType: 'AWS::DynamoDB::GlobalTable' })
    ).toBeUndefined();
    expect(atNext({ logicalId: 'Table', desiredProperties: { TableName: 'mine' } })).toBeUndefined();
    expect(
      atNext({
        logicalId: 'Sg',
        oldResourceType: 'AWS::EC2::SecurityGroup',
        newResourceType: 'AWS::EC2::SecurityGroup',
      })
    ).toBeUndefined();
  });

  it('answers nothing when the old resource already holds the name (no move)', () => {
    expect(atNext({ logicalId: 'Table', physicalId: name('Table', 1) })).toBeUndefined();
  });
});

describe('replacementGeneratedNameMoves for a Cloud Control directory bucket (#5095)', () => {
  const dir = {
    oldResourceType: 'AWS::S3Express::DirectoryBucket',
    newResourceType: 'AWS::S3Express::DirectoryBucket',
    createdVia: 'cc-api' as const,
    physicalId: `app-bucket-${stackInstanceNameSuffix(ID, 'Bucket', 0)}--use1-az5--x-s3`,
  };

  it('moves to the next generation name, zone suffix included, read from the desired LocationName', () => {
    expect(
      atNext({ ...dir, logicalId: 'Bucket', desiredProperties: { LocationName: 'use1-az5' } })?.desiredName
    ).toBe(`app-bucket-${stackInstanceNameSuffix(ID, 'Bucket', 1)}--use1-az5--x-s3`);
  });

  it('answers undefined, never throws, when LocationName is not a zone id', () => {
    expect(
      atNext({ ...dir, logicalId: 'Bucket', desiredProperties: { LocationName: 'us-east-1a' } })
    ).toBeUndefined();
  });
});

describe('generatedReplacementHolderAdvice', () => {
  const base = {
    stackName: 'App',
    logicalId: 'Table',
    change: { desiredName: 'App-Table-abc', generated: true as const },
    oldPhysicalId: 'App-Table-old',
    mask: (text: string) => text,
  };
  it('names the import command for a top-level stack', () => {
    const text = generatedReplacementHolderAdvice(base);
    expect(text).toContain("cdkd import App --resource 'Table=App-Table-abc'");
    expect(text).toContain('delete App-Table-old by hand');
  });
  it('a nested child names the top-level stack, never an unrunnable command', () => {
    const text = generatedReplacementHolderAdvice({ ...base, stackName: 'App~Child' });
    expect(text).toContain('through the top-level stack');
    expect(text).not.toContain('cdkd import App~Child');
  });
  it('a command the mask would change is withheld', () => {
    const text = generatedReplacementHolderAdvice({
      ...base,
      mask: (t: string) => t.replaceAll('App-Table-abc', '***'),
    });
    expect(text).toContain('adopt it with `cdkd import`');
    expect(text).not.toContain('App-Table-abc');
  });
  it('says nothing for a name that is not a generated move', () => {
    expect(generatedReplacementHolderAdvice({ ...base, change: { desiredName: 'x' } })).toBe('');
    expect(generatedReplacementHolderAdvice({ ...base, change: undefined })).toBe('');
  });
});

describe('planOrphanAdoption on a stack with an instance id', () => {
  const record: StackOrphanRecord = {
    logicalId: 'Kept',
    orphanedAt: 1,
    state: {
      physicalId: name('Kept', 0),
      resourceType: 'AWS::SQS::Queue',
      properties: {},
    },
  };
  const template = {
    Resources: { Kept: { Type: 'AWS::SQS::Queue', Properties: {} } },
  } as unknown as CloudFormationTemplate;
  const plan = (newScheme: boolean, managed: string[] = []) => {
    const provider = { import: vi.fn(async () => ({ physicalId: name('Kept', 0), attributes: {} })) };
    return {
      provider,
      result: planOrphanAdoption({
        records: [record],
        managedLogicalIds: new Set(managed),
        template,
        stackName: 'App',
        region: 'us-east-1',
        getProvider: () => provider as never,
        nameProperties: () => ['QueueName'],
        readSiblingClaims: async () => new Set(),
        logger: { debug: () => undefined },
        newScheme,
      }),
    };
  };

  it('takes nothing back, reads nothing from AWS, keeps the record and warns naming cdkd import', async () => {
    const { provider, result } = plan(true);
    const outcome = await result;
    expect(outcome.adopted).toEqual({});
    expect(outcome.remaining).toEqual([record]);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toMatch(/does not take it back.*'cdkd import'/);
    expect(provider.import).not.toHaveBeenCalled();
  });

  it('drops the record once its logical id is managed again, silently', async () => {
    const outcome = await plan(true, ['Kept']).result;
    expect(outcome.remaining).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it('warns only for a record the template declares again with the same type', async () => {
    const run = async (resources: Record<string, unknown>) => {
      const outcome = await planOrphanAdoption({
        records: [record],
        managedLogicalIds: new Set(),
        template: { Resources: resources } as unknown as CloudFormationTemplate,
        stackName: 'App',
        region: 'us-east-1',
        getProvider: () => ({}) as never,
        nameProperties: () => ['QueueName'],
        readSiblingClaims: async () => new Set(),
        logger: { debug: () => undefined },
        newScheme: true,
      });
      return outcome;
    };
    const undeclared = await run({});
    expect(undeclared.warnings).toEqual([]);
    expect(undeclared.remaining).toEqual([record]);
    const retyped = await run({ Kept: { Type: 'AWS::SNS::Topic', Properties: {} } });
    expect(retyped.warnings).toEqual([]);
    expect(retyped.remaining).toEqual([record]);
  });

  it('a legacy stack still adopts (unchanged)', async () => {
    const { provider, result } = plan(false);
    const outcome = await result;
    expect(Object.keys(outcome.adopted)).toEqual(['Kept']);
    expect(provider.import).toHaveBeenCalled();
  });
});

describe('isReplacementNameRefusal (a refused replacement keeps its generation)', () => {
  const refusal = () => new CdkdError('refused', 'NAMED_REPLACEMENT_COLLISION');
  const wrap = (logicalId: string, cause: Error) =>
    new ProvisioningError(`Failed to update resource ${logicalId}`, 'AWS::ECR::Repository', logicalId, undefined, cause);

  it("reads the refusal under the row's own wrap", () => {
    expect(isReplacementNameRefusal(refusal(), 'Repo')).toBe(true);
    expect(isReplacementNameRefusal(wrap('Repo', refusal()), 'Repo')).toBe(true);
  });

  it('any other failure is not a refusal: the record still moves past its generation', () => {
    expect(isReplacementNameRefusal(new CdkdError('boom', 'PROVISIONING_ERROR'), 'Repo')).toBe(false);
    expect(isReplacementNameRefusal(wrap('Repo', new Error('throttled')), 'Repo')).toBe(false);
    expect(isReplacementNameRefusal(undefined, 'Repo')).toBe(false);
  });

  it("stops at a link naming another logical id (a nested child's refusal under the parent row)", () => {
    expect(isReplacementNameRefusal(wrap('Child', wrap('Inner', refusal())), 'Child')).toBe(false);
  });
});
