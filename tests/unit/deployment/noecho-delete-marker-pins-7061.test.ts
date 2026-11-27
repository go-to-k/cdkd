/**
 * go-to-k/cdkd#7061: pins for the NoEcho delete re-resolution's marker arms,
 * which no other test reached. A delete sends the re-resolved value to AWS in
 * place of the record's mask, so a weakened check here sends the mask, or a
 * value read from a reference the destroy must not resolve.
 */
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => child };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import {
  TemplateNoEchoReresolver,
  maskedNoEchoCoordinates,
} from '../../../src/deployment/noecho-delete-reresolution.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const VALUE = 'noecho-default-7061';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

function template(token: unknown, secretDefault: string = VALUE): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: true, Default: secretDefault } },
    Resources: { Cr: { Type: 'Custom::Seed', Properties: { ServiceToken: TOKEN, Token: token } } },
  } as CloudFormationTemplate;
}

const record: ResourceState = {
  physicalId: 'phys',
  resourceType: 'Custom::Seed',
  properties: { ServiceToken: TOKEN, Token: SECRET_MASK },
  attributes: {},
  dependencies: [],
  noEchoLeaves: [['Token']],
};

const reresolver = (t: CloudFormationTemplate): TemplateNoEchoReresolver =>
  new TemplateNoEchoReresolver({ template: t, stackName: 'S', region: 'us-east-1' });

afterEach(() => vi.restoreAllMocks());

describe('maskedNoEchoCoordinates: only a coordinate holding the mask (#7061)', () => {
  it('leaves out a recorded coordinate whose value is plain', () => {
    expect(
      maskedNoEchoCoordinates({ A: SECRET_MASK, B: 'plain', C: ['x', SECRET_MASK] }, [['A'], ['B'], ['C']])
    ).toEqual([['A'], ['C']]);
  });
});

describe('TemplateNoEchoReresolver.valuesFor (#7061)', () => {
  it('a plain string leaf naming a dynamic reference is refused before anything resolves it', async () => {
    const resolve = vi.spyOn(IntrinsicFunctionResolver.prototype, 'resolve');
    const t = template({ 'Fn::Join': ['', [{ Ref: 'Secret' }, '{{resolve:ssm:/p}}']] });
    expect(await reresolver(t).valuesFor('Cr', record)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('the same leaf without one resolves (control)', async () => {
    const t = template({ 'Fn::Join': ['', [{ Ref: 'Secret' }, '-tail']] });
    expect((await reresolver(t).valuesFor('Cr', record))?.leaves).toEqual([
      { coordinate: ['Token'], value: `${VALUE}-tail` },
    ]);
  });

  it('a coordinate that re-resolves to the mask itself is not handed to the delete', async () => {
    const t = template({ Ref: 'Secret' }, SECRET_MASK);
    expect(await reresolver(t).valuesFor('Cr', record)).toBeUndefined();
  });
});
