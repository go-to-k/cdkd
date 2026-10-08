import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * go-to-k/cdkd#4682: what a template-holding delete re-resolves at a record's
 * masked `noEchoLeaves` coordinates, and every case that must answer
 * "nothing" (fail-closed) so the custom resource's delete stays skipped.
 */
const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => void logged.push(args.map(String).join(' '));
  const child = { debug: record, info: record, warn: record, error: record, child: () => child };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import {
  TemplateNoEchoReresolver,
  applyNoEchoDeleteValues,
  noEchoDeleteValuesFromResolved,
} from '../../../src/deployment/noecho-delete-reresolution.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';

const VALUE = 'parent-noecho-default-4682';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

function template(properties: Record<string, unknown>, extra: Partial<CloudFormationTemplate> = {}) {
  return {
    Parameters: {
      Secret: { Type: 'String', NoEcho: true, Default: VALUE },
      Plain: { Type: 'String', Default: 'plain' },
    },
    Resources: {
      Cr: { Type: 'Custom::Seed', Properties: { ServiceToken: TOKEN, ...properties } },
      Producer: { Type: 'Custom::Producer', Properties: { ServiceToken: TOKEN } },
    },
    ...extra,
  } as CloudFormationTemplate;
}

function record(
  properties: Record<string, unknown>,
  noEchoLeaves: (string | number)[][],
  resourceType = 'Custom::Seed'
): ResourceState {
  return {
    physicalId: 'phys',
    resourceType,
    properties: { ServiceToken: TOKEN, ...properties },
    attributes: {},
    dependencies: [],
    noEchoLeaves,
  };
}

const reresolver = (t: CloudFormationTemplate): TemplateNoEchoReresolver =>
  new TemplateNoEchoReresolver({ template: t, stackName: 'S', region: 'us-east-1' });

