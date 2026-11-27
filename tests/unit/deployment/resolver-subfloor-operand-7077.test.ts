/**
 * go-to-k/cdkd#7077: a resolver log line prints no piece of a value whose
 * provenance carries a secret below the value scan's floor (1-3 characters),
 * whatever intrinsic produced the piece.
 *
 * Generated over intrinsic shapes x 1-3 character secrets x every provenance
 * route the display taint reads (`intrinsic-resolver/display-taint.ts`):
 *
 * - `root-recorded` (a regression net: the value scan's whole-value arm and
 *   position twins already mask it): a parameter whose value IS a secret
 *   the resource's own pass recorded as a pair;
 * - `child-marked`: a nested child's parameter the parent marked `sub-floor`
 *   (go-to-k/cdkd#7050), the `cdkd deploy` shape;
 * - `child-mixed`: a nested child's parameter still spelling a secret
 *   reference beside other text, the `cdkd diff` shape (go-to-k/cdkd#7068);
 * - `grandchild-fed`: a parameter fed the piece, recorded as a log-only
 *   needle of the subtree's printing bags;
 * - `root-consumed` (a regression net, no taint of its own): a root value the
 *   resolver itself built around a secret reference, which the value scan
 *   masks by the substitution's position;
 * - `child-embeds`: a nested child's parameter EMBEDDING a parent-resolved
 *   secret above the floor, cut into pieces no needle matches.
 *
 * Each case asserts the resolved VALUE is the unmasked one (display only),
 * that a line for the shape was logged, and that no debug line carries the
 * secret. A control with no provenance proves the scan can see the secret.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const BIG = 'b1g-s3cret-v4lue-7077';
const A = '{{resolve:ssm-secure:/app/a}}';
const B = '{{resolve:ssm-secure:/app/b}}';
const state = vi.hoisted(() => ({ pin: '' }));

const logSpies = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { setLevel: vi.fn(), ...logSpies, child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        if (command.input?.Name === '/app/a') return { Parameter: { Value: BIG, Type: 'SecureString' } };
        if (command.input?.Name === '/app/b') {
          return { Parameter: { Value: state.pin, Type: 'SecureString' } };
        }
        const e = new Error('ParameterNotFound');
        e.name = 'ParameterNotFound';
        throw e;
      }),
    },
    secretsManager: { send: vi.fn().mockRejectedValue(new Error('unused')) },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { recordLogOnlyValue } = await import('../../../src/deployment/secret-redaction/log-only.js');
const { attributionRefusedParameters } = await import(
  '../../../src/deployment/secret-redaction/nested-stack/parameter-tables.js'
);
const { withPrintingSecrets } = await import('../../../src/deployment/resource-secrets-scope.js');

/** 1-3 character secrets, none spelled by any other text a line prints. */
const SECRETS = ['ж', 'жщ', 'жщю', 'Q7', 'Q7Z'];

/** The piece of `P`'s value before its `/` (the whole value where it has none). */
const PIECE = { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'P' }] }] };

/** Intrinsic shapes over a source node, each with the line prefix it logs and its value. */
function shapes(source: unknown, pin: string): Array<[string, unknown, string, unknown]> {
  return [
    ['Select', { 'Fn::Select': [0, { 'Fn::Split': ['/', source] }] }, 'Resolved Fn::Select:', pin],
    ['Join', { 'Fn::Join': ['-', [source, 'a']] }, 'Resolved Fn::Join:', `${pin}-a`],
    ['Sub', { 'Fn::Sub': ['${V}-s', { V: source }] }, 'Resolved Fn::Sub:', `${pin}-s`],
    ['FindInMap', { 'Fn::FindInMap': ['M', source, 'k'] }, 'Resolved Fn::FindInMap:', 'mapped-v'],
    ['Base64', { 'Fn::Base64': source }, 'Resolved Fn::Base64:', Buffer.from(pin).toString('base64')],
    ['Equals', { 'Fn::Equals': [source, 'zz'] }, 'Resolved Fn::Equals:', false],
  ];
}

function template(pin: string): CloudFormationTemplate {
  return {
    Parameters: { P: { Type: 'String' } },
    Mappings: { M: { [pin]: { k: 'mapped-v' } } },
    Resources: {},
  } as CloudFormationTemplate;
}

/** The text of `line` outside every `{{resolve:...}}` span. */
const outsideSpans = (line: string) => line.split(/\{\{resolve:[^}]+\}\}/).join('\u0000');

