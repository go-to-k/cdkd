/**
 * Issue [#3156](https://github.com/go-to-k/cdkd/issues/3156): the sub-floor
 * nested-stack carry (`recordNestedStackParameterExpressions`) refused two
 * intrinsic spellings of a framed secret -- a token spelling `ssm:` (or leaving
 * its service to an intrinsic part), and a frame whose non-literal part sits
 * OUTSIDE the token -- so a 1-3 character secret in either persisted in
 * plaintext in the child, the parent's row (for the second), and a grandchild's
 * log lines. Issue [#3306](https://github.com/go-to-k/cdkd/issues/3306) carries
 * the three shapes that fix still refused: a token inside a nested part, in a
 * used `Fn::Sub` variable, or inside an `Fn::If` around the frame.
 *
 * Every case here but the hand-built records drives the REAL
 * resolver: the fix certifies on what the
 * resolver recorded while resolving the parameter's own `Fn::Join` / `Fn::Sub`
 * object (its substitution, and the verdict that substitution took), so a
 * hand-built bag would be building the thing under test. The deploy engine's
 * sequence is mirrored: resolve the row into the resource's bag, run the carry
 * over the SAME source object, then persist the row through
 * `redactSecretsForState` on a marked copy. A child mirrors the child engine:
 * its resource bag inherits the parent row's associations, and a `{ Ref }` to
 * the parameter resolves with the parent row's bag as `inheritedSecrets`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  inheritNestedStackParameterAssociations,
  MIN_NEEDLE_LENGTH,
  recordIntrinsicLeafResolution,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';

/** The sub-floor secret every reference below resolves to. */
const PIN = 'q7';

const SECRET_ID = 'cdkd-refused-frame-carry-probe';

/**
 * How many times `/app/flip` (unclassifiable first, then public) and
 * `/app/flop` (public first, then unclassifiable) have been read.
 */
const flipReads = vi.hoisted(() => ({ count: 0, flop: 0 }));

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        const name = command.input?.Name;
        // SecureStrings holding the pin under several names, so two leaves can
        // share a value through different tokens.
        if (name === '/app/pin' || name === '/app/dev' || name === '/app/a' || name === '/app/b') {
          return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        }
        if (name === '/other') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A parameter NAMED by an inherited secret (the #4130 review's M0): its
        // name reaches the token only after that secret is substituted in.
        if (name === '/app/pinname-long') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A secret whose value occurs in its own token's text (the #4130
        // review's M2): `in` inside `{{resolve:ssm:/app/kin}}`.
        if (name === '/app/kin') return { Parameter: { Value: 'in', Type: 'SecureString' } };
        // A SecureString whose value is itself reference text (issue #3306's
        // two-stage shape): the object's final pass resolves it again.
        if (name === '/app/ref') {
          return { Parameter: { Value: '{{resolve:ssm:/app/pin}}', Type: 'SecureString' } };
        }
        // A PUBLIC parameter holding the same two characters.
        if (name === '/app/prod') return { Parameter: { Value: 'q7', Type: 'String' } };
        // No `Type` first (unclassifiable: secret for that read, never cached),
        // then a definitive public answer with the same value.
        if (name === '/app/flip') {
          flipReads.count += 1;
          return flipReads.count === 1
            ? { Parameter: { Value: 'q7' } }
            : { Parameter: { Value: 'q7', Type: 'String' } };
        }
        if (name === '/app/flop') {
          flipReads.flop += 1;
          return flipReads.flop === 1
            ? { Parameter: { Value: 'q7', Type: 'String' } }
            : { Parameter: { Value: 'q7' } };
        }
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID) return { SecretString: JSON.stringify({ pin: 'q7' }) };
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const NESTED = 'AWS::CloudFormation::Stack';
const TEMPLATE_URL = 'https://s3.amazonaws.com/bucket/child.json';

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  flipReads.count = 0;
  flipReads.flop = 0;
  resetAccountInfoCache();
});

/**
 * A template declaring `values`' keys as String parameters, the values bound,
 * and two conditions.
 */
function contextFor(
  values: Record<string, string>,
  bag: RecordedSecretValues,
  inheritedSecrets?: RecordedSecretValues
) {
  return {
    template: {
      Parameters: Object.fromEntries(Object.keys(values).map((k) => [k, { Type: 'String' }])),
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: values,
    // For the `Fn::If` cases (issue #3306); no other case names a condition.
    conditions: { On: true, Off: false },
    recordedSecretValues: bag,
    ...(inheritedSecrets ? { inheritedSecrets } : {}),
  };
}

/**
 * One `AWS::CloudFormation::Stack` row through the engine's sequence: resolve
 * `parameters` into a fresh bag, run the carry over the same source object,
 * and persist the row. `inheritedSecrets` makes it a nested engine's row.
 */
async function deployRow(
  parameters: Record<string, unknown>,
  bound: Record<string, string> = {},
  inheritedSecrets?: RecordedSecretValues,
  // A resolver and a bag to reuse, and resolutions of the same row source to
  // run into that bag first (the cache and conflict cases).
  reuse: {
    resolver?: InstanceType<typeof IntrinsicFunctionResolver>;
    earlier?: ReadonlyArray<InstanceType<typeof IntrinsicFunctionResolver>>;
  } = {}
) {
  const bag: RecordedSecretValues = new Map();
  if (inheritedSecrets) inheritNestedStackParameterAssociations(bag, inheritedSecrets);
  const source = { TemplateURL: TEMPLATE_URL, Parameters: parameters };
  for (const earlier of reuse.earlier ?? []) {
    await earlier.resolve(source, contextFor(bound, bag, inheritedSecrets) as never);
  }
  const resolver = reuse.resolver ?? new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(source, contextFor(bound, bag, inheritedSecrets) as never)) as {
    Parameters: Record<string, unknown>;
  };
  recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
  const record = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true) as {
    Parameters: Record<string, unknown>;
  };
  return { bag, resolved, record };
}

/** A child resource consuming `name` through `{ Ref }`, persisted by the child engine's walk. */
async function childPersist(parentRowBag: RecordedSecretValues, name: string, value: string): Promise<unknown> {
  const bag: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(bag, parentRowBag);
  const source = { Value: { Ref: name } };
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(
    source,
    contextFor({ [name]: value }, bag, parentRowBag) as never
  )) as Record<string, unknown>;
  const record = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true) as {
    Value: unknown;
  };
  return record.Value;
}


/** No plaintext of the sub-floor secret outside a `{{resolve:...}}` token. */
function exposed(value: unknown): boolean {
  return String(value).split(/\{\{resolve:[^}]+\}\}/).join('\u0000').includes(PIN);
}

describe('a nested stack row: a sub-floor secret beside a parameter holding its text (#7050)', () => {
  const TOKEN = '{{resolve:ssm:/app/pin}}';
  for (const [label, source] of [
    ['a Join of a parameter, text and the reference', { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', TOKEN]] }],
    ['a Join of the reference, text and a parameter', { 'Fn::Join': ['', [TOKEN, '/', { Ref: 'Sep' }]] }],
    ['a Sub variable map', { 'Fn::Sub': ['${S}/${T}', { S: { Ref: 'Sep' }, T: TOKEN }] }],
  ] as const) {
    it(`${label}: neither the parent record nor the child holds the secret`, async () => {
      const { bag, resolved, record } = await deployRow({ X: source }, { Sep: PIN });
      expect(resolved.Parameters['X']).toContain(PIN);
      expect(exposed(record.Parameters['X'])).toBe(false);
      const child = await childPersist(bag, 'X', String(resolved.Parameters['X']));
      expect(exposed(child)).toBe(false);
    });
  }
});
