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
 * `secretsmanager` one; two references with one plaintext; and, for
 * go-to-k/cdkd#7160, a plain `ssm` reference naming a `SecureString` whole,
 * embedded and twinned) x writers (the
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
  maskOffTemplateEchoes,
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
  | 'subfloor'
  | 'whole'
  | 'embedded'
  | 'secretsmanager'
  | 'twin'
  | 'ssm-whole'
  | 'ssm-embedded'
  | 'ssm-twin';
const FORMS: readonly Form[] = [
  'noecho',
  'noecho-embedded',
  'subfloor-embedded',
  'subfloor',
  'whole',
  'embedded',
  'secretsmanager',
  'twin',
  'ssm-whole',
  'ssm-embedded',
  'ssm-twin',
];
const isNoEcho = (form: Form): boolean => form.startsWith('noecho') || form.startsWith('subfloor');
/** go-to-k/cdkd#7160: the plain `ssm` forms name a `SecureString` (the mock's `Type`). */
const serviceOf = (form: Form): string => (form.startsWith('ssm-') ? 'ssm' : 'ssm-secure');

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
  const plaintext = form.startsWith('subfloor') ? 'q7Z' : `s3cr3t-7158-${index}-${form}`;
  const name = `/inv7158/${index}/${form}`;
  ssmValues.set(name, plaintext);
  ssmValues.set(`${name}/twin`, plaintext);
  const value: unknown = isNoEcho(form)
    ? form === 'noecho' || form === 'subfloor'
      ? { Ref: 'SecretParam' }
      : { 'Fn::Join': ['', ['pre-', { Ref: 'SecretParam' }, '-post']] }
    : form === 'embedded' || form === 'ssm-embedded'
      ? `pre-{{resolve:${serviceOf(form)}:${name}}}-post`
      : form === 'secretsmanager'
        ? `{{resolve:secretsmanager:${name}}}`
        : `{{resolve:${serviceOf(form)}:${name}}}`;
  const source = SHAPES[shape]!(value);
  if (form === 'twin' || form === 'ssm-twin') {
    source['Twin7158'] = `{{resolve:${serviceOf(form)}:${name}/twin}}`;
  }
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
  if (!form.endsWith('embedded')) return s.plaintext;
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
      .join(value)
      .split(`{{resolve:ssm:${name}}}`)
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
    expect(cases).toHaveLength(5 * 11 * 4 * 2);
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

  it('the #7160 repro: an unchanged record learns a plain ssm SecureString plaintext inside a list', () => {
    const record = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Users: ['plain', { Password: '{{resolve:ssm:/db/pw}}' }] },
        observedProperties: { Users: ['plain', { Password: 'pw-plain-7160' }], Extra: 'pw-plain-7160' },
      },
      { readback: { Users: ['plain', { Password: 'pw-plain-7160' }], Extra: 'pw-plain-7160' } }
    );
    expect(record.observedProperties?.['Extra']).toBe('***');
    expect(observedMaskedLeavesOf(record)).toEqual([['Extra']]);
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
    expect(JSON.stringify(out)).not.toContain('emb3dded-7152');
  });

  it('learns from the resolved bag when the readback does not return the value at its position', () => {
    const noEcho = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      { physicalId: 'p', properties: { Secret: '***' }, observedProperties: { Extra: 'pre-q7Z-post' }, noEchoLeaves: [['Secret']] },
      { properties: { Secret: 'pre-q7Z-post' }, readback: { Extra: 'pre-q7Z-post' } }
    );
    expect(noEcho.observedProperties?.['Extra']).toBe('***');
    expect(JSON.stringify(noEcho)).not.toContain('q7Z');
    const reference = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Conn: 'pw={{resolve:ssm-secure:/c}};' },
        observedProperties: { Extra: 'res0lved-7152' },
      },
      { properties: { Conn: 'pw=res0lved-7152;' }, readback: { Extra: 'res0lved-7152' } }
    );
    expect(reference.observedProperties?.['Extra']).toBe('***');
    expect(JSON.stringify(reference)).not.toContain('res0lved-7152');
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
    expect(JSON.stringify(out)).not.toContain('reord3red-7152');
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
    expect(JSON.stringify(out)).not.toContain('us3r');
    expect(JSON.stringify(out)).not.toContain('pa55');
  });

  it('leaves an echo the redaction rewrote into its reference alone, so drift still compares it', () => {
    const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
      {
        physicalId: 'p',
        properties: { Password: '{{resolve:ssm-secure:/pw}}' },
        observedProperties: { Password: '{{resolve:ssm-secure:/pw}}', Extra: '{{resolve:ssm-secure:/pw}}' },
      },
      { readback: { Password: 'rewr1tten-7152', Extra: 'rewr1tten-7152' } }
    );
    expect(out.observedProperties?.['Extra']).toBe('{{resolve:ssm-secure:/pw}}');
    expect(out.observedMaskedLeaves).toBeUndefined();
  });

  it('keeps an entry under an element a writer masked whole', () => {
    const out = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Echoes: ['***', '***'] }, observedMaskedLeaves: [['Echoes', 1, 'Value']] },
      {}
    );
    expect(out.observedMaskedLeaves).toEqual([['Echoes', 1, 'Value']]);
  });

  it('keeps an entry past the end of a list a writer masked whole (a mask in the list, not at the index)', () => {
    // `isWhollyMask` of the list holds; `isMaskLeaf` of a list never does, and
    // the index itself holds nothing.
    const out = withOffTemplateEchoesMasked(
      { properties: {}, observedProperties: { Echoes: ['***', '***'] }, observedMaskedLeaves: [['Echoes', 3]] },
      {}
    );
    expect(out.observedMaskedLeaves).toEqual([['Echoes', 3]]);
  });

  describe('a kept entry under a template list is re-paired, never indexed into the template (readback indices)', () => {
    it('an identity-paired element past the end of the template list', () => {
      const first = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
        {
          physicalId: 'p',
          properties: { Secret: '***', Items: [{ Name: 'b' }] },
          noEchoLeaves: [['Secret']],
          observedProperties: { Secret: '***', Items: [{ Name: 'a' }, { Name: 'b', Extra: 'x-hunter22' }] },
        },
        { readback: { Secret: 'hunter22', Items: [{ Name: 'a' }, { Name: 'b', Extra: 'x-hunter22' }] } }
      );
      expect(first.observedMaskedLeaves).toEqual([['Items', 1, 'Extra']]);
      expect(JSON.stringify(first)).not.toContain('hunter22');
      // A write that cannot re-learn the value (scrub, a persist with no fresh readback).
      const second = withOffTemplateEchoesMasked(first, {});
      expect(second.observedMaskedLeaves).toEqual([['Items', 1, 'Extra']]);
    });

    it('an identity-paired element AWS returned reordered', () => {
      const first = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
        {
          physicalId: 'p',
          properties: { Secret: '***', Items: [{ Name: 'a', Extra: 'pub' }, { Name: 'b' }] },
          noEchoLeaves: [['Secret']],
          observedProperties: { Secret: '***', Items: [{ Name: 'b', Extra: 'x-hunter22' }, { Name: 'a', Extra: 'pub' }] },
        },
        { readback: { Secret: 'hunter22', Items: [{ Name: 'b', Extra: 'x-hunter22' }, { Name: 'a', Extra: 'pub' }] } }
      );
      expect(first.observedMaskedLeaves).toEqual([['Items', 0, 'Extra']]);
      const second = withOffTemplateEchoesMasked(first, {});
      expect(second.observedMaskedLeaves).toEqual([['Items', 0, 'Extra']]);
    });
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

    it('a public ssm (String) parameter, which a deploy persists RESOLVED', () => {
      // go-to-k/cdkd#1901: a `String` parameter's value replaces its token in
      // `properties`, so no token survives to be learned from.
      const out = run(
        { Version: 'release-2026-11' },
        { Version: 'release-2026-11', Extra: 'release-2026-11' }
      );
      expect(out?.['Extra']).toBe('release-2026-11');
    });

    it('a plain ssm token the writer proved public (go-to-k/cdkd#7160)', () => {
      const properties = { Version: 'v={{resolve:ssm:/public/version}}' };
      const readback = { Version: 'v=release-2026-11', Extra: 'release-2026-11' };
      const input = { bag: readback, readback, properties, physicalId: 'p' };
      expect(
        maskOffTemplateEchoes({
          ...input,
          provenPublic: (t) => (t === '{{resolve:ssm:/public/version}}' ? 'release-2026-11' : undefined),
        }).bag['Extra']
      ).toBe('release-2026-11');
      // A proof at ANOTHER value (the parameter retyped since) does not vouch for this one.
      expect(maskOffTemplateEchoes({ ...input, provenPublic: () => 'release-2026-10' }).bag['Extra']).toBe('***');
      // Control: without the proof the surviving token names a SecureString.
      expect(maskOffTemplateEchoes(input).bag['Extra']).toBe('***');
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

    it('a public leaf that only CONTAINS a NoEcho value under the needle floor', () => {
      const out = run(
        { Secret: '***' },
        { Secret: 'q7Z', Extra: 'xq7Zx', Tags: ['q7Z-public', 'public'] },
        { noEchoLeaves: [['Secret']] }
      );
      expect(out?.['Extra']).toBe('xq7Zx');
      expect(out?.['Tags']).toEqual(['q7Z-public', 'public']);
    });

    it('an empty NoEcho value', () => {
      const out = run({ Secret: '***' }, { Secret: '', Extra: '' }, { noEchoLeaves: [['Secret']] });
      expect(out?.['Extra']).toBe('');
    });

    it('a short value equal to the region or the stack name, which stay public', () => {
      const out = withOffTemplateEchoesMasked(
        { physicalId: 'p', properties: { Secret: '***' }, observedProperties: { Secret: 'S1', Extra: 'S1' }, noEchoLeaves: [['Secret']] },
        { readback: { Secret: 'S1', Extra: 'S1' } },
        new Set(['us-east-1', 'S1'])
      );
      expect(out.observedProperties?.['Extra']).toBe('S1');
      expect(out.observedMaskedLeaves).toBeUndefined();
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

  describe('a value too short to scan for, or one the physical id contains, masks an EQUAL leaf (go-to-k/cdkd#7181)', () => {
    const masked = (
      readback: Record<string, unknown>,
      physicalId = 'p'
    ): ReturnType<typeof withOffTemplateEchoesMasked<OffTemplateEchoRecord>> =>
      withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
        { physicalId, properties: { Secret: '***' }, observedProperties: readback, noEchoLeaves: [['Secret']] },
        { readback },
        new Set(['us-east-1', 'Stack7158'])
      );

    it('a NoEcho value under the needle floor, echoed whole, at the top, nested and in a list', () => {
      const out = masked({ Secret: 'q7Z', Extra: 'q7Z', Deep: { Inner: 'q7Z' }, List: ['public', 'q7Z'] });
      // The template position itself is the positional NoEcho arm's (`applyNoEchoPersist`).
      const { Secret: _position, ...offTemplate } = out.observedProperties ?? {};
      expect(JSON.stringify(offTemplate)).not.toContain('q7Z');
      expect(out.observedMaskedLeaves).toEqual([['Deep', 'Inner'], ['Extra'], ['List', 1]]);
    });

    it('a NoEcho value the physical id contains, echoed whole; an ARN merely containing it stays', () => {
      const out = masked(
        { Secret: 'queue-name-7158', Name: 'queue-name-7158', Arn: 'arn:aws:sqs:us-east-1:1:queue-name-7158' },
        'https://sqs/1/queue-name-7158'
      );
      expect(out.observedProperties?.['Name']).toBe('***');
      expect(out.observedProperties?.['Arn']).toBe('arn:aws:sqs:us-east-1:1:queue-name-7158');
      expect(out.observedMaskedLeaves).toEqual([['Name']]);
    });

    it('a short secret reference plaintext, from the readback and from the resolved bag', () => {
      for (const raw of [
        { readback: { Pin: 'Zq9', Extra: 'Zq9' } },
        { properties: { Pin: 'Zq9' }, readback: { Extra: 'Zq9' } },
      ]) {
        const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
          { physicalId: 'p', properties: { Pin: '{{resolve:ssm-secure:/pin}}' }, observedProperties: { Extra: 'Zq9' } },
          raw
        );
        expect(out.observedProperties?.['Extra']).toBe('***');
        expect(out.observedMaskedLeaves).toEqual([['Extra']]);
      }
    });

    it('a stack whose secrets are all long enough to scan for gains no masked position', () => {
      // Public off-template leaves equal to short substrings of the secret,
      // to text of the physical id, and to short template literals.
      const readback = { Secret: 'l0ng-s3cret-value', Short: 'l0n', Id: 'p', Count: '1', Flag: 'on', Region: 'us-east-1' };
      const out = withOffTemplateEchoesMasked<OffTemplateEchoRecord>(
        { physicalId: 'phys-1', properties: { Secret: '***', Mode: 'on' }, observedProperties: readback, noEchoLeaves: [['Secret']] },
        { readback },
        new Set(['us-east-1', 'Stack7158'])
      );
      expect(out.observedProperties).toEqual(readback);
      expect(out.observedMaskedLeaves).toBeUndefined();
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

  describe('a value too short to scan for, or one the physical id contains, drops an EQUAL key (go-to-k/cdkd#7181)', () => {
    const shortSecrets: RecordedSecretValues = new Map([['q7Z', '***']]);

    it('drops a key equal to a short secret, and keeps one that only contains it', () => {
      const t = template();
      const out = withSecretAttributeKeysDropped(
        record({ q7Z: 'v', 'Xq7Zx': 'w', Plain: 'ok' }),
        {},
        shortSecrets,
        templateGetAttNamesOf(t, 'Cr')
      );
      expect(out.attributes).toEqual({ Xq7Zx: 'w', Plain: 'ok' });
    });

    it('keeps a key equal to a short secret that a template Fn::GetAtt spells', () => {
      const t = template({ 'Fn::GetAtt': ['Cr', 'q7Z'] });
      const input = record({ q7Z: 'v' });
      expect(withSecretAttributeKeysDropped(input, {}, shortSecrets, templateGetAttNamesOf(t, 'Cr'))).toBe(input);
    });

    it('drops a key equal to a declared NoEcho value the physical id contains', () => {
      const t = template();
      const out = withSecretAttributeKeysDropped(
        record({ Generated: '***', 'cr-1-name': 'x', 'By-cr-1-name': 'y' }, { physicalId: 'cr-1-name', noEchoAttributeNames: ['Generated'] }),
        { attributes: { Generated: 'cr-1-name' } },
        new Map(),
        templateGetAttNamesOf(t, 'Cr')
      );
      expect(Object.keys(out.attributes ?? {})).toEqual(['Generated', 'By-cr-1-name']);
    });

    it('never drops a key equal to the region or the stack name, nor an empty key', () => {
      const t = template();
      const input = record({ S1: 'v', '': 'w' });
      const secrets: RecordedSecretValues = new Map([['S1', '***'], ['', '***']]);
      expect(withSecretAttributeKeysDropped(input, {}, secrets, templateGetAttNamesOf(t, 'Cr'), new Set(['S1']))).toBe(input);
    });
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

  describe('orphan and superseded records (go-to-k/cdkd#7161)', () => {
    const persistDropped = (engine: DeployEngine, dropped: ResourceState, getAtt?: unknown): StackState => {
      engine.noEchoRun.constructPathTemplate = template(getAtt) as never;
      const state: StackState = {
        version: 18,
        stackName: 'S',
        region: 'us-east-1',
        resources: {},
        orphans: [{ logicalId: 'Cr', orphanedAt: 1, state: dropped }],
        supersededResources: [{ logicalId: 'Cr', supersededAt: 1, state: dropped }],
        outputs: {},
        lastModified: 0,
      };
      return (engine as unknown as { redactStateForPersist(s: StackState): StackState }).redactStateForPersist(state);
    };
    const engine = (): DeployEngine =>
      new DeployEngine({} as never, {} as never, {} as never, {} as never, {} as never, { dryRun: false }, 'us-east-1');

    it("drops the key with this deploy's needles for the same resource", () => {
      const e = engine();
      e.secretsRun.perResourceSecrets.set('Cr', secrets);
      e.secretsRun.perResourceResolvedType.set('Cr', 'Custom::Thing');
      const saved = persistDropped(e, record({ [`Endpoint.${SECRET}`]: 'v', Plain: 'ok' }));
      expect(JSON.stringify(saved)).not.toContain(SECRET);
      expect(saved.orphans![0]!.state.attributes).toEqual({ Plain: 'ok' });
      expect(saved.supersededResources![0]!.state.attributes).toEqual({ Plain: 'ok' });
    });

    it("drops the key a rollback-minted record's NoEcho attribute value names", () => {
      const NOECHO = 'n0echo-value-7161';
      const e = engine();
      // The handler answered `NoEcho: true` in this run (its rollback minted the record).
      e.noEchoRun.noEchoAttributeResources.set('Cr', true);
      const saved = persistDropped(e, record({ Generated: NOECHO, [`By-${NOECHO}`]: 'x', Plain: 'ok' }));
      expect(JSON.stringify(saved)).not.toContain(`By-${NOECHO}`);
      expect(saved.orphans![0]!.state.attributes).toEqual({ Generated: '***', Plain: '***' });
      expect(saved.supersededResources![0]!.state.attributes).toEqual({ Generated: '***', Plain: '***' });
    });

    it('masks and names a secret its readback echoed under a key the template lacks (go-to-k/cdkd#7160)', () => {
      const echoed: ResourceState = {
        physicalId: 'o-1',
        resourceType: TYPE,
        properties: { Password: '{{resolve:ssm:/orphan/pw}}' },
        observedProperties: { Password: 'pw-orphan-7160', Extra: 'x-pw-orphan-7160-y' },
      };
      const saved = persistDropped(engine(), echoed);
      for (const row of [saved.orphans![0]!, saved.supersededResources![0]!]) {
        expect(row.state.observedProperties?.['Extra']).toBe('***');
        expect(row.state.observedMaskedLeaves).toEqual([['Extra']]);
      }
      expect(JSON.stringify(saved)).not.toContain('pw-orphan-7160');
    });

    it('keeps a key a template Fn::GetAtt spells', () => {
      const e = engine();
      e.secretsRun.perResourceSecrets.set('Cr', secrets);
      e.secretsRun.perResourceResolvedType.set('Cr', 'Custom::Thing');
      const saved = persistDropped(e, record({ [`Endpoint.${SECRET}`]: 'v' }), { 'Fn::GetAtt': ['Cr', `Endpoint.${SECRET}`] });
      expect(Object.keys(saved.orphans![0]!.state.attributes ?? {})).toEqual([`Endpoint.${SECRET}`]);
    });

    it("a needle of another type's resource under the same logical id drops nothing", () => {
      const e = engine();
      e.secretsRun.perResourceSecrets.set('Cr', secrets);
      e.secretsRun.perResourceResolvedType.set('Cr', 'AWS::SNS::Topic');
      const saved = persistDropped(e, record({ [`Endpoint.${SECRET}`]: 'v' }));
      expect(Object.keys(saved.orphans![0]!.state.attributes ?? {})).toEqual([`Endpoint.${SECRET}`]);
    });
  });
});
