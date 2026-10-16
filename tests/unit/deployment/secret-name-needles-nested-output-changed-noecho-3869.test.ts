/**
 * The derived-name judge's two arms for go-to-k/cdkd#3869 items 2 and 3.
 *
 * Item 2: a nested-stack row's `secretNamedAttributes` names the outputs that
 * hold a child resource's secret-derived name; every string leaf of each is a
 * needle, for every reader of the judge (a parent's reads, the diff's stored
 * side, `cdkd diff`, destroy).
 *
 * Item 3: what a record stores where a `NoEcho` parameter served it is a
 * judging needle WHOLE (`recordedNoEchoValuesOf`), so a name taken from a value
 * since changed, or a short / `Number` one, is judged secret-derived.
 */
import { describe, it, expect } from 'vite-plus/test';
import type { ResourceState } from '../../../src/types/state.js';
import {
  namingSecretsWithRecordedNoEcho,
  secretNameNeedlesOf,
  secretNamedAttributeNamesOf,
  secretNamedRecordNeedles,
  secretNamePrintingBags,
  stateSecretNameNeedles,
  storedSecretNameNeedles,
} from '../../../src/deployment/secret-name-needles.js';
import {
  maskSecretsInText,
  printingCorpusOf,
  recordedNoEchoValuesOf,
  recordLogOnlyValue,
} from '../../../src/deployment/secret-redaction.js';

const ROLE_NAME = 'Parent-Child-Team-Secret-Role-a1b2';
const ROLE_ARN = `arn:aws:iam::123456789012:role/${ROLE_NAME}`;

const record = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  extra: Partial<ResourceState> = {}
): ResourceState =>
  ({ physicalId, resourceType, properties, attributes: {}, dependencies: [], ...extra }) as ResourceState;

function stackRow(secretNamedAttributes?: unknown): ResourceState {
  return record(
    'arn:aws:cloudformation:us-east-1:123456789012:stack/P-Child/cdkd',
    'AWS::CloudFormation::Stack',
    { TemplateURL: 'https://example.com/child.json' },
    {
      attributes: {
        'Outputs.RoleName': ROLE_NAME,
        'Outputs.RoleArn': ROLE_ARN,
        'Outputs.Masked': '***',
        'Outputs.Ref': '{{resolve:secretsmanager:team:SecretString:x::}}',
        'Outputs.Plain': 'plain-output-value',
      },
      ...(secretNamedAttributes !== undefined && {
        secretNamedAttributes: secretNamedAttributes as string[],
      }),
    }
  );
}

describe('item 2: a nested-stack row names its secret-named outputs (go-to-k/cdkd#3869)', () => {
  it('every string leaf of each named attribute is a needle; the rest are not', () => {
    const needles = secretNameNeedlesOf(
      'Child',
      stackRow(['Outputs.RoleName', 'Outputs.RoleArn', 'Outputs.Masked', 'Outputs.Ref']),
      undefined
    );
    // The mask is no name, and a reference is masked by its own arm.
    expect([...(needles ?? [])].sort()).toEqual([ROLE_ARN, ROLE_NAME].sort());
  });

  it.each([
    ['absent (an older cdkd)', undefined],
    ['malformed', 'Outputs.RoleName'],
    ['empty', []],
    ['naming no attribute the row holds', ['Outputs.Gone']],
  ])('no needle when the field is %s', (_l, field) => {
    expect(secretNameNeedlesOf('Child', stackRow(field), undefined)).toBeUndefined();
  });

  it('only an AWS::CloudFormation::Stack record takes the arm', () => {
    const row = { ...stackRow(['Outputs.RoleName']), resourceType: 'AWS::SSM::Parameter' };
    expect(secretNameNeedlesOf('Child', row, undefined)).toBeUndefined();
  });

  it("every state reader reaches the arm: a reader's judge, the stored side, the records' bag, destroy", () => {
    const resources = {
      Child: stackRow(['Outputs.RoleName']),
      // A reader storing what it read (its old side on a diff).
      Reader: record('reader-param', 'AWS::SSM::Parameter', { Value: `${ROLE_NAME}:x` }),
    };
    expect(stateSecretNameNeedles(resources)('Child')).toEqual(new Set([ROLE_NAME]));
    expect([...printingCorpusOf(storedSecretNameNeedles(resources, undefined)).keys()]).toEqual([
      ROLE_NAME,
    ]);
    expect([...printingCorpusOf(secretNamedRecordNeedles(resources, undefined)).keys()]).toEqual([
      ROLE_NAME,
    ]);
    // Destroy: the reader's delete masks what it read from the row.
    const bag = secretNamePrintingBags(resources, undefined)('Reader');
    expect(maskSecretsInText(`Deleting Reader of ${ROLE_NAME}:x`, bag)).toBe(
      'Deleting Reader of ***:x'
    );
    // Negative control: without the field, nothing is judged.
    const unnamed = { ...resources, Child: stackRow() };
    expect(stateSecretNameNeedles(unnamed)('Child')).toBeUndefined();
    expect(printingCorpusOf(storedSecretNameNeedles(unnamed, undefined)).size).toBe(0);
  });
});

