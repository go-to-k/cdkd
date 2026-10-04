import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  maskedInputFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { recordMaskOnlyValue } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#4543 security review: an attribute of a resource whose
 * resolution THIS deploy recorded a secret for is held raw in memory until the
 * save redacts it. The engine's input sources keep such an attribute as
 * written exactly when the save's own redaction would change it (the saved
 * record then holds `***` or a reference, which the next diff keeps), and
 * resolve it otherwise, so the two sides agree. A divergence would move a create-only
 * path and keep a replacement (`deploy-engine-replacement-ceiling.test.ts`).
 */
function engineReturning(value: unknown): {
  engine: DeployEngine;
  resolve: ReturnType<typeof vi.fn>;
} {
  const engine = new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false },
    'us-east-1'
  );
  engine.fingerprintParameters = parameterInputsFor({ template: { Resources: {} }, values: {} });
  const resolve = vi.fn().mockResolvedValue(value);
  (engine as unknown as { resolver: { resolve: unknown } }).resolver = { resolve };
  const bag = new Map<string, string>();
  recordMaskOnlyValue(bag, 'noecho-handler-token-1');
  engine.perResourceSecrets.set('X', bag);
  return { engine, resolve };
}

describe('maskedInputSources - an attribute of a resource that read a secret this deploy', () => {
  const template: CloudFormationTemplate = { Resources: {} };

  it('keeps an attribute the save redacts as written: a mask-only needle filling the whole leaf, either GetAtt spelling', async () => {
    const { engine } = engineReturning('noecho-handler-token-1');
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    expect(await sources.resolve({ 'Fn::GetAtt': ['X', 'Echo'] })).toMatchObject({
      keepAsWritten: true,
    });
    expect(await sources.resolve({ 'Fn::GetAtt': 'X.Echo' })).toMatchObject({
      keepAsWritten: true,
    });
  });

  it('keeps one embedding an EXPRESSION needle, which the save replaces in place', async () => {
    const { engine } = engineReturning('postgres://u:db-password-77@h');
    engine.perResourceSecrets.set(
      'Y',
      new Map([['db-password-77', '{{resolve:secretsmanager:db:SecretString:pw}}']])
    );
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    expect(await sources.resolve({ 'Fn::GetAtt': ['Y', 'Url'] })).toMatchObject({
      keepAsWritten: true,
    });
  });

  it('resolves a mask-only needle only EMBEDDED in a longer value: the save persists that as written, so the next diff hashes it too', async () => {
    const { engine } = engineReturning('prefix-noecho-handler-token-1');
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    const attribute = await sources.resolve({ 'Fn::GetAtt': ['X', 'Echo'] });
    expect(attribute.keepAsWritten).toBeUndefined();
    expect(attribute.value).toBe('prefix-noecho-handler-token-1');
  });

  it('resolves an attribute that does not hold it, and a Ref (a physical id is persisted unredacted)', async () => {
    const { engine } = engineReturning('arn:aws:sns:us-east-1:1:x');
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    const attribute = await sources.resolve({ 'Fn::GetAtt': ['X', 'Arn'] });
    expect(attribute.keepAsWritten).toBeUndefined();
    expect(attribute.value).toBe('arn:aws:sns:us-east-1:1:x');
    const { engine: echoing } = engineReturning('noecho-handler-token-1');
    const refSources = echoing.maskedInputSources(template, {}, undefined, 's')!;
    expect((await refSources.resolve({ Ref: 'X' })).keepAsWritten).toBeUndefined();
  });
});

describe('maskedInputSources - a physical-id fallback is no input (go-to-k/cdkd#4543 W5)', () => {
  it('reads as unknown, without bumping the fallback counter or repeating its warning', async () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
    const template: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SNS::Topic', Properties: {} } },
    };
    engine.fingerprintParameters = parameterInputsFor({ template, values: {} });
    const resolver = (
      engine as unknown as {
        resolver: { getPhysicalIdFallbackCount(): number; logger: { warn: unknown } };
      }
    ).resolver;
    const warn = vi.fn();
    resolver.logger.warn = warn;
    const resources = {
      A: { physicalId: 'arn:aws:sns:us-east-1:1:a', resourceType: 'AWS::SNS::Topic', properties: {} },
    };
    const sources = engine.maskedInputSources(template, resources, undefined, 's')!;
    // An attribute no handler knows: the ordinary resolution would warn and
    // answer the physical id.
    await expect(sources.resolve({ 'Fn::GetAtt': ['A', 'NotAnAttribute'] })).rejects.toBeDefined();
    expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('maskedInputSources - what a node read reaches the screen (go-to-k/cdkd#4543 G1, G3)', () => {
  it('returns the bag the node recorded into, so a recovered secret output is kept as written', async () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
    const template: CloudFormationTemplate = { Resources: {} };
    engine.fingerprintParameters = parameterInputsFor({ template, values: {} });
    // A cross-stack read recovered in-process (`recoverMaskedOutput`): the
    // resolver re-registers the plaintext into the node's own bag.
    let plaintext = 'recovered-output-one';
    (engine as unknown as { resolver: { resolve: unknown } }).resolver = {
      resolve: vi.fn((_node: unknown, context: { recordedSecretValues: Map<string, string> }) => {
        recordMaskOnlyValue(context.recordedSecretValues, plaintext);
        return Promise.resolve(plaintext);
      }),
    };
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    const read = await sources.resolve({ 'Fn::ImportValue': 'shared' });
    expect([...(read.secrets?.keys() ?? [])]).toContain('recovered-output-one');
    const value = {
      'Fn::Base64': {
        'Fn::Join': ['', [{ 'Fn::ImportValue': 'shared' }, '{{resolve:ssm-secure:/p}}']],
      },
    };
    const first = await maskedInputFingerprint(value, sources);
    plaintext = 'recovered-output-two';
    // Kept as written: the hash does not move with (and so does not hold) it.
    expect(await maskedInputFingerprint(value, sources)).toBe(first);
  });

  it('never resolves a {{resolve:...}} reference a mapping value holds (skipDynamicReferences)', async () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
    const token = '{{resolve:ssm-secure:/app/pw}}';
    const template: CloudFormationTemplate = {
      Mappings: { M: { k: { v: token } } },
      Resources: {},
    } as CloudFormationTemplate;
    engine.fingerprintParameters = parameterInputsFor({ template, values: {} });
    const resolver = (engine as unknown as { resolver: { resolve: (...a: unknown[]) => unknown } })
      .resolver;
    const real = resolver.resolve.bind(resolver);
    const contexts: Array<Record<string, unknown>> = [];
    resolver.resolve = (node: unknown, context: unknown) => {
      contexts.push(context as Record<string, unknown>);
      return real(node, context);
    };
    const sources = engine.maskedInputSources(template, {}, undefined, 's')!;
    // Resolving it would need an SSM call this test does not mock.
    expect((await sources.resolve({ 'Fn::FindInMap': ['M', 'k', 'v'] })).value).toBe(token);
    // The context every input node resolves through: no reference resolved,
    // no healer, a physical-id fallback refused, and arrays of its own.
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      skipDynamicReferences: true,
      bestEffort: true,
      staleAttributeHeal: { phase: 'probe' },
      recordedImports: [],
      recordedOutputReads: [],
    });
    expect(contexts[0]!['attributeHealer']).toBeUndefined();
  });
});
