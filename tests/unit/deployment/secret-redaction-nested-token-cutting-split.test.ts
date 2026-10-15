/**
 * `Fn::Split` on a delimiter that occurs inside a `{{resolve:...}}` token's
 * TEXT (issue [#4914](https://github.com/go-to-k/cdkd/issues/4914)). `:` is in
 * every token, so a comparison pass splitting a secret-bearing value on it cut
 * the token into fragments (`//{{resolve`) that no persisted value holds: an
 * UPDATE on every deploy, a REPLACEMENT on a create-only property.
 *
 * The nested-stack cases drive the REAL resolver, the REAL
 * `redactSecretsForState` and the REAL `redactParametersForDiff`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  inheritNestedStackParameterAssociations,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../src/deployment/intrinsic-resolver/parameter-secrets.js';
import {
  rereadParameterExpression,
  splitOutsideDynamicReferences,
} from '../../../src/deployment/secret-redaction/nested-stack.js';
import { redactParametersForDiff } from '../../../src/deployment/deploy-engine/masking.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

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

const PW_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:cutpw::}}';
const SIBLING_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:cutpw:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:cutuser::}}';
const PW = 'pw-cut-pl4intext-4914';
const USER = 'us3r-cut-4914';
const CONN_PARAM = 'Conn';
const SIBLING_PARAM = 'Sibling';
const SPELLING = `postgres://${USER_EXPR}:${PW_EXPR}@host`;
const CONN = `postgres://${USER}:${PW}@host`;

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

/** The issue's two read shapes: a piece (a string leaf) and the list itself. */
const PIECE = { 'Fn::Select': [1, { 'Fn::Split': [':', { Ref: CONN_PARAM }] }] };
const LIST = { 'Fn::Split': [':', { Ref: CONN_PARAM }] };
const PIECE_ANSWER = `//${USER_EXPR}`;
const LIST_ANSWER = ['postgres', `//${USER_EXPR}`, `${PW_EXPR}@host`];

function childTemplate(properties: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { [CONN_PARAM]: { Type: 'String' }, [SIBLING_PARAM]: { Type: 'String' } },
    Resources: { Leaf: { Type: 'AWS::SSM::Parameter', Properties: properties } },
  } as CloudFormationTemplate;
}

/**
 * One parent row's bag. `withSibling` adds a same-plaintext sibling parameter;
 * `reversed` resolves `Conn` first, so the sibling's token survives the map.
 */
function parentRow(
  reversed: boolean,
  withSibling: boolean
): { parent: RecordedSecretValues; parameters: Record<string, unknown> } {
  const conn = [
    [USER_EXPR, USER],
    [PW_EXPR, PW],
  ] as const;
  const sibling = withSibling ? [[SIBLING_EXPR, PW] as const] : [];
  const order = reversed ? [...conn, ...sibling] : [...sibling, ...conn];
  const parent: RecordedSecretValues = new Map();
  for (const [expression, plaintext] of order) {
    parent.set(plaintext, expression);
    recordResolvedPair(parent, expression, plaintext);
  }
  const parameters: Record<string, unknown> = { [CONN_PARAM]: CONN };
  const spellings: Record<string, unknown> = { [CONN_PARAM]: SPELLING };
  if (withSibling) {
    parameters[SIBLING_PARAM] = PW;
    spellings[SIBLING_PARAM] = SIBLING_EXPR;
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: parameters },
    { Parameters: spellings }
  );
  return { parent, parameters };
}

/** Persist one resource of the child as the deploy does, and its diff side. */
async function persistAndDesired(
  parent: RecordedSecretValues,
  parameters: Record<string, unknown>,
  properties: Record<string, unknown>
): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
  const template = childTemplate(properties);
  const recordedSecretValues = new Map<string, string>();
  inheritNestedStackParameterAssociations(recordedSecretValues, parent);
  const resolved = await resolver.resolve(properties, {
    template,
    resources: {},
    parameters,
    recordedSecretValues,
    inheritedSecrets: parent,
  } as unknown as ResolverContext);
  const persisted = redactSecretsForState(resolved, recordedSecretValues, properties) as Record<
    string,
    unknown
  >;
  const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
  const diffContext = {
    template,
    resources: {},
    parameters: redactParametersForDiff.call(engine, parameters),
    // As `buildResolverContext` sets it on the deploy's diff context.
    inheritedSecrets: parent,
    skipDynamicReferences: true,
  } as unknown as ResolverContext;
  // One top-level key at a time, as `DiffCalculator.resolveBestEffort` does.
  const desired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    desired[key] = await resolver.resolve(structuredClone(value), diffContext);
  }
  return { persisted, desired };
}