function debugLines(): string[] {
  return logSpies.debug.mock.calls.map((call) => String(call[0]));
}

interface Route {
  /** `P`'s bound value. */
  value: (pin: string) => string;
  /** The context the resolution runs with, and a wrapper around it. */
  context: (pin: string) => Record<string, unknown>;
  run?: <T>(pin: string, fn: () => Promise<T>) => Promise<T>;
}

const ROUTES: Record<string, Route> = {
  'root-recorded': {
    value: (pin) => pin,
    context: (pin) => ({ recordedSecretValues: new Map([[pin, B]]) }),
  },
  'child-marked': {
    value: (pin) => `${pin}/${BIG}`,
    context: (pin) => {
      const inherited = new Map([
        [pin, B],
        [BIG, A],
      ]);
      attributionRefusedParameters.set(inherited, new Map([['P', 'sub-floor']]));
      return { recordedSecretValues: new Map(), inheritedSecrets: inherited };
    },
  },
  'child-mixed': {
    value: (pin) => `${pin}/${A}`,
    context: () => ({
      recordedSecretValues: new Map(),
      skipDynamicReferences: true,
      skippedSecretReferences: new Set(),
    }),
  },
  'grandchild-fed': {
    value: (pin) => pin,
    context: () => ({ recordedSecretValues: new Map() }),
    run: (pin, fn) => {
      const subtree = new Map<string, string>();
      recordLogOnlyValue(subtree, pin);
      return withPrintingSecrets(subtree, fn);
    },
  },
};

async function resolveWith(route: Route, pin: string, node: unknown): Promise<unknown> {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const context = {
    template: template(pin),
    resources: {},
    parameters: { P: route.value(pin) },
    conditions: { Yes: true },
    ...route.context(pin),
  };
  const go = () => resolver.resolve(node, context as never);
  return route.run ? route.run(pin, go) : go();
}

beforeEach(() => {
  logSpies.debug.mockClear();
  resetAccountInfoCache();
});

