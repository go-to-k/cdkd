/**
 * go-to-k/cdkd#7158 / go-to-k/cdkd#7152: a secret an AWS readback echoes under
 * a key the template LACKS is masked in `observedProperties`, and the masked
 * coordinate is recorded in `observedMaskedLeaves`, so `cdkd drift` reports it
 * as not compared instead of as drift.
 *
 * The generated invariant walks position shapes (top level, nested, a list
 * element with and without an identity field, a list of strings) x value
 * forms (a `NoEcho` parameter whole, embedded, and under the needle floor
 * embedded in a longer leaf; an `ssm-secure` reference whole and embedded; a
 * `secretsmanager` one; two references with one plaintext) x writers (the
 * deploy persist and an unchanged resource's persist with a fresh readback),
 * through the REAL resolver and `redactStateForPersist`, and asserts:
 * - no plaintext reaches the record;
 * - every `***` the record holds under a key the template lacks is named by
 *   `observedMaskedLeaves` (else drift would report it forever);
 * - drift's partitions leave NO change against the live readback.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  markSameGenerationBag,
  observedMaskedLeavesOf,
  templateGetAttNamesOf,
  withOffTemplateEchoesMasked,
  withSecretAttributeKeysDropped,
  type OffTemplateEchoRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { markWrittenFromDeployedTemplate } from '../../../src/deployment/masked-property-fingerprints.js';
import { isMaskedBaselineRecaptureCandidate } from '../../../src/deployment/masked-baseline-recapture.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import {
  partitionMaskedEchoChanges,
  partitionNoEchoParameterChanges,
  partitionUncertifiedBaselineChanges,
} from '../../../src/cli/commands/drift/redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, child: () => child }) };
});
const ssmValues = new Map<string, string>();
const ssmSend = vi.hoisted(() => vi.fn());
const smSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
    secretsManager: { send: smSend },
  }),
}));

const ID = 'R';
const TYPE = 'AWS::Test::Resource7158';
const ECHO_KEY = 'ReadbackOnly7158';

type Form =
  | 'noecho'
  | 'noecho-embedded'
  | 'subfloor-embedded'
  | 'whole'
  | 'embedded'
  | 'secretsmanager'
  | 'twin';
const FORMS: readonly Form[] = [
  'noecho',
  'noecho-embedded',
  'subfloor-embedded',
  'whole',
  'embedded',
  'secretsmanager',
  'twin',
];
const isNoEcho = (form: Form): boolean => form.startsWith('noecho') || form.startsWith('subfloor');

/** Each shape places the value at a coordinate of a template bag. */
const SHAPES: Record<string, (value: unknown) => Record<string, unknown>> = {
  top: (v) => ({ Name: 'public-name-7158', Secret: v }),
  nested: (v) => ({ Outer: { Label: 'public-label', Secret: v } }),
  'list-identity': (v) => ({ Items: [{ Name: 'item-a', Value: 'public-a' }, { Name: 'item-b', Value: v }] }),
  'list-single': (v) => ({ Users: [{ Password: v }] }),
  'list-strings': (v) => ({ Args: ['--pw', v, '--verbose'] }),
};

interface Seeded {
  readonly plaintext: string;
  readonly template: CloudFormationTemplate;
  readonly source: Record<string, unknown>;
  readonly resolved: Record<string, unknown>;
  readonly secrets: RecordedSecretValues;
}