describe('a nested child leaf splitting a secret-bearing parameter inside its token text (#4914)', () => {
  for (const withSibling of [false, true]) {
    for (const reversed of [true, false]) {
      const label = `${withSibling ? 'with' : 'no'} sibling in the parent, ${reversed ? 'reversed' : 'forward'} parent order`;
      it(`the diff side computes the persisted piece (${label})`, async () => {
        const { parent, parameters } = parentRow(reversed, withSibling);
        const { persisted, desired } = await persistAndDesired(parent, parameters, { V: PIECE });
        expect(persisted['V']).toBe(PIECE_ANSWER);
        expect(desired).toEqual(persisted);
      });

      it(`the diff side computes the persisted list (${label})`, async () => {
        const { parent, parameters } = parentRow(reversed, withSibling);
        const { persisted, desired } = await persistAndDesired(parent, parameters, { V: LIST });
        expect(persisted['V']).toEqual(LIST_ANSWER);
        expect(desired).toEqual(persisted);
      });
    }
  }

  // The same resource reading the same-plaintext sibling too: the child bag's
  // slot for `PW` holds whichever parameter resolved last, so the leaf agrees
  // only because the persist walk re-reads it (`positionByParameterReread`)
  // with the split the diff side uses, and nothing is withdrawn.
  for (const reversed of [true, false]) {
    for (const siblingLast of [true, false]) {
      for (const [shape, read] of Object.entries({ piece: PIECE, list: LIST })) {
        it(`agrees beside a sibling read (${shape}, ${reversed ? 'reversed' : 'forward'}, ${siblingLast ? 'sibling' : 'Conn'} read last)`, async () => {
          const { parent, parameters } = parentRow(reversed, true);
          const sibling = { Ref: SIBLING_PARAM };
          const properties = siblingLast ? { V: read, S: sibling } : { S: sibling, V: read };
          poisonRenderedSpellingsCollidingIn(childTemplate(properties), parameters, parent);
          expect(redactInheritedParameterValue(parent, CONN_PARAM, CONN)).toBe(SPELLING);
          const { persisted, desired } = await persistAndDesired(parent, parameters, properties);
          expect(desired).toEqual(persisted);
          expect(persisted['S']).toBe(SIBLING_EXPR);
          expect(persisted['V']).toEqual(shape === 'piece' ? PIECE_ANSWER : LIST_ANSWER);
        });
      }
    }
  }

  it('agrees for a leaf in plain objects and arrays, and an Fn::Join over a piece', async () => {
    const { parent, parameters } = parentRow(true, false);
    const properties = { O: { K: [PIECE, 'lit'] }, J: { 'Fn::Join': ['|', [PIECE, 'x']] } };
    const { persisted, desired } = await persistAndDesired(parent, parameters, properties);
    expect(persisted).toEqual({ O: { K: [PIECE_ANSWER, 'lit'] }, J: `${PIECE_ANSWER}|x` });
    expect(desired).toEqual(persisted);
  });

  // A child parameter holding token TEXT the parent did not resolve (its own
  // value, or one the parent passed through as text): the child's real pass
  // splits it as text, and so does its diff side.
  it('splits token text no parent pair stands behind, as the real pass does', async () => {
    const { parent, parameters } = parentRow(true, false);
    const raw = 'a:{{resolve:secretsmanager:never/resolved:SecretString:k::}}';
    const withRaw = { ...parameters, [SIBLING_PARAM]: raw };
    const read = { 'Fn::Select': [1, { 'Fn::Split': [':', { Ref: SIBLING_PARAM }] }] };
    const { persisted, desired } = await persistAndDesired(parent, withRaw, { V: read });
    expect(persisted['V']).toBe('{{resolve');
    expect(desired).toEqual(persisted);
  });

  it('puts no plaintext, whole or cut, on the diff side', async () => {
    const { parent, parameters } = parentRow(true, false);
    const { desired } = await persistAndDesired(parent, parameters, { V: LIST, P: PIECE });
    const text = JSON.stringify(desired);
    for (const plaintext of [USER, PW]) {
      for (let cut = 4; cut <= plaintext.length; cut++) {
        expect(text).not.toContain(plaintext.slice(0, cut));
        expect(text).not.toContain(plaintext.slice(plaintext.length - cut));
      }
    }
  });

  // The persist side's re-read certifies the token-whole piece only where it
  // renders back to the REAL piece: a plaintext holding the delimiter is cut
  // by the real split, and nothing is certified.
  it('certifies nothing where the delimiter occurs inside a plaintext', () => {
    const { parent } = parentRow(true, false);
    const colonUser = 'us3r:cut-4914';
    const colonParent: RecordedSecretValues = new Map();
    for (const [expression, plaintext] of [
      [USER_EXPR, colonUser],
      [PW_EXPR, PW],
    ] as const) {
      colonParent.set(plaintext, expression);
      recordResolvedPair(colonParent, expression, plaintext);
    }
    const value = `postgres://${colonUser}:${PW}@host`;
    recordNestedStackParameterExpressions(
      colonParent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [CONN_PARAM]: value } },
      { Parameters: { [CONN_PARAM]: SPELLING } }
    );
    const bind = (name: string): { value: unknown } | undefined =>
      name === CONN_PARAM ? { value } : undefined;
    expect(rereadParameterExpression(PIECE, bind, colonParent)).toBeUndefined();
    // The control: the same leaf over a colon-free plaintext certifies.
    const plainBind = (name: string): { value: unknown } | undefined =>
      name === CONN_PARAM ? { value: CONN } : undefined;
    expect(rereadParameterExpression(PIECE, plainBind, parent)).toEqual({
      resolved: `//${USER}`,
      redacted: PIECE_ANSWER,
    });
  });
});