describe('resolver log operands with a sub-floor provenance print as *** (#7077)', () => {
  for (const [routeName, route] of Object.entries(ROUTES)) {
    for (const pin of SECRETS) {
      const source = route.value(pin) === pin ? { Ref: 'P' } : PIECE;
      for (const [shape, node, prefix, expected] of shapes(source, pin)) {
        it(`${routeName}: ${shape} over "${pin}"`, async () => {
          state.pin = pin;
          // Display only: the resolved value is the real one.
          expect(await resolveWith(route, pin, node)).toEqual(expected);
          const lines = debugLines();
          expect(lines.some((line) => line.startsWith(prefix)), lines.join('\n')).toBe(true);
          expect(lines.filter((line) => outsideSpans(line).includes(pin))).toEqual([]);
        });
      }
    }
  }

  for (const pin of SECRETS) {
    it(`root-consumed: "${pin}" in a value built around a secret reference`, async () => {
      state.pin = pin;
      const built = { 'Fn::Join': ['', [pin, '/', A]] };
      const piece = { 'Fn::Select': [0, { 'Fn::Split': ['/', built] }] };
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const context = {
        template: { Resources: {} },
        resources: {},
        recordedSecretValues: new Map([[pin, B]]),
      };
      expect(await resolver.resolve(piece, context as never)).toBe(pin);
      const lines = debugLines();
      expect(lines.some((line) => line.startsWith('Resolved Fn::Select:'))).toBe(true);
      expect(lines.filter((line) => outsideSpans(line).includes(pin))).toEqual([]);
    });

    it(`root-consumed: "${pin}" framed by its own reference keeps the positional mask`, async () => {
      state.pin = pin;
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const context = { template: { Resources: {} }, resources: {}, recordedSecretValues: new Map() };
      expect(await resolver.resolve({ 'Fn::Join': ['', ['port:', B]] }, context as never)).toBe(
        `port:${pin}`
      );
      // The frame stays readable: nothing but the secret's own span is masked.
      expect(debugLines()).toContain('Resolved Fn::Join: port:***');
    });
  }

  it('child-embeds: no piece of a parent-resolved secret prints (go-to-k/cdkd#7077 review)', async () => {
    const pieces = BIG.split('-');
    const route: Route = {
      value: () => `x/${BIG}`,
      context: () => ({ recordedSecretValues: new Map(), inheritedSecrets: new Map([[BIG, A]]) }),
    };
    for (const index of pieces.keys()) {
      logSpies.debug.mockClear();
      const node = { 'Fn::Select': [index, { 'Fn::Split': ['-', { Ref: 'P' }] }] };
      expect(await resolveWith(route, 'unused', node)).toBe(index === 0 ? `x/${pieces[0]}` : pieces[index]);
      const lines = debugLines();
      expect(lines.some((line) => line.startsWith('Resolved Fn::Split:'))).toBe(true);
      for (const piece of pieces) {
        expect(lines.filter((line) => line.includes(piece)), piece).toEqual([]);
      }
    }
  });

  it('child-mixed: a refused Fn::FindInMap key prints no piece in the error', async () => {
    for (const pin of SECRETS) {
      const node = { 'Fn::FindInMap': ['M', PIECE, 'no-such-key'] };
      const error = await resolveWith(ROUTES['child-mixed']!, pin, node).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('second-level key');
      expect(outsideSpans((error as Error).message).includes(pin), (error as Error).message).toBe(false);
    }
  });

  it('a context reused across a printing binding or a rebound parameter bag re-derives its taint', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const pin = 'Q7';
    state.pin = pin;
    const join = { 'Fn::Join': ['-', [{ Ref: 'P' }, 'a']] };
    // Warmed OUTSIDE the binding, then resolved inside it.
    const context = {
      template: template(pin),
      resources: {},
      parameters: { P: pin },
      recordedSecretValues: new Map(),
    };
    await resolver.resolve(join, context as never);
    const subtree = new Map<string, string>();
    recordLogOnlyValue(subtree, pin);
    logSpies.debug.mockClear();
    await withPrintingSecrets(subtree, () => resolver.resolve(join, context as never));
    expect(debugLines().filter((line) => line.includes(pin))).toEqual([]);
    // Warmed with a plain value, then the parameter bag is rebound.
    const inherited = { ...context, inheritedSecrets: new Map([[BIG, A]]), parameters: { P: 'plain' } };
    await resolver.resolve(join, inherited as never);
    inherited.parameters = { P: `x/${BIG}` };
    logSpies.debug.mockClear();
    await resolver.resolve({ 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'P' }] }] }, inherited as never);
    expect(debugLines().filter((line) => line.includes('s3cret'))).toEqual([]);
  });

  it('the bound-bag answer outside any binding is one array (the memo key compares it by identity)', async () => {
    const { boundPrintingBags } = await import('../../../src/deployment/resource-secrets-scope.js');
    // A fresh `[]` per call missed the per-context memo on every intrinsic
    // call of an ordinary run (13x on a 300-parameter template, review round 2).
    expect(boundPrintingBags()).toBe(boundPrintingBags());
  });

  it('a tainted cross-stack value is a log-only needle on a diff pass only, never on a deploy', async () => {
    const { recordTaintedCrossStackValue } = await import(
      '../../../src/deployment/intrinsic-resolver/display-taint.js'
    );
    const { logOnlyValuesOf } = await import('../../../src/deployment/secret-redaction/log-only.js');
    const taint = { exportTainted: () => true, stackOutputTainted: () => true, holdsAnyTaint: () => true };
    const deployBag = new Map<string, string>();
    recordTaintedCrossStackValue({ template: template('Q7'), resources: {}, recordedSecretValues: deployBag } as never, 'vpc-0abc');
    // A deploy's write decisions read log-only needles (fingerprints, row tags).
    expect(logOnlyValuesOf.get(deployBag)?.has('vpc-0abc') ?? false).toBe(false);
    const diffBag = new Map<string, string>();
    recordTaintedCrossStackValue(
      { template: template('Q7'), resources: {}, recordedSecretValues: diffBag, crossStackTaint: taint } as never,
      'vpc-0abc'
    );
    expect(logOnlyValuesOf.get(diffBag)?.has('vpc-0abc')).toBe(true);
  });

  it('a value with no provenance still prints (the scan above can see it)', async () => {
    state.pin = 'Q7';
    const control: Route = { value: (pin) => pin, context: () => ({ recordedSecretValues: new Map() }) };
    for (const [shape, node] of shapes({ Ref: 'P' }, 'Q7')) {
      if (shape === 'Equals') continue;
      logSpies.debug.mockClear();
      await resolveWith(control, 'Q7', node);
      expect(debugLines().some((line) => line.includes('Q7')), shape).toBe(true);
    }
  });
});