async function seeded(shape: string, form: Form, index: number): Promise<Seeded> {
  const plaintext = form === 'subfloor-embedded' ? 'q7Z' : `s3cr3t-7158-${index}-${form}`;
  const name = `/inv7158/${index}/${form}`;
  ssmValues.set(name, plaintext);
  ssmValues.set(`${name}/twin`, plaintext);
  const value: unknown = isNoEcho(form)
    ? form === 'noecho'
      ? { Ref: 'SecretParam' }
      : { 'Fn::Join': ['', ['pre-', { Ref: 'SecretParam' }, '-post']] }
    : form === 'embedded'
      ? `pre-{{resolve:ssm-secure:${name}}}-post`
      : form === 'secretsmanager'
        ? `{{resolve:secretsmanager:${name}}}`
        : `{{resolve:ssm-secure:${name}}}`;
  const source = SHAPES[shape]!(value);
  if (form === 'twin') source['Twin7158'] = `{{resolve:ssm-secure:${name}/twin}}`;
  const template = {
    Parameters: { SecretParam: { Type: 'String', NoEcho: true } },
    Resources: { [ID]: { Type: TYPE, Properties: source } },
  } as unknown as CloudFormationTemplate;
  const secrets: RecordedSecretValues = new Map();
  const context = {
    template,
    resources: {},
    parameters: { SecretParam: plaintext },
    recordedSecretValues: secrets,
  } as unknown as ResolverContext;
  const resolved = (await new IntrinsicFunctionResolver().resolve(source, context)) as Record<string, unknown>;
  return { plaintext, template, source, resolved, secrets };
}

/** The leaf the readback echoes under the template-absent key: what the template position resolved to. */
function echoOf(s: Seeded, form: Form): string {
  const text = JSON.stringify(s.resolved);
  if (form === 'noecho' || form === 'whole' || form === 'secretsmanager' || form === 'twin') return s.plaintext;
  // An embedded form echoes the whole leaf it embeds in.
  expect(text).toContain(`pre-${s.plaintext}-post`);
  return `pre-${s.plaintext}-post`;
}

/** Where the readback puts the echo: always under a key the template lacks. */
type Placement = 'top' | 'deep' | 'list' | 'beside';
const PLACEMENTS: readonly Placement[] = ['top', 'deep', 'list', 'beside'];

function liveOf(s: Seeded, form: Form, placement: Placement = 'top'): Record<string, unknown> {
  const echo = echoOf(s, form);
  switch (placement) {
    case 'top':
      return { ...s.resolved, [ECHO_KEY]: echo };
    case 'deep':
      return { ...s.resolved, [ECHO_KEY]: { Inner: { Deep: echo } } };
    case 'list':
      return { ...s.resolved, [ECHO_KEY]: ['public-item-7158', echo] };
    case 'beside': {
      // Beside a template key, inside an object the template DOES set.
      const [first] = Object.keys(s.resolved);
      const node = s.resolved[first!];
      if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
        return { ...s.resolved, [first!]: { ...(node as Record<string, unknown>), [ECHO_KEY]: echo } };
      }
      return { ...s.resolved, [ECHO_KEY]: echo };
    }
  }
}

function engineFor(s: Seeded, resolvedThisRun: boolean): DeployEngine {
  const engine = new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false },
    'us-east-1'
  );
  if (resolvedThisRun) {
    engine.secretsRun.perResourceTemplateProps.set(ID, s.source);
    engine.secretsRun.perResourceResolvedType.set(ID, TYPE);
    engine.secretsRun.perResourceSecrets.set(ID, s.secrets);
  }
  engine.noEchoRun.constructPathTemplate = s.template;
  return engine;
}

function persisted(engine: DeployEngine, record: ResourceState): ResourceState {
  const state: StackState = {
    version: 18,
    stackName: 'Stack7158',
    region: 'us-east-1',
    resources: { [ID]: record },
    outputs: {},
    lastModified: 0,
  };
  return (engine as unknown as { redactStateForPersist(s: StackState): StackState }).redactStateForPersist(state)
    .resources[ID]!;
}

type Writer = 'deploy-persist' | 'unchanged-persist';