describe('a top-level stack splitting a template literal holding secret tokens (#4914)', () => {
  const TOKEN_A = '{{resolve:secretsmanager:top/a:SecretString:k::}}';
  const TOKEN_B = '{{resolve:secretsmanager:top/b:SecretString:k::}}';
  const PLAIN_A = 'top-a-pl4intext-4914';
  const PLAIN_B = 'top-b-pl4intext-4914';
  const SOURCE = { 'Fn::Split': [':', `${TOKEN_A}:${TOKEN_B}`] };

  it('the diff side keeps each token whole, as the persist side writes the real pieces', async () => {
    const desired = await resolver.resolve(structuredClone(SOURCE), {
      template: { Resources: {} },
      resources: {},
      skipDynamicReferences: true,
    } as unknown as ResolverContext);
    // What the deploy's persist walk writes for the real pieces.
    const secrets: RecordedSecretValues = new Map([
      [PLAIN_A, TOKEN_A],
      [PLAIN_B, TOKEN_B],
    ]);
    const persisted = redactSecretsForState({ V: [PLAIN_A, PLAIN_B] }, secrets, { V: SOURCE });
    expect(persisted).toEqual({ V: [TOKEN_A, TOKEN_B] });
    expect(desired).toEqual([TOKEN_A, TOKEN_B]);
  });

  // `Fn::Join` and `Fn::Sub` re-resolve references in the string they
  // assemble, a token read through a `Ref` included, so the real pass splits
  // the plaintext and the diff side keeps the token whole -- CDK compiles a
  // template string interpolating a secret to `Fn::Join`.
  for (const [shape, value] of Object.entries({
    'an Fn::Join of literal parts': { 'Fn::Join': ['', ['postgres://u:', TOKEN_A, '@host']] },
    'an Fn::Sub': { 'Fn::Sub': `postgres://u:${TOKEN_A}@host` },
    'an Fn::Join over a Ref': { 'Fn::Join': ['', [{ Ref: 'P' }]] },
  })) {
    it(`keeps the token whole in a split of ${shape}`, async () => {
      const desired = await resolver.resolve(
        { 'Fn::Select': [2, { 'Fn::Split': [':', value] }] },
        {
          template: { Parameters: { P: { Type: 'String' } }, Resources: {} },
          resources: {},
          parameters: { P: `postgres://u:${TOKEN_A}@host` },
          skipDynamicReferences: true,
        } as unknown as ResolverContext
      );
      expect(desired).toBe(`${TOKEN_A}@host`);
    });
  }

  // Token TEXT the real pass passes through as text -- a `Ref` to a parameter
  // spelling one, an `Fn::FindInMap` value -- is split as text there, so the
  // comparison side must split it the same way.
  const RAW = `postgres://u:${TOKEN_A}@host`;
  const TEMPLATE = {
    Parameters: { P: { Type: 'String' } },
    Mappings: { M: { k: { v: RAW } } },
    Resources: {},
  };
  for (const [shape, read] of Object.entries({
    'a Ref to a parameter': { Ref: 'P' },
    'an Fn::FindInMap value': { 'Fn::FindInMap': ['M', 'k', 'v'] },
  })) {
    it(`splits token text read through ${shape} as the real pass does`, async () => {
      const source = { 'Fn::Select': [2, { 'Fn::Split': [':', read] }] };
      const context = { template: TEMPLATE, resources: {}, parameters: { P: RAW } };
      const real = await resolver.resolve(
        structuredClone(source),
        context as unknown as ResolverContext
      );
      const desired = await resolver.resolve(structuredClone(source), {
        ...context,
        skipDynamicReferences: true,
      } as unknown as ResolverContext);
      expect(real).toBe('{{resolve');
      expect(desired).toBe(real);
    });
  }

  it('a pass holding real values splits as CloudFormation does', async () => {
    // A provisioning-shaped context (no `skipDynamicReferences`) over a value
    // that happens to spell a token: a plain split, as before.
    const value = `x:${TOKEN_A}`;
    const resolved = await resolver.resolve(
      { 'Fn::Split': [':', { Ref: 'P' }] },
      {
        template: { Parameters: { P: { Type: 'String' } }, Resources: {} },
        resources: {},
        parameters: { P: value },
      } as unknown as ResolverContext
    );
    expect(resolved).toEqual(value.split(':'));
    // ...even where the token stands for an inherited secret: only a
    // comparison pass holds a token in its place.
    const inherited: RecordedSecretValues = new Map([[PLAIN_A, TOKEN_A]]);
    recordResolvedPair(inherited, TOKEN_A, PLAIN_A);
    const withPair = await resolver.resolve(
      { 'Fn::Split': [':', { Ref: 'P' }] },
      {
        template: { Parameters: { P: { Type: 'String' } }, Resources: {} },
        resources: {},
        parameters: { P: value },
        recordedSecretValues: new Map(),
        inheritedSecrets: inherited,
      } as unknown as ResolverContext
    );
    expect(withPair).toEqual(value.split(':'));
  });
});

