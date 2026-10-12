/**
 * A parameter declared `NoEcho: "true"` (the string) is NoEcho to
 * every reader of the flag (go-to-k/cdkd#4824): the deploy's diff log masker,
 * the resolver's needle recording, the export secret scan, the condition and
 * skipped-output records, the masked-input classes, the destroy's
 * re-resolution and the positional persist arm. One case per site, each with
 * the boolean and a non-NoEcho negative control.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const debugLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = {
    setLevel: (): void => undefined,
    debug: (...args: unknown[]): void => void debugLines.push(args.map(String).join(' ')),
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    child: (): unknown => quiet,
  };
  return { getLogger: () => quiet };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const { isNoEchoDeclared, declaresNoEcho } = await import(
  '../../../src/deployment/noecho-declared.js'
);
const { noEchoParameterNamesOf } = await import('../../../src/deployment/deploy-engine/noecho.js');
const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { noEchoParameterValueSeed } = await import(
  '../../../src/deployment/outputs-export-alias/secret-scan.js'
);
const { conditionFingerprint } = await import('../../../src/deployment/condition-verdicts.js');
const { skippedOutputDigest } = await import('../../../src/analyzer/skipped-outputs.js');
const { parameterInputsFor, nestedStackOutputClass } = await import(
  '../../../src/deployment/masked-property-fingerprints.js'
);
const { TemplateNoEchoReresolver } = await import(
  '../../../src/deployment/noecho-delete-reresolution.js'
);
const { divergentParameterNames } = await import(
  '../../../src/cli/commands/import-deployed-parameters.js'
);
const { maskSecretsInText } = await import('../../../src/deployment/secret-redaction.js');
const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const VALUE = 'string-form-noecho-value-4824';
/** The spellings CloudFormation declares NoEcho with, and ones that are not. */
const DECLARED: unknown[] = [true, 'true'];
// A case variant stays OUT: the persist and compare arms never marked one, so
// widening them would replace a create-only resource on the next deploy.
const NOT_DECLARED: unknown[] = [false, 'false', undefined, 1, 'yes', 'True', 'TRUE'];

const template = (noEcho: unknown, extra: Partial<CloudFormationTemplate> = {}) =>
  ({
    Parameters: { P: { Type: 'String', NoEcho: noEcho, Default: VALUE } },
    Resources: {},
    ...extra,
  }) as unknown as CloudFormationTemplate;

describe('isNoEchoDeclared / declaresNoEcho (go-to-k/cdkd#4824)', () => {
  it('accepts the boolean and the string "true", and nothing else', () => {
    for (const v of DECLARED) expect(isNoEchoDeclared(v), String(v)).toBe(true);
    for (const v of NOT_DECLARED) expect(isNoEchoDeclared(v), String(v)).toBe(false);
    expect(declaresNoEcho({ NoEcho: 'true' })).toBe(true);
    expect(declaresNoEcho({ NoEcho: 'True' })).toBe(false);
    expect(declaresNoEcho(null)).toBe(false);
    expect(declaresNoEcho('NoEcho')).toBe(false);
  });
});