function written(writer: Writer, s: Seeded, form: Form, placement: Placement): ResourceState {
  const memory = (): ResourceState => ({
    physicalId: 'physical-7158',
    resourceType: TYPE,
    properties: markWrittenFromDeployedTemplate(markSameGenerationBag({ ...s.resolved })),
    observedProperties: markSameGenerationBag(liveOf(s, form, placement)),
  });
  const first = persisted(engineFor(s, true), memory());
  if (writer === 'deploy-persist') return first;
  // The next deploy leaves the resource unchanged: nothing resolved for it,
  // and its readback is fresh (the deploy-start refresh).
  return persisted(engineFor(s, false), {
    ...first,
    observedProperties: markSameGenerationBag(liveOf(s, form, placement)),
  });
}

/** The tokens a baseline holds, resolved as drift resolves them. */
function resolvedBaseline(baseline: Record<string, unknown>): Record<string, unknown> {
  let text = JSON.stringify(baseline);
  for (const [name, value] of ssmValues) {
    text = text
      .split(`{{resolve:ssm-secure:${name}}}`)
      .join(value)
      .split(`{{resolve:secretsmanager:${name}}}`)
      .join(value);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every coordinate of a whole `***` leaf under a key the template lacks, at any depth. */
function offTemplateMasks(record: ResourceState): string[] {
  const out: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const walk = (node: unknown, source: unknown, path: (string | number)[], off: boolean): void => {
    if (node === '***') {
      if (off) out.push(JSON.stringify(path));
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, Array.isArray(source) ? source[i] : undefined, [...path, i], off));
    } else if (isObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        const absent = isObject(source) && !Object.hasOwn(source, k);
        walk(v, isObject(source) ? source[k] : undefined, [...path, k], off || absent);
      }
    }
  };
  walk(record.observedProperties ?? {}, record.properties, [], false);
  return out;
}

