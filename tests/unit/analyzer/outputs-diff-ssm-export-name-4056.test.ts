/**
 * Issue #4056: the diff's Outputs preview refused an intrinsic `Export.Name`
 * alias only when the resolved name carried a `secretsmanager:` / `ssm-secure:`
 * spelling. A plain `{{resolve:ssm:...}}` to a `SecureString` keeps its token
 * through the diff's `skipDynamicReferences` pass too, so the preview published
 * an alias the deploy refuses: a phantom `[export]` ADD on every run, and
 * `cdkd diff --fail` never green.
 *
 * The end-to-end cases run through `computeStackDiff` with the REAL resolver
 * and a mocked `GetParameter`, the shape the issue measured.
 */

import { afterEach, describe, it, expect, vi } from 'vite-plus/test';

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

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return { ...original, getAwsClients: () => ({ ssm: { send: ssmSend } }) };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { computeOutputsDiff, resolveTemplateOutputs } from '../../../src/analyzer/outputs-diff.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { exportNameSecretExposure } from '../../../src/deployment/outputs-export-alias.js';
import { clearRecordedSecretExpressions } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const SSM_REF = '{{resolve:ssm:/sec/p}}';
/** The issue's `Export.Name`: an intrinsic assembling a plain ssm reference. */
const SSM_EXPORT_NAME = { 'Fn::Join': ['', ['app-', SSM_REF]] } as unknown as string;

const backend = { getState: async () => null } as unknown as S3StateBackend;

function template(outputs: CloudFormationTemplate['Outputs']): CloudFormationTemplate {
  return {
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: outputs,
  };
}

function stateWith(outputs: Record<string, unknown>): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      A: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs,
    version: 6,
    lastModified: 0,
  };
}

/** `[changeType, name, isExport]` per row, the issue's measured shape. */
async function outputRows(
  stored: Record<string, unknown>,
  tpl: CloudFormationTemplate
): Promise<Array<[string, string, boolean]>> {
  const { outputChanges } = await computeStackDiff(
    stateWith(stored),
    tpl,
    'us-east-1',
    'S',
    backend,
    new DiffCalculator()
  );
  return outputChanges.map((c) => [c.changeType, c.name, c.isExport]);
}

afterEach(() => {
  ssmSend.mockReset();
  clearRecordedSecretExpressions();
});

describe('an intrinsic Export.Name carrying a plain ssm reference (issue #4056)', () => {
  it('previews NO alias for a SecureString parameter, as the deploy refuses it', async () => {
    // The issue's repro: the bag holds `{Exp: 'v'}` and the template is
    // unchanged, so the preview must report nothing. Before the fix this came
    // back as `[["ADD","app-{{resolve:ssm:/sec/p}}",true]]`.
    ssmSend.mockResolvedValue({ Parameter: { Value: 'AQICencrypted', Type: 'SecureString' } });

    const rows = await outputRows(
      { Exp: 'v' },
      template({ Exp: { Value: 'v', Export: { Name: SSM_EXPORT_NAME } } })
    );

    expect(rows).toEqual([]);
  });

  it('still previews the alias for a String parameter, which resolves to its value', async () => {
    // The negative control: a public parameter leaves no token, and the deploy
    // publishes the alias under the resolved name, so the preview shows it.
    ssmSend.mockResolvedValue({ Parameter: { Value: 'PlainValue', Type: 'String' } });

    const rows = await outputRows(
      { Exp: 'v' },
      template({ Exp: { Value: 'v', Export: { Name: SSM_EXPORT_NAME } } })
    );

    expect(rows).toEqual([['ADD', 'app-PlainValue', true]]);
  });

  it('the deploy side refuses the same name: its real resolution records the plaintext', async () => {
    // The parity half the issue inferred from reading the code. The deploy
    // resolves the name WITHOUT `skipDynamicReferences`, recording what it
    // substituted into a per-name map, and `exportNameSecretExposure` over
    // that map is its refusal.
    ssmSend.mockResolvedValue({ Parameter: { Value: 'hunter2pass', Type: 'SecureString' } });
    const nameSecrets = new Map<string, string>();

    const resolved = await new IntrinsicFunctionResolver().resolve(structuredClone(SSM_EXPORT_NAME), {
      template: template({}),
      resources: {},
      recordedSecretValues: nameSecrets,
    });

    expect(resolved).toBe('app-hunter2pass');
    expect(exportNameSecretExposure(resolved as string, nameSecrets)).toEqual(
      new Map([['hunter2pass', SSM_REF]])
    );
  });
});