describe('each NoEcho reader honours the string form (go-to-k/cdkd#4824)', () => {
  it('noEchoParameterNamesOf (the positional persist arm)', () => {
    for (const v of DECLARED) expect(noEchoParameterNamesOf(template(v)).has('P'), String(v)).toBe(true);
    expect(noEchoParameterNamesOf(template(false)).has('P')).toBe(false);
  });

  it("the deploy's diff log masker (deploy-engine/masking.ts)", () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    ) as unknown as {
      diffLogMasker: (
        d: RecordedSecretValues | undefined,
        t: CloudFormationTemplate,
        p: Record<string, unknown>,
        r: Record<string, unknown>
      ) => (text: string) => string;
    };
    for (const v of DECLARED) {
      const masker = engine.diffLogMasker(new Map(), template(v), { P: VALUE }, {});
      expect(masker(`from "${VALUE}"`), String(v)).toBe('from "***"');
    }
    const plain = engine.diffLogMasker(new Map(), template(false), { P: VALUE }, {});
    expect(plain(`from "${VALUE}"`)).toBe(`from "${VALUE}"`);

    // A piece of an `Fn::Split` over the value (go-to-k/cdkd#4049): the
    // delimiters are read only for a parameter the masker counts as NoEcho.
    const split = (noEcho: unknown) =>
      template(noEcho, {
        Resources: {
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'P' }] }] } },
          },
        },
      });
    const pieces = { P: 'alpha-first-piece,bravo-second-piece' };
    for (const v of DECLARED) {
      const masker = engine.diffLogMasker(new Map(), split(v), pieces, {});
      expect(masker('old "bravo-second-piece"'), String(v)).toBe('old "***"');
    }
    expect(engine.diffLogMasker(new Map(), split(false), pieces, {})('old "bravo-second-piece"')).toBe(
      'old "bravo-second-piece"'
    );
  });

  it("the resolver's NoEcho needle (parameter-secrets.ts recordNoEchoParameterValue)", async () => {
    const resolve = async (noEcho: unknown): Promise<RecordedSecretValues> => {
      const bag: RecordedSecretValues = new Map();
      await new IntrinsicFunctionResolver('us-east-1').resolve(
        { 'Fn::Join': ['', ['x-', { Ref: 'P' }]] },
        {
          template: template(noEcho),
          resources: {},
          parameters: { P: VALUE },
          recordedSecretValues: bag,
        }
      );
      return bag;
    };
    for (const v of DECLARED) {
      expect(maskSecretsInText(`v ${VALUE}`, await resolve(v)), String(v)).toBe('v ***');
    }
    expect(maskSecretsInText(`v ${VALUE}`, await resolve(false))).toBe(`v ${VALUE}`);
  });

  it("the resolver's Ref-to-parameter line renders the bare redaction marker (refs.ts)", async () => {
    const lineFor = async (noEcho: unknown): Promise<string | undefined> => {
      debugLines.length = 0;
      await new IntrinsicFunctionResolver('us-east-1').resolve(
        { Ref: 'P' },
        { template: template(noEcho), resources: {}, parameters: { P: VALUE } }
      );
      return debugLines.find((l) => l.startsWith('Resolved Ref to parameter: P'));
    };
    for (const v of DECLARED) {
      expect(await lineFor(v), String(v)).toBe('Resolved Ref to parameter: P resolved to <redacted>');
    }
    // Negative control: an ordinary parameter prints its value.
    expect(await lineFor(false)).toBe(`Resolved Ref to parameter: P resolved to ${VALUE}`);
  });

  it('the export secret scan seed (secret-scan.ts noEchoParameterValueSeed)', () => {
    for (const v of DECLARED) {
      const seed = noEchoParameterValueSeed({ P: { NoEcho: v, Type: 'String' } }, { P: VALUE });
      expect(maskSecretsInText(`e ${VALUE}`, seed), String(v)).toBe('e ***');
    }
    const plain = noEchoParameterValueSeed({ P: { NoEcho: false, Type: 'String' } }, { P: VALUE });
    expect(maskSecretsInText(`e ${VALUE}`, plain)).toBe(`e ${VALUE}`);
  });

  it('a condition verdict is never recorded over a NoEcho value (condition-verdicts.ts)', () => {
    const t = (noEcho: unknown) =>
      template(noEcho, { Conditions: { C: { 'Fn::Equals': [{ Ref: 'P' }, 'x'] } } });
    const input = () => ({ kind: 'value' as const, value: VALUE });
    for (const v of DECLARED) expect(conditionFingerprint(t(v), 'C', input), String(v)).toBeUndefined();
    expect(conditionFingerprint(t(false), 'C', input)).toBeDefined();
  });

  it("the skipped-output digest masks a NoEcho Default (skipped-outputs.ts)", () => {
    const withDefault = (noEcho: unknown, value: string) =>
      ({
        Parameters: { P: { Type: 'String', NoEcho: noEcho, Default: value } },
        Resources: {},
        Outputs: { O: { Value: { Ref: 'P' } } },
      }) as unknown as CloudFormationTemplate;
    for (const v of DECLARED) {
      expect(skippedOutputDigest(withDefault(v, 'a'), 'O'), String(v)).toBe(
        skippedOutputDigest(withDefault(v, 'b'), 'O')
      );
    }
    expect(skippedOutputDigest(withDefault(false, 'a'), 'O')).not.toBe(
      skippedOutputDigest(withDefault(false, 'b'), 'O')
    );
  });

  it("the masked-input classes, top level and a nested child's (masked-property-fingerprints.ts)", async () => {
    for (const v of DECLARED) {
      const { parameterInput } = parameterInputsFor({ template: template(v), values: { P: VALUE } });
      expect(parameterInput('P'), String(v)).toEqual({ kind: 'secret' });
    }
    // Negative controls, a case variant included: this arm compares, so it
    // must not widen past the persist arm's spellings.
    for (const v of [false, 'True', 'TRUE']) {
      const { parameterInput } = parameterInputsFor({ template: template(v), values: { P: VALUE } });
      expect(parameterInput('P'), String(v)).toEqual({ kind: 'value', value: VALUE });
    }

    const classOf = (noEcho: unknown) => {
      const parent = {
        Resources: {
          Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u', Parameters: {} } },
        },
      } as unknown as CloudFormationTemplate;
      const child = {
        Parameters: { P: { Type: 'String', NoEcho: noEcho, Default: 'clean-default' } },
        Resources: {},
        Outputs: { O: { Value: { Ref: 'P' } } },
      } as unknown as CloudFormationTemplate;
      return nestedStackOutputClass('Child', 'Outputs.O', {
        template: parent,
        parameterInput: () => ({ kind: 'unknown' }),
        resolve: () => Promise.reject(new Error('unresolvable')),
        childTemplate: (id: string) =>
          id === 'Child' ? { template: child, identity: 'child', childTemplate: () => undefined } : undefined,
      } as never);
    };
    for (const v of DECLARED) expect(await classOf(v), String(v)).toBe('secret');
    expect(await classOf(false)).toBe('clean');
  });

  it("cdkd destroy's re-resolution source (noecho-delete-reresolution.ts)", async () => {
    for (const v of DECLARED) {
      const bag = await new TemplateNoEchoReresolver({
        template: template(v),
        stackName: 'S',
        region: 'us-east-1',
      }).printingNoEchoValues();
      expect(bag && maskSecretsInText(`d ${VALUE}`, bag), String(v)).toBe('d ***');
    }
    expect(
      await new TemplateNoEchoReresolver({
        template: template(false),
        stackName: 'S',
        region: 'us-east-1',
      }).printingNoEchoValues()
    ).toBeUndefined();
  });

  it('cdkd import never proves a NoEcho parameter (import-deployed-parameters.ts)', () => {
    for (const v of DECLARED) {
      expect(
        divergentParameterNames(template(v), { P: VALUE }, { provablyEquals: () => true } as never).has('P'),
        String(v)
      ).toBe(true);
    }
    expect(divergentParameterNames(template(false), { P: VALUE }, { provablyEquals: () => true } as never).has('P')).toBe(
      false
    );
  });
});