describe('a secret echoed under a key the template lacks (go-to-k/cdkd#7158, #7152)', () => {
  beforeEach(() => {
    ssmSend.mockReset();
    ssmSend.mockImplementation((command: { input: { Name: string } }) =>
      Promise.resolve({ Parameter: { Value: ssmValues.get(command.input.Name), Type: 'SecureString' } })
    );
    smSend.mockReset();
    smSend.mockImplementation((command: { input: { SecretId: string } }) =>
      Promise.resolve({ SecretString: ssmValues.get(command.input.SecretId) })
    );
  });

  const cases = Object.keys(SHAPES).flatMap((shape) =>
    FORMS.flatMap((form) =>
      PLACEMENTS.flatMap((placement) =>
        (['deploy-persist', 'unchanged-persist'] as const).map((writer) => ({ shape, form, placement, writer }))
      )
    )
  );

  it('the generated population is the full product', () => {
    expect(cases).toHaveLength(5 * 7 * 4 * 2);
  });

  it.each(cases.map((c, i) => [c.writer, c.shape, c.form, c.placement, i] as const))(
    '%s, %s, %s, echo %s: no plaintext, every off-template mask named, no drift',
    async (writer, shape, form, placement, index) => {
      const s = await seeded(shape, form, index);
      const record = written(writer, s, form, placement);
      expect(JSON.stringify(record)).not.toContain(s.plaintext);
      const named = (observedMaskedLeavesOf(record) ?? []).map((c) => JSON.stringify(c));
      expect(offTemplateMasks(record).filter((c) => !named.includes(c))).toEqual([]);
      const baseline = resolvedBaseline(record.observedProperties ?? {});
      const changes = calculateResourceDrift(baseline, liveOf(s, form, placement), {
        unionWalkObjects: true,
      });
      // The partitions in `compare.ts`'s order. An uncertified position (the
      // #2852 fail-closed mask of a list nothing pairs) is its own, older,
      // disposition and is reported as such.
      const afterNoEcho = partitionNoEchoParameterChanges(changes, record, baseline).kept;
      const afterEcho = partitionMaskedEchoChanges(afterNoEcho, record, baseline).kept;
      expect(partitionUncertifiedBaselineChanges(afterEcho, record.properties, baseline).kept).toEqual([]);
    }
  );

  it('the #7152 repro: an unchanged record learns a list reference plaintext from its fresh readback', () => {
    const record = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Users: ['plain', { Password: '{{resolve:ssm-secure:/p}}' }] },
        observedProperties: { Users: ['plain', { Password: '{{resolve:ssm-secure:/p}}' }], Extra: '***' },
      },
      { readback: { Users: ['plain', { Password: 'pw-plain-7152' }], Extra: 'pw-plain-7152' } }
    );
    // The pre-scrub readback is what teaches the value; the bag being written already lost it.
    const fresh = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Users: ['plain', { Password: '{{resolve:ssm-secure:/p}}' }] },
        observedProperties: { Users: ['plain', { Password: '{{resolve:ssm-secure:/p}}' }], Extra: 'pw-plain-7152' },
      },
      { readback: { Users: ['plain', { Password: 'pw-plain-7152' }], Extra: 'pw-plain-7152' } }
    );
    expect(fresh.observedProperties?.['Extra']).toBe('***');
    expect(fresh.observedMaskedLeaves).toEqual([['Extra']]);
    // A leaf this save already masked (a needle of the value scan) is named
    // too, read off the raw readback: a mask no field names is phantom drift.
    expect(record.observedProperties?.['Extra']).toBe('***');
    expect(record.observedMaskedLeaves).toEqual([['Extra']]);
  });

  it('learns an EMBEDDED reference plaintext from between the template literal prefix and suffix', () => {
    const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Conn: 'host=db;pw={{resolve:secretsmanager:conn}};' },
        observedProperties: { Conn: 'host=db;pw={{resolve:secretsmanager:conn}};', Extra: 'emb3dded-7152' },
      },
      { readback: { Conn: 'host=db;pw=emb3dded-7152;', Extra: 'emb3dded-7152' } }
    );
    expect(out.observedProperties?.['Extra']).toBe('***');
    expect(out.observedMaskedLeaves).toEqual([['Extra']]);
  });

  it('learns from the resolved bag when the readback does not return the value at its position', () => {
    const noEcho = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      { physicalId: 'p', properties: { Secret: '***' }, observedProperties: { Extra: 'pre-q7Z-post' }, noEchoLeaves: [['Secret']] },
      { properties: { Secret: 'pre-q7Z-post' }, readback: { Extra: 'pre-q7Z-post' } }
    );
    expect(noEcho.observedProperties?.['Extra']).toBe('***');
    const reference = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Conn: 'pw={{resolve:ssm-secure:/c}};' },
        observedProperties: { Extra: 'res0lved-7152' },
      },
      { properties: { Conn: 'pw=res0lved-7152;' }, readback: { Extra: 'res0lved-7152' } }
    );
    expect(reference.observedProperties?.['Extra']).toBe('***');
  });

  it('the deploy persist learns from the in-memory bag when the readback omits the position', async () => {
    const s = await seeded('top', 'subfloor-embedded', 9001);
    const record = persisted(engineFor(s, true), {
      physicalId: 'physical-7158',
      resourceType: TYPE,
      properties: markWrittenFromDeployedTemplate(markSameGenerationBag({ ...s.resolved })),
      observedProperties: markSameGenerationBag({ Name: 'public-name-7158', [ECHO_KEY]: 'pre-q7Z-post' }),
    });
    expect(JSON.stringify(record.observedProperties)).not.toContain('q7Z');
    expect(record.observedMaskedLeaves).toEqual([[ECHO_KEY]]);
  });

  it('pairs a list AWS returned reordered through its identity field', () => {
    const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Items: [{ Name: 'a', Value: 'pub-a' }, { Name: 'b', Value: '{{resolve:ssm-secure:/b}}' }] },
        observedProperties: { Items: [{ Name: 'b', Value: '{{resolve:ssm-secure:/b}}' }, { Name: 'a', Value: 'pub-a' }], Extra: 'reord3red-7152' },
      },
      { readback: { Items: [{ Name: 'b', Value: 'reord3red-7152' }, { Name: 'a', Value: 'pub-a' }], Extra: 'reord3red-7152' } }
    );
    expect(out.observedProperties?.['Extra']).toBe('***');
  });

  it('learns the whole readback leaf when the template leaf holds two references', () => {
    const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Conn: 'u={{resolve:ssm-secure:/u}};p={{resolve:secretsmanager:p}}' },
        observedProperties: { Conn: 'u={{resolve:ssm-secure:/u}};p={{resolve:secretsmanager:p}}', Extra: 'u=us3r;p=pa55' },
      },
      { readback: { Conn: 'u=us3r;p=pa55', Extra: 'u=us3r;p=pa55' } }
    );
    expect(out.observedProperties?.['Extra']).toBe('***');
  });

  it('keeps an entry under an element a writer masked whole', () => {
    const out = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Echoes: ['***', '***'] }, observedMaskedLeaves: [['Echoes', 1, 'Value']] },
      {}
    );
    expect(out.observedMaskedLeaves).toEqual([['Echoes', 1, 'Value']]);
  });

  it('the deploy persist never learns the region or the stack name', () => {
    for (const token of ['us-east-1', 'Stack7158']) {
      const engine = new DeployEngine({} as never, {} as never, {} as never, {} as never, {} as never, { dryRun: false }, 'us-east-1');
      const record = persisted(engine, {
        physicalId: 'p',
        resourceType: TYPE,
        properties: { Secret: '***' },
        noEchoLeaves: [['Secret']],
        observedProperties: markSameGenerationBag({ Secret: token, Echo: token }),
      });
      expect(record.observedProperties?.['Echo']).toBe(token);
    }
  });

  describe('over-mask controls: never learned as a needle', () => {
    const run = (
      properties: Record<string, unknown>,
      readback: Record<string, unknown>,
      extra: Partial<{ physicalId: string; noEchoLeaves: (string | number)[][] }> = {}
    ): Record<string, unknown> | undefined =>
      withOffTemplateEchoesMasked(
        { physicalId: extra.physicalId ?? 'p', properties, observedProperties: readback, ...(extra.noEchoLeaves && { noEchoLeaves: extra.noEchoLeaves }) },
        { readback },
        new Set(['us-east-1', 'Stack7158'])
      ).observedProperties;

    it('a public ssm (non-secure) reference whose value equals an off-template value', () => {
      const out = run(
        { Version: '{{resolve:ssm:/public/version}}' },
        { Version: 'release-2026-11', Extra: 'release-2026-11' }
      );
      expect(out?.['Extra']).toBe('release-2026-11');
    });

    it('a value equal to the region or the stack name', () => {
      for (const token of ['us-east-1', 'Stack7158']) {
        const out = run({ Secret: '***' }, { Secret: token, Extra: token }, { noEchoLeaves: [['Secret']] });
        expect(out?.['Extra']).toBe(token);
      }
    });

    it('a value the physical id contains', () => {
      const out = run(
        { Name: '***' },
        { Name: 'queue-name-7158', Arn: 'arn:aws:sqs:us-east-1:1:queue-name-7158' },
        { physicalId: 'https://sqs/1/queue-name-7158', noEchoLeaves: [['Name']] }
      );
      expect(out?.['Arn']).toBe('arn:aws:sqs:us-east-1:1:queue-name-7158');
    });

    it('a reordered list teaches no other item public value', () => {
      const out = run(
        { Args: ['public-flag-value', '{{resolve:ssm-secure:/p}}'] },
        { Args: ['s3cr3t-reordered', 'public-flag-value'], Extra: 'public-flag-value' }
      );
      expect(out?.['Extra']).toBe('public-flag-value');
    });

    it('a NoEcho value under the needle floor, echoed whole', () => {
      const out = run({ Secret: '***' }, { Secret: 'q7Z', Extra: 'q7Z' }, { noEchoLeaves: [['Secret']] });
      expect(out?.['Extra']).toBe('q7Z');
    });

    it('a template position is never treated as off-template', () => {
      const out = run(
        { Secret: '***', Other: 'abcd-public' },
        { Secret: 'abcd-public', Other: 'abcd-public' },
        { noEchoLeaves: [['Secret']] }
      );
      expect(out?.['Other']).toBe('abcd-public');
    });
  });

  it('keeps a recorded entry while the leaf there still holds the mask, and drops it otherwise', () => {
    const kept = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Extra: '***' }, observedMaskedLeaves: [['Extra']] },
      {}
    );
    expect(kept.observedMaskedLeaves).toEqual([['Extra']]);
    const dropped = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Extra: 'now-public' }, observedMaskedLeaves: [['Extra']] },
      {}
    );
    expect(dropped.observedMaskedLeaves).toBeUndefined();
    const noReadback = withOffTemplateEchoesMasked({ properties: {}, observedMaskedLeaves: [['Extra']] }, {});
    expect(noReadback.observedMaskedLeaves).toBeUndefined();
  });

  it('drops a recorded entry once the template sets the key, and keeps one under a list masked whole', () => {
    const owned = withOffTemplateEchoesMasked(
      { properties: { Extra: '***' }, observedProperties: { Extra: '***' }, observedMaskedLeaves: [['Extra']] },
      {}
    );
    expect(owned.observedMaskedLeaves).toBeUndefined();
    const whole = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Echoes: ['***', '***'] }, observedMaskedLeaves: [['Echoes', 1]] },
      {}
    );
    expect(whole.observedMaskedLeaves).toEqual([['Echoes', 1]]);
  });

  it('a named mask is no #3595 re-capture candidate; an unnamed one still is', () => {
    const record = (named: boolean): ResourceState => ({
      physicalId: 'p',
      resourceType: TYPE,
      properties: { Password: '{{resolve:ssm-secure:/p}}' },
      observedProperties: { Password: '{{resolve:ssm-secure:/p}}', Extra: '***' },
      ...(named && { observedMaskedLeaves: [['Extra']] }),
    });
    expect(isMaskedBaselineRecaptureCandidate(record(true))).toBe(false);
    expect(isMaskedBaselineRecaptureCandidate(record(false))).toBe(true);
  });
});