describe("item 2: which of a row's outputs hold a child's secret-derived name (go-to-k/cdkd#3869)", () => {
  const attributes = {
    'Outputs.RoleName': ROLE_NAME,
    'Outputs.RoleArn': ROLE_ARN,
    'Outputs.Plain': 'plain-output-value',
  };

  it('names an output holding a rewritten name taken from a secret reference', () => {
    const child = {
      Role: record(ROLE_NAME, 'AWS::IAM::Role', {
        RoleName: '{{resolve:secretsmanager:team:SecretString:role::}}',
      }),
    };
    expect(secretNamedAttributeNamesOf(attributes, child, undefined)).toEqual([
      'Outputs.RoleArn',
      'Outputs.RoleName',
    ]);
  });

  it("names a case-folded identifier judged with the row's bag", () => {
    const child = {
      Db: record('teamsecretdb', 'AWS::RDS::DBInstance', { DBInstanceIdentifier: 'TeamSecretDb' }),
    };
    const rowBag = new Map<string, string>();
    recordLogOnlyValue(rowBag, 'TeamSecretDb');
    const outputs = { 'Outputs.DbId': 'teamsecretdb', 'Outputs.Plain': 'x-plain' };
    expect(secretNamedAttributeNamesOf(outputs, child, rowBag)).toEqual(['Outputs.DbId']);
    // Premise: the plaintext record alone carries no evidence.
    expect(secretNamedAttributeNamesOf(outputs, child, undefined)).toEqual([]);
  });

  it('negative control: an ordinary child names nothing', () => {
    const child = { Role: record(ROLE_NAME, 'AWS::IAM::Role', { RoleName: ROLE_NAME }) };
    expect(secretNamedAttributeNamesOf(attributes, child, undefined)).toEqual([]);
  });
});

describe('item 3: what a record stores where a NoEcho parameter served it (go-to-k/cdkd#3869)', () => {
  const corpus = (bag: Map<string, string>): string[] => [...printingCorpusOf(bag).keys()].sort();

  it("records each leaf at today's coordinates WHOLE, a Number too", () => {
    const bag = recordedNoEchoValuesOf(
      {
        TopicName: { 'Fn::Sub': 'topic-${Short}' },
        Port: { Ref: 'PortParam' },
        Plain: 'literal',
      },
      { properties: { TopicName: 'topic-41', Port: 5432, Plain: 'literal' } },
      new Set(['Short', 'PortParam']),
      undefined
    );
    expect(corpus(bag)).toEqual(['5432', 'topic-41']);
  });

  it("unions the record's own noEchoLeaves, and skips the mask and a reference", () => {
    const bag = recordedNoEchoValuesOf(
      undefined,
      {
        properties: { A: 'old-name-a', B: '***', C: '{{resolve:ssm:/x}}', D: 'not-positioned' },
        noEchoLeaves: [['A'], ['B'], ['C']],
      },
      new Set(),
      undefined
    );
    expect(corpus(bag)).toEqual(['old-name-a']);
  });

  it('reads both branches of an Fn::If of unknown verdict, the selected one of a known', () => {
    const template = {
      Name: { 'Fn::If': ['Cond', { Ref: 'P' }, 'literal-name'] },
    };
    const props = { properties: { Name: 'stored-name' } };
    expect(corpus(recordedNoEchoValuesOf(template, props, new Set(['P']), undefined))).toEqual([
      'stored-name',
    ]);
    expect(corpus(recordedNoEchoValuesOf(template, props, new Set(['P']), { Cond: false }))).toEqual(
      []
    );
  });

  it('judges a name taken from a value since changed, and a short value, as secret-derived', () => {
    const resources = {
      Db: record('oldsecretdb1', 'AWS::RDS::DBInstance', { DBInstanceIdentifier: 'OldSecretDb1' }),
      Topic: record('arn:aws:sns:us-east-1:123456789012:topic-41', 'AWS::SNS::Topic', {
        TopicName: 'topic-41',
      }),
    };
    const templates: Record<string, unknown> = {
      Db: { DBInstanceIdentifier: { Ref: 'DbIdParam' } },
      Topic: { TopicName: { 'Fn::Sub': 'topic-${Short}' } },
    };
    // Today's bound values: neither spells the stored names.
    const bound = new Map<string, string>();
    recordLogOnlyValue(bound, 'NewSecretDb2');
    recordLogOnlyValue(bound, '42');
    const names = new Set(['DbIdParam', 'Short']);
    const judge = namingSecretsWithRecordedNoEcho(bound, (id) =>
      recordedNoEchoValuesOf(templates[id], resources[id as keyof typeof resources], names, undefined)
    );
    const bags = secretNamePrintingBags(resources, judge);
    expect(maskSecretsInText('Deleting Db oldsecretdb1', bags('Db'))).toBe('Deleting Db ***');
    expect(
      maskSecretsInText('Deleting Topic arn:aws:sns:us-east-1:123456789012:topic-41', bags('Topic'))
    ).not.toContain('topic-41');
    // Premise: the bound values alone judge neither.
    const unjudged = secretNamePrintingBags(resources, bound);
    expect(maskSecretsInText('Deleting Db oldsecretdb1', unjudged('Db'))).toBe(
      'Deleting Db oldsecretdb1'
    );
    expect(
      maskSecretsInText('Deleting Topic arn:aws:sns:us-east-1:123456789012:topic-41', unjudged('Topic'))
    ).toContain('topic-41');
    // The other readers take the same per-record judge.
    expect(stateSecretNameNeedles(resources, judge)('Db')).toContain('oldsecretdb1');
    expect(stateSecretNameNeedles(resources, bound)('Db')).toBeUndefined();
  });
});