describe('TemplateNoEchoReresolver.valuesFor (cdkd destroy)', () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it('re-resolves a Ref, an Fn::Join and an Fn::Sub of a NoEcho parameter from today\'s template', async () => {
    const t = template({
      Token: { Ref: 'Secret' },
      Joined: { 'Fn::Join': ['', ['pre-', { Ref: 'Secret' }, '-', { Ref: 'Plain' }]] },
      Nested: { Sub: { 'Fn::Sub': 'x-${Secret}-${AWS::Region}' } },
    });
    const r = record(
      { Token: SECRET_MASK, Joined: SECRET_MASK, Nested: { Sub: SECRET_MASK } },
      [['Token'], ['Joined'], ['Nested', 'Sub']]
    );
    const values = await reresolver(t).valuesFor('Cr', r);
    expect(values?.leaves).toEqual([
      { coordinate: ['Token'], value: VALUE },
      { coordinate: ['Joined'], value: `pre-${VALUE}-plain` },
      { coordinate: ['Nested', 'Sub'], value: `x-${VALUE}-us-east-1` },
    ]);
    // The masker covers the value and what was built from it.
    expect(values!.maskSecrets(`got ${VALUE} and pre-${VALUE}-plain`)).not.toContain(VALUE);
    const { payload, unresolved } = applyNoEchoDeleteValues(r.properties, r.noEchoLeaves, values);
    expect(unresolved).toEqual([]);
    expect(payload).toMatchObject({ Token: VALUE, Nested: { Sub: `x-${VALUE}-us-east-1` } });
    expect(r.properties['Token']).toBe(SECRET_MASK);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it.each([
    ['the resource is no longer in the template', 'Gone', 'Custom::Seed'],
    ['the resource changed type', 'Cr', 'Custom::Other'],
  ])('answers nothing when %s', async (_label, logicalId, type) => {
    const t = template({ Token: { Ref: 'Secret' } });
    const values = await reresolver(t).valuesFor(
      logicalId,
      record({ Token: SECRET_MASK }, [['Token']], type)
    );
    expect(values).toBeUndefined();
  });

  it.each([
    ['an attribute a producer declared NoEcho', { 'Fn::GetAtt': ['Producer', 'Secret'] }],
    ['a parameter no longer declared NoEcho', { Ref: 'Plain' }],
    ['a literal', 'now-a-literal'],
    ['a resource reference beside the parameter', { 'Fn::Join': ['', [{ Ref: 'Secret' }, { Ref: 'Producer' }]] }],
    ['a condition', { 'Fn::If': ['C', { Ref: 'Secret' }, 'x'] }],
    ['a dynamic reference', { 'Fn::Join': ['', [{ Ref: 'Secret' }, '{{resolve:ssm:/p}}']] }],
    ['a GetAtt-style Sub variable', { 'Fn::Sub': '${Secret}-${Producer.Arn}' }],
  ])('does not re-resolve a coordinate today\'s template fills from %s', async (_label, node) => {
    const t = template({ Token: node });
    const values = await reresolver(t).valuesFor('Cr', record({ Token: SECRET_MASK }, [['Token']]));
    expect(values).toBeUndefined();
  });

  it('does not re-resolve from a template a macro would rewrite', () => {
    expect(TemplateNoEchoReresolver.usable(template({}, { Transform: 'AWS::Serverless-2016-10-31' } as never))).toBe(false);
    expect(TemplateNoEchoReresolver.usable(template({}))).toBe(true);
    expect(TemplateNoEchoReresolver.usable(undefined)).toBe(false);
  });

  it('answers nothing when the template parameters cannot be bound', async () => {
    const t = template({ Token: { Ref: 'Secret' } });
    (t.Parameters as Record<string, unknown>)['Required'] = { Type: 'String' };
    const values = await reresolver(t).valuesFor('Cr', record({ Token: SECRET_MASK }, [['Token']]));
    expect(values).toBeUndefined();
  });

  it('returns a partial answer, which the payload helper reports as unresolved', async () => {
    const t = template({ Token: { Ref: 'Secret' }, Attr: { 'Fn::GetAtt': ['Producer', 'X'] } });
    const r = record({ Token: SECRET_MASK, Attr: SECRET_MASK }, [['Token'], ['Attr']]);
    const values = await reresolver(t).valuesFor('Cr', r);
    expect(values?.leaves).toEqual([{ coordinate: ['Token'], value: VALUE }]);
    expect(applyNoEchoDeleteValues(r.properties, r.noEchoLeaves, values).unresolved).toEqual([
      ['Attr'],
    ]);
  });
});

describe('TemplateNoEchoReresolver.forNestedChild (a nested child inheriting a NoEcho value)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-4682-'));
    logged.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-resolves the child's coordinate from the value its parent's row hands it", async () => {
    const childTemplate = {
      Parameters: { ChildSecret: { Type: 'String' }, ChildPlain: { Type: 'String' } },
      Resources: {
        ChildCr: {
          Type: 'Custom::Seed',
          Properties: {
            ServiceToken: TOKEN,
            Token: { 'Fn::Sub': '${ChildSecret}:${ChildPlain}' },
          },
        },
      },
    };
    const childPath = path.join(dir, 'child.template.json');
    fs.writeFileSync(childPath, JSON.stringify(childTemplate));
    const parentTemplate = {
      Parameters: { Secret: { Type: 'String', NoEcho: true, Default: VALUE } },
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://example.com/child.json',
            Parameters: { ChildSecret: { Ref: 'Secret' }, ChildPlain: 'p' },
          },
        },
      },
    } as CloudFormationTemplate;
    const parent = new TemplateNoEchoReresolver({
      template: parentTemplate,
      stackName: 'Parent',
      region: 'us-east-1',
      nestedTemplates: { Child: childPath },
    });
    const row: ResourceState = {
      physicalId: 'arn:child',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {
        TemplateURL: 'https://example.com/child.json',
        Parameters: { ChildSecret: SECRET_MASK, ChildPlain: 'p' },
      },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Parameters', 'ChildSecret']],
    };
    const rowValues = await parent.valuesFor('Child', row);
    expect(rowValues?.leaves).toEqual([{ coordinate: ['Parameters', 'ChildSecret'], value: VALUE }]);

    const load = (p: string) => ({
      template: JSON.parse(fs.readFileSync(p, 'utf-8')) as CloudFormationTemplate,
      nestedTemplates: {},
    });
    const extract = (props: Record<string, unknown>) =>
      props['Parameters'] as Record<string, string>;
    const child = await parent.forNestedChild(
      'Child',
      { properties: row.properties, noEchoLeaves: row.noEchoLeaves, values: rowValues },
      'Parent-Child',
      load,
      extract
    );
    expect(child).toBeDefined();
    const childValues = await child!.valuesFor('ChildCr', {
      physicalId: 'p',
      resourceType: 'Custom::Seed',
      properties: { ServiceToken: TOKEN, Token: SECRET_MASK },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Token']],
    });
    expect(childValues?.leaves).toEqual([{ coordinate: ['Token'], value: `${VALUE}:p` }]);
    expect(childValues!.maskSecrets(`x ${VALUE} y`)).not.toContain(VALUE);

    // The parent could NOT re-resolve the row: the child refuses to read the
    // parameter still holding the mask, rather than sending it.
    const blind = await parent.forNestedChild(
      'Child',
      { properties: row.properties, noEchoLeaves: row.noEchoLeaves, values: undefined },
      'Parent-Child',
      load,
      extract
    );
    expect(
      await blind!.valuesFor('ChildCr', {
        physicalId: 'p',
        resourceType: 'Custom::Seed',
        properties: { ServiceToken: TOKEN, Token: SECRET_MASK },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Token']],
      })
    ).toBeUndefined();
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it('answers nothing for a row with no child template on disk', async () => {
    const parent = new TemplateNoEchoReresolver({
      template: template({}),
      stackName: 'Parent',
      region: 'us-east-1',
      nestedTemplates: { Child: path.join(dir, 'missing.json') },
    });
    const child = await parent.forNestedChild(
      'Child',
      { properties: {}, noEchoLeaves: [], values: undefined },
      'Parent-Child',
      () => {
        throw new Error('not reached');
      },
      () => ({})
    );
    expect(child).toBeUndefined();
  });
});