describe('a custom resource attribute KEY holding a secret (go-to-k/cdkd#7153)', () => {
  const SECRET = 'k3y-s3cret-7153';
  const secrets: RecordedSecretValues = new Map([[SECRET, '{{resolve:ssm-secure:/k}}']]);
  const template = (getAtt?: unknown): Record<string, unknown> => ({
    Resources: {
      Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
      ...(getAtt !== undefined && { Reader: { Type: 'AWS::SNS::Topic', Properties: { DisplayName: getAtt } } }),
    },
  });
  const record = (attributes: Record<string, unknown>, extra: Partial<ResourceState> = {}): ResourceState => ({
    physicalId: 'cr-1',
    resourceType: 'Custom::Thing',
    properties: {},
    attributes,
    ...extra,
  });

  it('drops an attribute whose key holds a needle the template does not spell', () => {
    const t = template();
    const out = withSecretAttributeKeysDropped(
      record({ [`Endpoint.${SECRET}`]: 'v', Plain: 'ok' }),
      {},
      secrets,
      templateGetAttNamesOf(t, 'Cr')
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.attributes).toEqual({ Plain: 'ok' });
  });

  it('keeps one a template Fn::GetAtt spells, array or string or Fn::Sub form', () => {
    for (const getAtt of [
      { 'Fn::GetAtt': ['Cr', `Endpoint.${SECRET}`] },
      { 'Fn::GetAtt': `Cr.Endpoint.${SECRET}` },
      { 'Fn::Sub': `x-\${Cr.Endpoint.${SECRET}}` },
    ]) {
      const t = template(getAtt);
      const out = withSecretAttributeKeysDropped(
        record({ [`Endpoint.${SECRET}`]: 'v' }),
        {},
        secrets,
        templateGetAttNamesOf(t, 'Cr')
      );
      expect(Object.keys(out.attributes ?? {})).toEqual([`Endpoint.${SECRET}`]);
    }
  });

  it('drops nothing when a Fn::GetAtt names the attribute through an expression', () => {
    const t = template({ 'Fn::GetAtt': ['Cr', { Ref: 'Which' }] });
    const input = record({ [`Endpoint.${SECRET}`]: 'v' });
    expect(withSecretAttributeKeysDropped(input, {}, secrets, templateGetAttNamesOf(t, 'Cr'))).toBe(input);
  });

  it('learns a NoEcho-declared attribute value and removes a dropped name from the declaration', () => {
    const t = template();
    const out = withSecretAttributeKeysDropped(
      record({ Generated: '***', [`ByName-gen3rated-v4lue`]: 'x' }, { noEchoAttributeNames: ['Generated', 'ByName-gen3rated-v4lue'] }),
      { attributes: { Generated: 'gen3rated-v4lue' } },
      new Map(),
      templateGetAttNamesOf(t, 'Cr')
    );
    expect(JSON.stringify(out)).not.toContain('gen3rated-v4lue');
    expect(out.noEchoAttributeNames).toEqual(['Generated']);
  });

  it('drops on the AWS::CloudFormation::CustomResource type CDK emits by default', () => {
    const t = template();
    const out = withSecretAttributeKeysDropped(
      { ...record({ [`Endpoint.${SECRET}`]: 'v' }), resourceType: 'AWS::CloudFormation::CustomResource' },
      {},
      secrets,
      templateGetAttNamesOf(t, 'Cr')
    );
    expect(out.attributes).toEqual({});
  });

  it('an escaped Fn::Sub literal is no Fn::GetAtt of the key', () => {
    const t = template({ 'Fn::Sub': `x-\${!Cr.Endpoint.${SECRET}}` });
    const out = withSecretAttributeKeysDropped(record({ [`Endpoint.${SECRET}`]: 'v' }), {}, secrets, templateGetAttNamesOf(t, 'Cr'));
    expect(out.attributes).toEqual({});
  });

  it('a declared NoEcho value the physical id contains is no needle', () => {
    const t = template();
    const out = withSecretAttributeKeysDropped(
      record({ Generated: '***', 'By-cr-1-name': 'x' }, { physicalId: 'cr-1-name', noEchoAttributeNames: ['Generated'] }),
      { attributes: { Generated: 'cr-1-name' } },
      new Map(),
      templateGetAttNamesOf(t, 'Cr')
    );
    expect(Object.keys(out.attributes ?? {})).toEqual(['Generated', 'By-cr-1-name']);
  });

  it('leaves a non-custom resource, and a key holding no needle, alone', () => {
    const t = template();
    const other = { ...record({ [`Endpoint.${SECRET}`]: 'v' }), resourceType: 'AWS::RDS::DBCluster' };
    expect(withSecretAttributeKeysDropped(other, {}, secrets, templateGetAttNamesOf(t, 'Cr'))).toBe(other);
    const clean = record({ Endpoint: 'v' });
    expect(withSecretAttributeKeysDropped(clean, {}, secrets, templateGetAttNamesOf(t, 'Cr'))).toBe(clean);
  });

  it('the deploy persist drops it', () => {
    const engine = new DeployEngine({} as never, {} as never, {} as never, {} as never, {} as never, { dryRun: false }, 'us-east-1');
    engine.secretsRun.perResourceSecrets.set('Cr', secrets);
    engine.noEchoRun.constructPathTemplate = template() as never;
    const state: StackState = {
      version: 18,
      stackName: 'S',
      region: 'us-east-1',
      resources: { Cr: record({ [`Endpoint.${SECRET}`]: 'v', Plain: 'ok' }) },
      outputs: {},
      lastModified: 0,
    };
    const saved = (engine as unknown as { redactStateForPersist(s: StackState): StackState }).redactStateForPersist(state);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(saved.resources['Cr']!.attributes).toEqual({ Plain: 'ok' });
  });
});