describe('splitOutsideDynamicReferences', () => {
  const TOKEN = '{{resolve:secretsmanager:a:SecretString:k::}}';
  const SSM = '{{resolve:ssm:/p/q:1}}';
  const ANY = (): boolean => true;

  it('is a plain split over text with no token', () => {
    for (const [text, delimiter] of [
      ['a:b::c', ':'],
      ['', ':'],
      ['abc', 'b'],
      ['a--b--', '--'],
    ] as const) {
      expect(splitOutsideDynamicReferences(text, delimiter, ANY)).toEqual(text.split(delimiter));
    }
  });

  it('keeps every resolvable-service token whole', () => {
    expect(splitOutsideDynamicReferences(`a:${TOKEN}:${SSM}:b`, ':', ANY)).toEqual([
      'a',
      TOKEN,
      SSM,
      'b',
    ]);
    expect(splitOutsideDynamicReferences(`${TOKEN}${TOKEN}`, ':', ANY)).toEqual([`${TOKEN}${TOKEN}`]);
    expect(splitOutsideDynamicReferences(`:${TOKEN}:`, ':', ANY)).toEqual(['', TOKEN, '']);
  });

  it('skips an occurrence straddling a token boundary, and splits after it', () => {
    expect(splitOutsideDynamicReferences(`x${TOKEN}:y`, '}}:', ANY)).toEqual([`x${TOKEN}:y`]);
    expect(splitOutsideDynamicReferences(`${TOKEN}--y--z`, '--', ANY)).toEqual([TOKEN, 'y', 'z']);
  });

  it('splits a token of a service cdkd does not resolve, as the resolver leaves it', () => {
    const foreign = '{{resolve:other:x:y}}';
    expect(splitOutsideDynamicReferences(`a:${foreign}`, ':', ANY)).toEqual(`a:${foreign}`.split(':'));
  });

  it('splits a token its provenance test rejects, as text', () => {
    const other = '{{resolve:secretsmanager:b:SecretString:k::}}';
    expect(
      splitOutsideDynamicReferences(`a:${TOKEN}:${other}`, ':', (token) => token === TOKEN)
    ).toEqual(['a', TOKEN, ...other.split(':')]);
  });

  it('splits per character on an empty delimiter', () => {
    expect(splitOutsideDynamicReferences(`a${TOKEN}`, '', ANY)).toEqual(`a${TOKEN}`.split(''));
  });
});