describe('noEchoDeleteValuesFromResolved (a deploy replacing a resource still in its template)', () => {
  const base = {
    templateResource: { Type: 'Custom::Seed', Properties: { ServiceToken: TOKEN, Token: { Ref: 'Secret' } } },
    resolvedProperties: { ServiceToken: TOKEN, Token: VALUE },
    noEchoParameters: new Set(['Secret']),
    secrets: new Map<string, string>(),
  };

  it("takes today's resolved value at a coordinate the template serves from a NoEcho parameter", () => {
    const values = noEchoDeleteValuesFromResolved({
      ...base,
      record: record({ Token: SECRET_MASK }, [['Token']]),
    });
    expect(values?.leaves).toEqual([{ coordinate: ['Token'], value: VALUE }]);
    expect(values!.maskSecrets(`v=${VALUE}`)).toBe(`v=${SECRET_MASK}`);
  });

  it.each([
    ['the template no longer has the resource', { templateResource: undefined }],
    ['the type changed', { templateResource: { ...base.templateResource, Type: 'Custom::Other' } }],
    ['the parameter is no longer NoEcho', { noEchoParameters: new Set<string>() }],
    ['the resolved bag holds the mask', { resolvedProperties: { ServiceToken: TOKEN, Token: SECRET_MASK } }],
  ])('answers nothing when %s', (_label, override) => {
    expect(
      noEchoDeleteValuesFromResolved({
        ...base,
        ...override,
        record: record({ Token: SECRET_MASK }, [['Token']]),
      } as never)
    ).toBeUndefined();
  });
});