describe('a stored value beside a SecureString ssm output (issue #4056 sweep)', () => {
  const tpl = (): CloudFormationTemplate =>
    template({ Out: { Value: SSM_REF }, Other: { Value: 'o2' } });

  it('WITHHOLDS a pre-#1901 record that stored the parameter plaintext', async () => {
    // A binary before issue #1901 resolved a plain ssm reference and stored
    // its value. The diff keeps the token for a SecureString, so the desired
    // side is the secret's expression and the record is pre-GHSA: its values
    // are withheld record-wide, as for a `secretsmanager` one.
    ssmSend.mockResolvedValue({ Parameter: { Value: 'AQICencrypted', Type: 'SecureString' } });

    const { outputChanges } = await computeStackDiff(
      stateWith({ Out: 'hunter2pass', Other: 'o1' }),
      tpl(),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );

    expect(JSON.stringify(outputChanges)).not.toContain('hunter2pass');
    expect(outputChanges).toEqual([
      expect.objectContaining({ name: 'Out', changeType: 'MODIFY', oldValueRedacted: true }),
      expect.objectContaining({ name: 'Other', changeType: 'MODIFY', oldValueRedacted: true }),
    ]);
  });

  it('keeps previous values on a record that stores the token as its expression', async () => {
    // The veto half: a post-#1901 deploy stores the token itself, and reading
    // the desired side's token as a secret without reading the stored one the
    // same way would withhold `o1` on every such stack.
    ssmSend.mockResolvedValue({ Parameter: { Value: 'AQICencrypted', Type: 'SecureString' } });

    const { outputChanges } = await computeStackDiff(
      stateWith({ Out: SSM_REF, Other: 'o1' }),
      tpl(),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );

    expect(outputChanges).toEqual([
      { name: 'Other', changeType: 'MODIFY', oldValue: 'o1', newValue: 'o2', isExport: false },
    ]);
  });

  it('prints previous values for a String parameter, which resolves to its value', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'PlainValue', Type: 'String' } });

    const { outputChanges } = await computeStackDiff(
      stateWith({ Out: 'OldPlain', Other: 'o1' }),
      tpl(),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );

    expect(outputChanges).toEqual([
      { name: 'Out', changeType: 'MODIFY', oldValue: 'OldPlain', newValue: 'PlainValue', isExport: false },
      { name: 'Other', changeType: 'MODIFY', oldValue: 'o1', newValue: 'o2', isExport: false },
    ]);
  });
});

