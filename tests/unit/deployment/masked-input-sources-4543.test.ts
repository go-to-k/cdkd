import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { parameterInputsFor } from '../../../src/deployment/masked-property-fingerprints.js';
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