describe('review round 1 (PR #4742)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-4682-r1-'));
    logged.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const crRecord = (token: unknown = SECRET_MASK): ResourceState => ({
    physicalId: 'p',
    resourceType: 'Custom::Seed',
    properties: { ServiceToken: TOKEN, Token: token },
    attributes: {},
    dependencies: [],
    noEchoLeaves: [['Token']],
  });
  const load = (p: string) => ({
    template: JSON.parse(fs.readFileSync(p, 'utf-8')) as CloudFormationTemplate,
    nestedTemplates: {},
  });
  // What `NestedStackProvider.extractParameters` does to a list: joins it.
  const extract = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries((props['Parameters'] ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.join(',') : String(v),
      ])
    );
  function child(
    childTemplate: Record<string, unknown>,
    parentTemplate: CloudFormationTemplate
  ): TemplateNoEchoReresolver {
    const childPath = path.join(dir, 'child.json');
    fs.writeFileSync(childPath, JSON.stringify(childTemplate));
    return new TemplateNoEchoReresolver({
      template: parentTemplate,
      stackName: 'Parent',
      region: 'us-east-1',
      nestedTemplates: { Child: childPath },
    });
  }

  it('C1: a row list parameter the parent could not re-resolve is refused, never sent as "***,***"', async () => {
    const parent = child(
      {
        Parameters: { ChildList: { Type: 'String' } },
        Resources: {
          ChildCr: {
            Type: 'Custom::Seed',
            Properties: { ServiceToken: TOKEN, Token: { Ref: 'ChildList' } },
          },
        },
      },
      template({})
    );
    const nested = await parent.forNestedChild(
      'Child',
      {
        properties: { Parameters: { ChildList: [SECRET_MASK, SECRET_MASK] } },
        noEchoLeaves: [['Parameters', 'ChildList']],
        values: undefined,
      },
      'Parent-Child',
      load,
      extract
    );
    expect(await nested!.valuesFor('ChildCr', crRecord())).toBeUndefined();
  });

  it("M1: the child's masker covers a parent NoEcho value the row EMBEDS", async () => {
    const parentTemplate = {
      Parameters: { Secret: { Type: 'String', NoEcho: true, Default: VALUE } },
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: { Conn: { 'Fn::Join': ['', ['user:', { Ref: 'Secret' }, '@host']] } },
          },
        },
      },
    } as CloudFormationTemplate;
    const parent = child(
      {
        Parameters: { Conn: { Type: 'String' } },
        Resources: {
          ChildCr: {
            Type: 'Custom::Seed',
            Properties: { ServiceToken: TOKEN, Token: { Ref: 'Conn' } },
          },
        },
      },
      parentTemplate
    );
    const row: ResourceState = {
      physicalId: 'arn:child',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: { Conn: SECRET_MASK } },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Parameters', 'Conn']],
    };
    const rowValues = await parent.valuesFor('Child', row);
    const nested = await parent.forNestedChild(
      'Child',
      { properties: row.properties, noEchoLeaves: row.noEchoLeaves, values: rowValues },
      'Parent-Child',
      load,
      extract
    );
    const values = await nested!.valuesFor('ChildCr', crRecord());
    expect(values?.leaves[0]?.value).toBe(`user:${VALUE}@host`);
    expect(values!.maskSecrets(`auth failed for ${VALUE}`)).not.toContain(VALUE);
  });

  it("M2: a property whose template text changed since the deploy is refused; the same text is accepted", async () => {
    const deployed = { Ref: 'Secret' };
    const today = template({ Token: { Ref: 'Secret' } });
    const recordWith = (fp: string): ResourceState => ({
      ...record({ Token: SECRET_MASK }, [['Token']]),
      maskedPropertyFingerprints: { Token: fp },
    });
    const same = await reresolver(today).valuesFor('Cr', recordWith(maskedPropertyFingerprint(deployed)));
    expect(same?.leaves).toEqual([{ coordinate: ['Token'], value: VALUE }]);
    const moved = await reresolver(today).valuesFor(
      'Cr',
      recordWith(maskedPropertyFingerprint({ Ref: 'OtherSecret' }))
    );
    expect(moved).toBeUndefined();
    expect(
      noEchoDeleteValuesFromResolved({
        record: recordWith(maskedPropertyFingerprint({ Ref: 'OtherSecret' })),
        templateResource: today.Resources['Cr'] as never,
        resolvedProperties: { ServiceToken: TOKEN, Token: VALUE },
        noEchoParameters: new Set(['Secret']),
        secrets: new Map(),
      })
    ).toBeUndefined();
  });

  it('N1: a deploy whose resource bag holds a resolved secret hands the delete nothing', () => {
    expect(
      noEchoDeleteValuesFromResolved({
        record: record({ Token: SECRET_MASK }, [['Token']]),
        templateResource: { Type: 'Custom::Seed', Properties: { Token: { Ref: 'Secret' } } },
        resolvedProperties: { Token: VALUE },
        noEchoParameters: new Set(['Secret']),
        secrets: new Map([['secure-plaintext', '{{resolve:ssm:/p}}']]),
      })
    ).toBeUndefined();
  });

  it.each([
    ['Fn::Select', { 'Fn::Select': [1, ['a', { Ref: 'Secret' }]] }, VALUE],
    ['Fn::Split', { 'Fn::Select': [0, { 'Fn::Split': ['-', { Ref: 'Secret' }] }] }, VALUE.split('-')[0]],
    ['Fn::Base64', { 'Fn::Base64': { Ref: 'Secret' } }, Buffer.from(VALUE).toString('base64')],
    ['Ref AWS::Partition', { 'Fn::Join': [':', [{ Ref: 'AWS::Partition' }, { Ref: 'Secret' }]] }, `aws:${VALUE}`],
  ])('re-resolves an allowed expression: %s', async (_label, node, expected) => {
    const values = await reresolver(template({ Token: node })).valuesFor(
      'Cr',
      record({ Token: SECRET_MASK }, [['Token']])
    );
    expect(values?.leaves).toEqual([{ coordinate: ['Token'], value: expected }]);
  });

  it.each([
    ['a resource reference beside the parameter', { 'Fn::Join': ['', [{ Ref: 'Secret' }, { Ref: 'Producer' }]] }],
    ['a GetAtt-style Sub variable', { 'Fn::Sub': '${Secret}-${Producer.Arn}' }],
    ['AWS::StackId', { 'Fn::Join': ['', [{ Ref: 'Secret' }, { Ref: 'AWS::StackId' }]] }],
    ['AWS::NoValue', { 'Fn::Join': ['', [{ Ref: 'Secret' }, { Ref: 'AWS::NoValue' }]] }],
    ['a Condition key', { 'Fn::Join': ['', [{ Ref: 'Secret' }]], Condition: 'C' }],
    ['a dynamic reference in Sub text', { 'Fn::Sub': '${Secret}{{resolve:ssm:/p}}' }],
    ['a Sub whose variable map is not an object', { 'Fn::Sub': ['${Secret}', 'x'] }],
  ])('refuses %s BEFORE resolving anything', async (_label, node) => {
    const resolve = vi.spyOn(IntrinsicFunctionResolver.prototype, 'resolve');
    const values = await reresolver(template({ Token: node })).valuesFor(
      'Cr',
      record({ Token: SECRET_MASK }, [['Token']])
    );
    expect(values).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