describe('the stored-side ssm veto needs the whole shape, not a substring (review M1)', () => {
  const MIXED_DESIRED = `${SSM_REF}-{{resolve:secretsmanager:S}}`;

  it.each([
    // `cdkd scrub` named the ssm secret and not the rotated secretsmanager one.
    ['a token beside a plaintext where the desired side has a token', `${SSM_REF}-OLDSECRET`, MIXED_DESIRED],
    ['a token beside a plaintext under a different literal', `x-${SSM_REF}-OLDSECRET`, `x-${SSM_REF}-{{resolve:secretsmanager:S}}`],
    // Fails closed: the literal changed, so the shapes no longer line up.
    ['a redacted expression whose literal part changed', `old-${SSM_REF}`, `new-${SSM_REF}`],
  ])('withholds the record for %s', (_label, stored, desired) => {
    const changes = computeOutputsDiff(
      { Out: stored, Other: 'o1' },
      { Out: desired, Other: 'o2' },
      new Set(),
      new Set(['Out'])
    );
    expect(JSON.stringify(changes)).not.toContain('OLDSECRET');
    for (const change of changes) expect(change.oldValueRedacted).toBe(true);
  });

  it.each([
    ['one whole token, whatever the desired side is', SSM_REF, `new-${SSM_REF}`],
    ['a mixed expression with the desired side literal parts', `app-${SSM_REF}-x`, `app-${SSM_REF}-x`],
    ['a mixed expression whose token changed under the same literals', `app-${SSM_REF}-x`, 'app-{{resolve:ssm:/sec/q}}-x'],
  ])('keeps previous values for %s', (_label, stored, desired) => {
    const changes = computeOutputsDiff(
      { Out: stored, Other: 'o1' },
      { Out: desired, Other: 'o2' },
      new Set(),
      new Set(['Out'])
    );
    expect(changes.find((c) => c.name === 'Other')).toEqual({
      name: 'Other',
      changeType: 'MODIFY',
      oldValue: 'o1',
      newValue: 'o2',
      isExport: false,
    });
  });
});

describe('resolveTemplateOutputs: which surviving tokens refuse an intrinsic alias', () => {
  /** A resolver that hands back `name` for the Export.Name and `v` for the value. */
  const resolverReturning =
    (name: string) =>
    async (value: unknown): Promise<unknown> =>
      typeof value === 'string' ? value : name;

  const exporting = (declaredName: unknown): CloudFormationTemplate =>
    template({ Exp: { Value: 'v', Export: { Name: declaredName as string } } });

  it.each([
    ['a plain ssm token', `app-${SSM_REF}`],
    ['an ssm-secure token', 'app-{{resolve:ssm-secure:/sec/p}}'],
    ['a secretsmanager token', 'app-{{resolve:secretsmanager:db:SecretString:pw}}'],
    ['a colon-less ssm-secure token, read as the resolver reads it', 'app-{{resolve:ssm-secure}}'],
    ['a secret token beside an unsupported one', `app-{{resolve:foo:bar}}-${SSM_REF}`],
  ])('skips the alias for %s, without suppressing the section', async (_label, resolvedName) => {
    const r = await resolveTemplateOutputs(
      exporting({ 'Fn::Join': ['', ['x']] }),
      resolverReturning(resolvedName)
    );

    expect(r.outputs).toEqual({ Exp: 'v' });
    expect([...r.exportNames]).toEqual([]);
    expect(r.resolutionFailed).toBe(false);
  });

  it('publishes the alias for a token of a service the resolver does not resolve', async () => {
    // The resolver warns on an unsupported service and leaves the token as
    // written on the deploy path too: nothing is substituted, nothing is
    // recorded, and the deploy publishes the alias. Refusing it here would be
    // the inverse phantom.
    const resolvedName = 'app-{{resolve:foo:bar}}';
    const r = await resolveTemplateOutputs(
      exporting({ 'Fn::Join': ['', ['x']] }),
      resolverReturning(resolvedName)
    );

    expect(r.outputs).toEqual({ Exp: 'v', [resolvedName]: 'v' });
    expect([...r.exportNames]).toEqual([resolvedName]);
  });

  it('publishes a LITERAL name spelled with a plain ssm token, as the deploy does', async () => {
    // The deploy uses a string `Export.Name` verbatim and substitutes nothing,
    // so the intrinsic gate must keep holding for the widened test.
    const literalName = `app-${SSM_REF}`;
    const r = await resolveTemplateOutputs(exporting(literalName), resolverReturning('unused'));

    expect(r.outputs).toEqual({ Exp: 'v', [literalName]: 'v' });
    expect([...r.exportNames]).toEqual([literalName]);
  });
});
