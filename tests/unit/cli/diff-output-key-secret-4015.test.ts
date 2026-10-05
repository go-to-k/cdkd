/**
 * Issue #4015: `cdkd diff` printed each stored Outputs-bag KEY through
 * `stripControlChars` with no secret test, so an alias key an older binary
 * published holding a resolved secret printed it — contiguous, or split by
 * U+2028 / U+2029, which that strip keeps and the logger's sink blanks to a
 * space.
 *
 * Every row name now prints only `secretSafeKeyDisplay`'s verdict, on the human
 * path and in `--json`. The cases run end to end through `computeStackDiff`
 * with the real resolver, since the corpus is threaded from its resolve pass.
 */

import { describe, it, expect, vi } from 'vite-plus/test';

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

import {
  computeStackDiff,
  diffTreeToJson,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  computeOutputsDiff,
  secretSpanInStoredKey,
  type OutputChange,
} from '../../../src/analyzer/outputs-diff.js';
import { skippedOutputDigest } from '../../../src/analyzer/skipped-outputs.js';
import { WITHHELD_NAME_DISPLAY } from '../../../src/deployment/outputs-export-alias.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const SECRET = 'hunter2pass';
const SECRET_REF = '{{resolve:secretsmanager:prod/db:SecretString:pw}}';
/** The `Export.Name` shape a CDK app renders around a secret value. */
const SECRET_EXPORT_NAME = { 'Fn::Join': ['', ['App', SECRET_REF]] };

const backend = {
  getState: async () => null,
} as unknown as S3StateBackend;

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

function template(outputs: CloudFormationTemplate['Outputs']): CloudFormationTemplate {
  return {
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: outputs,
  };
}

/** A post-GHSA record whose secret output stores its expression, as today's deploy writes. */
const exportingTemplate = (): CloudFormationTemplate =>
  template({
    DbSecret: { Value: SECRET_REF },
    Exp: { Value: 'v', Export: { Name: SECRET_EXPORT_NAME as unknown as string } },
  });

async function outputChangesFor(
  state: StackState,
  tpl: CloudFormationTemplate
): Promise<OutputChange[]> {
  const { outputChanges } = await computeStackDiff(
    state,
    tpl,
    'us-east-1',
    'S',
    backend,
    new DiffCalculator()
  );
  return outputChanges;
}

function rendered(outputChanges: readonly OutputChange[]): string {
  const lines: string[] = [];
  renderOutputChangeLines(outputChanges, (m) => lines.push(m));
  return lines.join('\n');
}

function jsonNames(outputChanges: OutputChange[]): unknown[] {
  const node = {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: new Map(),
    ccApiRoutes: new Map(),
    outputChanges,
    adoptedOrphans: [],
    blocking: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: [],
    children: [],
  } as unknown as DiffTreeNode;
  return diffTreeToJson(node).outputChanges.map((c) => ({
    name: c.name,
    ...(c.nameRedacted ? { nameRedacted: c.nameRedacted } : {}),
  }));
}

describe('a stored alias key holding a secret (issue #4015)', () => {
  it('masks a CONTIGUOUS secret in the row name and in --json', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}`]: 'v' }),
      exportingTemplate()
    );
    expect(changes.map((c) => c.changeType)).toEqual(['REMOVE']);
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
    expect(jsonNames(changes)).toEqual([{ name: 'App***', nameRedacted: true }]);
    expect(JSON.stringify(jsonNames(changes))).not.toContain(SECRET);
  });

  it('masks a secret split by U+2028, which the logger would have printed as a space', async () => {
    // A v9 record whose `exportNames` does not list the key, so the alias-name
    // refusal stays off and the split span itself is what is tested.
    for (const split of ['hunter2\u2028pass', 'hunter2\u2029pass']) {
      const changes = await outputChangesFor(
        { ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${split}`]: 'v' }), exportNames: [] },
        exportingTemplate()
      );
      const text = rendered(changes);
      expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
      expect(text).not.toContain('hunter2');
      expect(jsonNames(changes)).toEqual([{ name: 'App***', nameRedacted: true }]);
    }
  });

  it('masks a span shorter than the containment floor, since the name proves it was substituted', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', 'Apppw': 'v' }),
      exportingTemplate()
    );
    expect(rendered(changes)).toContain('    [-] App*** (name masked: it contains a secret)');
  });

  it('prints an innocent key bare, beside the masked one', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}`]: 'v', 'OldOutput': 'o' }),
      exportingTemplate()
    );
    const text = rendered(changes);
    expect(text).toContain('    [-] OldOutput\n');
    expect(jsonNames(changes)).toEqual([
      { name: `App***`, nameRedacted: true },
      { name: 'OldOutput' },
    ]);
  });

  it("prints a DECLARED key bare even when it has the secret export name's shape", async () => {
    // Only a key today's template cannot account for is matched against the
    // export name: a declared output was resolved, and substituted nothing.
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', 'AppThing': 'old' }),
      template({
        DbSecret: { Value: SECRET_REF },
        Exp: { Value: 'v', Export: { Name: SECRET_EXPORT_NAME as unknown as string } },
        'AppThing': { Value: 'new' },
      })
    );
    expect(rendered(changes)).toContain('    [~] AppThing\n');
    expect(jsonNames(changes)).toEqual([{ name: 'AppThing' }]);
  });

  it('masks a key holding a stored value a pre-GHSA record withholds', async () => {
    // Today's template no longer exports the secret, so no export-name span
    // applies; the record's stored plaintext is the corpus.
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET, [`App${SECRET}`]: 'v' }),
      template({ DbSecret: { Value: SECRET_REF } })
    );
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });

  it('masks a key holding the stored value of another key the template cannot account for', async () => {
    // Not a pre-GHSA record by pass 1 (no output is secret-bearing), but the
    // template still references a secret, so the deleted key's value is
    // withheld per key -- and is the corpus for the other rows' names.
    const state = stateWith({ Deleted: SECRET, [`App${SECRET}`]: 'v' });
    state.resources['A']!.properties = { Value: 'x', Description: SECRET_REF };
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x', Description: SECRET_REF } },
      },
      Outputs: { Kept: { Value: 'k' } },
    };
    const changes = await outputChangesFor(state, tpl);
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });

  it('masks an ADDED key the corpus holds', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET }),
      template({ DbSecret: { Value: SECRET_REF }, [`${SECRET}Url`]: { Value: 'u' } })
    );
    const text = rendered(changes);
    expect(text).toContain('    [+] ***Url (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });

  it('withholds a key whose secret masking cannot reach (split by a nonspacing mark)', async () => {
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET, 'Apphunter\u03012pass': 'v' }), exportNames: [] },
      template({ DbSecret: { Value: SECRET_REF } })
    );
    const text = rendered(changes);
    expect(text).toContain(`    [-] ${WITHHELD_NAME_DISPLAY}`);
    expect(text).not.toContain('hunter');
    expect(jsonNames(changes)).toEqual([
      { name: 'DbSecret' },
      { name: WITHHELD_NAME_DISPLAY, nameRedacted: true },
    ]);
  });

  it('withholds a MASKED name carrying non-ASCII, rather than print text a sink may reshape', async () => {
    const changes = await outputChangesFor(
      {
        ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}-\u00e9`]: 'v' }),
        exportNames: [],
      },
      template({
        DbSecret: { Value: SECRET_REF },
        Exp: {
          Value: 'v',
          Export: { Name: { 'Fn::Join': ['', ['App', SECRET_REF, '-\u00e9']] } as unknown as string },
        },
      })
    );
    const text = rendered(changes);
    expect(text).toContain(`    [-] ${WITHHELD_NAME_DISPLAY}`);
    expect(text).not.toContain(SECRET);
    // `--json` keeps the masked text: no sink reshapes it there.
    expect(jsonNames(changes)).toEqual([{ name: 'App***-\u00e9', nameRedacted: true }]);
  });
});

describe('an exporter the loop leaves before its alias block (issue #4015 review)', () => {
  it('masks the stored alias of a CONDITION-FALSE exporter', async () => {
    const tpl: CloudFormationTemplate = {
      ...exportingTemplate(),
      Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
    };
    tpl.Outputs!['Exp']!.Condition = 'Off';
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}`]: 'v' }),
      tpl
    );
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(jsonNames(changes))).not.toContain(SECRET);
  });

  it('masks the stored alias of an exporter a #2740 record previews as absent', async () => {
    const tpl = exportingTemplate();
    const state: StackState = {
      ...stateWith({ DbSecret: SECRET_REF, [`App${SECRET}`]: 'v' }),
      skippedOutputs: { Exp: skippedOutputDigest(tpl, 'Exp') },
    };
    const changes = await outputChangesFor(state, tpl);
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });
});

describe('what the corpus and the span do NOT reach (issue #4015 review)', () => {
  it('does not mask a name holding an innocent value of a pre-GHSA record', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET, Stage: 'prod', 'prodOldApi': 'x' }),
      template({ DbSecret: { Value: SECRET_REF }, Stage: { Value: 'prod' } })
    );
    expect(rendered(changes)).toContain('    [-] prodOldApi\n');
  });

  it("takes a nested stored value's leaves into the corpus", async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: [{ Password: SECRET }], [`App${SECRET}`]: 'v' }),
      template({ DbSecret: { Value: [{ Password: SECRET_REF }] as unknown as string } })
    );
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });

  it('takes the whole bag when the merge preview FORCES the legacy verdict', () => {
    const changes = computeOutputsDiff(
      { Carried: SECRET, [`x-${SECRET}`]: 'v' },
      { Carried: SECRET },
      new Set(),
      new Set(),
      { forceLegacyRecord: true }
    );
    expect(rendered(changes)).toContain('    [-] x-*** (name masked: it contains a secret)');
  });

  it("does not take an accountable key's value on a record that is not pre-GHSA", async () => {
    // `Deleted` is unaccountable, so its value is a candidate; `Kept` is
    // declared, so its ordinary value must not mask another row's name.
    const state = stateWith({ Kept: 'keptvalue', Deleted: 'zzzz', 'keptvalueOld': 'o' });
    state.resources['A']!.properties = { Value: 'x', Description: SECRET_REF };
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x', Description: SECRET_REF } },
      },
      Outputs: { Kept: { Value: 'keptvalue' } },
    };
    const text = rendered(await outputChangesFor(state, tpl));
    expect(text).toContain('    [-] keptvalueOld\n');
  });

  it('prints bare a RESOLVED alias that has the secret export name\'s shape', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', Other: 'o', 'AppThing': 'old' }),
      template({
        DbSecret: { Value: SECRET_REF },
        Exp: { Value: 'v', Export: { Name: SECRET_EXPORT_NAME as unknown as string } },
        Other: {
          Value: 'o',
          Export: { Name: { 'Fn::Join': ['', ['App', 'Thing']] } as unknown as string },
        },
      })
    );
    expect(rendered(changes)).toContain('    [~] AppThing [export]\n');
  });

  it('prints bare a DECLARED condition-false output that has the shape', async () => {
    const tpl: CloudFormationTemplate = {
      ...exportingTemplate(),
      Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
    };
    // Hyphenated, so the alias-name refusal would withhold it were it not
    // declared.
    tpl.Outputs!['App-Gone'] = { Value: 'g', Condition: 'Off' };
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', 'App-Gone': 'g' }),
      tpl
    );
    expect(rendered(changes)).toContain('    [-] App-Gone\n');
  });

  it('masks a stale sibling alias sharing the literal ends (stated over-masking)', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', 'AppBucketArn': 'v' }),
      exportingTemplate()
    );
    expect(rendered(changes)).toContain('    [-] App*** (name masked: it contains a secret)');
  });

  it('keeps a SAFE name byte-faithful in --json while the human row strips it', async () => {
    const key = 'Old\u001b[31m';
    const changes = await outputChangesFor(stateWith({ [key]: 'o' }), template({}));
    expect(jsonNames(changes)).toEqual([{ name: key }]);
    expect(rendered(changes)).toContain('    [-] Old[31m\n');
  });
});

describe('the alias-name refusal (issue #4015, maintainer decision)', () => {
  /** The post-GHSA record after the exporter was REMOVED from the template. */
  const removedExporter = (): CloudFormationTemplate => template({ DbSecret: { Value: SECRET_REF } });
  const WITHHELD_ROW = `    [-] ${WITHHELD_NAME_DISPLAY}`;

  it('withholds a removed alias on a post-GHSA record, pre-v9 hyphenated key', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`app-${SECRET}`]: 'v' }),
      removedExporter()
    );
    const text = rendered(changes);
    expect(text).toContain(WITHHELD_ROW);
    expect(text).not.toContain(SECRET);
    expect(jsonNames(changes)).toContainEqual({
      name: WITHHELD_NAME_DISPLAY,
      nameRedacted: true,
    });
    expect(JSON.stringify(jsonNames(changes))).not.toContain(SECRET);
  });

  it('withholds a hyphenated alias the v9 record lists in exportNames', async () => {
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET_REF, [`app-${SECRET}`]: 'v' }), exportNames: [`app-${SECRET}`] },
      removedExporter()
    );
    const text = rendered(changes);
    expect(text).toContain(WITHHELD_ROW);
    expect(text).not.toContain(SECRET);
  });

  it('prints an ALPHANUMERIC alias the v9 record lists: the widened bound', async () => {
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET_REF, [`App${SECRET}`]: 'v' }), exportNames: [`App${SECRET}`] },
      removedExporter()
    );
    expect(rendered(changes)).toContain(`    [-] App${SECRET}\n`);
  });

  it('prints a removed SELF-ALIASED output, which the deploy lists in exportNames', async () => {
    // `new CfnOutput(this, 'UserPoolId', { exportName: 'UserPoolId' })`: the
    // output key and its alias are one key, and `exportNames` lists it.
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET_REF, UserPoolId: 'pool' }), exportNames: ['UserPoolId'] },
      removedExporter()
    );
    expect(rendered(changes)).toContain('    [-] UserPoolId\n');
    expect(jsonNames(changes)).toEqual([{ name: 'UserPoolId' }]);
  });

  it('falls back to the key shape when exportNames is malformed', async () => {
    const changes = await outputChangesFor(
      {
        ...stateWith({ DbSecret: SECRET_REF, [`app-${SECRET}`]: 'v' }),
        exportNames: 'junk' as unknown as string[],
      },
      template({ DbSecret: { Value: SECRET_REF } })
    );
    expect(rendered(changes)).toContain(`    [-] ${WITHHELD_NAME_DISPLAY}`);
  });

  it('prints a v9 key exportNames does not list, even hyphenated', async () => {
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET_REF, 'Old-Thing': 'v' }), exportNames: [] },
      removedExporter()
    );
    expect(rendered(changes)).toContain('    [-] Old-Thing\n');
  });

  it('prints a removed ordinary Output key in a secret-bearing stack', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, OldOutput: 'v' }),
      removedExporter()
    );
    expect(rendered(changes)).toContain('    [-] OldOutput\n');
    expect(jsonNames(changes)).toEqual([{ name: 'OldOutput' }]);
  });

  it('prints an alphanumeric pre-v9 alias holding a secret: the recorded bound', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF, [`App${SECRET}`]: 'v' }),
      removedExporter()
    );
    expect(rendered(changes)).toContain(`    [-] App${SECRET}\n`);
  });

  it('withholds nothing in a stack whose template references no secret', async () => {
    const changes = await outputChangesFor(
      stateWith({ Plain: 'p', [`app-${SECRET}`]: 'v' }),
      template({ Plain: { Value: 'p' } })
    );
    expect(rendered(changes)).toContain(`    [-] app-${SECRET}\n`);
    expect(jsonNames(changes)).toEqual([{ name: `app-${SECRET}` }]);
  });

  it('withholds only REMOVE rows: an added hyphenated alias prints', async () => {
    const changes = await outputChangesFor(
      stateWith({ DbSecret: SECRET_REF }),
      template({ DbSecret: { Value: SECRET_REF }, New: { Value: 'n', Export: { Name: { 'Fn::Join': ['-', ['S', 'New']] } as unknown as string } } })
    );
    expect(rendered(changes)).toContain('    [+] S-New [export]\n');
  });
});

describe('an exporter whose VALUE fails (issue #4015 review, E2)', () => {
  it('masks the stale alias of a renamed exporter whose value fails', async () => {
    const changes = await outputChangesFor(
      { ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}`]: 'v' }), exportNames: [] },
      template({
        DbSecret: { Value: SECRET_REF },
        Exp2: {
          Value: { 'Fn::GetAtt': ['Gone', 'Arn'] } as unknown as string,
          Export: { Name: SECRET_EXPORT_NAME as unknown as string },
        },
      })
    );
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });

  it('masks the stale alias of an exporter whose value resolves to undefined', async () => {
    // `StreamArn` is constructible-but-unknown: the resolver returns
    // `undefined` without throwing, which is the unresolved arm the merge
    // preview still renders (a top-level `undefined` mirrors the deploy).
    const table = {
      physicalId: 'tbl',
      resourceType: 'AWS::DynamoDB::Table',
      properties: { KeySchema: [] },
      attributes: {},
      dependencies: [],
    };
    const state = {
      ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`App${SECRET}`]: 'v' }),
      exportNames: [],
    };
    state.resources['T'] = table;
    const tpl = template({
      DbSecret: { Value: SECRET_REF },
      Exp2: {
        Value: { 'Fn::GetAtt': ['T', 'StreamArn'] } as unknown as string,
        Export: { Name: SECRET_EXPORT_NAME as unknown as string },
      },
    });
    tpl.Resources['T'] = { Type: 'AWS::DynamoDB::Table', Properties: { KeySchema: [] } };
    const changes = await outputChangesFor(state, tpl);
    const text = rendered(changes);
    expect(text).toContain('    [-] App*** (name masked: it contains a secret)');
    expect(text).not.toContain(SECRET);
  });
});

describe('unaccountable values mask only unaccountable names (issue #4015 review, E3)', () => {
  it('prints an ADDED prod-ApiUrl bare beside a deleted Stage: prod', async () => {
    const state = stateWith({ Stage: 'prod' });
    state.resources['A']!.properties = { Value: 'x', Description: SECRET_REF };
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x', Description: SECRET_REF } },
      },
      Outputs: { ApiUrl: { Value: 'u', Export: { Name: 'prod-ApiUrl' } } },
    };
    const changes = await outputChangesFor(state, tpl);
    expect(rendered(changes)).toContain('    [+] prod-ApiUrl [export]\n');
    expect(jsonNames(changes)).toContainEqual({ name: 'prod-ApiUrl' });
  });
});

describe('a RESOLVED exporter whose name keeps a SecureString ssm token (round 2, G3)', () => {
  it('masks the stale alias, since the diff keeps that token', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'AQICencrypted', Type: 'SecureString' } });
    try {
      const changes = await outputChangesFor(
        {
          ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`app-${SECRET}`]: 'v' }),
          exportNames: [],
        },
        template({
          DbSecret: { Value: SECRET_REF },
          Exp: {
            Value: 'v',
            Export: {
              Name: {
                'Fn::Join': ['', ['app-', '{{resolve:ssm:/sec/p}}']],
              } as unknown as string,
            },
          },
        })
      );
      const text = rendered(changes);
      expect(text).not.toContain(SECRET);
      expect(JSON.stringify(jsonNames(changes))).not.toContain(SECRET);
    } finally {
      ssmSend.mockReset();
    }
  });
});

describe('a condition-false exporter with an ssm token (issue #4015 review, E8)', () => {
  it('masks a stale key holding a SecureString parameter, whose token the diff keeps', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'AQICencrypted', Type: 'SecureString' } });
    try {
      const tpl: CloudFormationTemplate = {
        ...template({
          DbSecret: { Value: SECRET_REF },
          Exp: {
            Value: 'v',
            Condition: 'Off',
            Export: {
              Name: {
                'Fn::Join': ['', ['app-', '{{resolve:ssm:/sec/p}}']],
              } as unknown as string,
            },
          },
        }),
        Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
      };
      const changes = await outputChangesFor(
        { ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', [`app-${SECRET}`]: 'v' }), exportNames: [] },
        tpl
      );
      const text = rendered(changes);
      expect(text).toContain('    [-] app-*** (name masked: it contains a secret)');
      expect(text).not.toContain(SECRET);
    } finally {
      ssmSend.mockReset();
    }
  });

  it('records no span, so a stale key holding the public value prints bare', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'PlainValue', Type: 'String' } });
    try {
      const tpl: CloudFormationTemplate = {
        ...template({
          DbSecret: { Value: SECRET_REF },
          Exp: {
            Value: 'v',
            Condition: 'Off',
            Export: {
              Name: {
                'Fn::Join': ['', ['app-', '{{resolve:ssm:/plain/p}}']],
              } as unknown as string,
            },
          },
        }),
        Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
      };
      const changes = await outputChangesFor(
        { ...stateWith({ DbSecret: SECRET_REF, Exp: 'v', 'app-PlainValue': 'v' }), exportNames: [] },
        tpl
      );
      expect(rendered(changes)).toContain('    [-] app-PlainValue\n');
    } finally {
      ssmSend.mockReset();
    }
  });
});

describe('renderOutputChangeLines without a verdict on the change', () => {
  it('prints the canonical key, so U+2028 cannot reach the sink', () => {
    const text = rendered([
      { name: 'a\u2028b\u001b[31m', changeType: 'REMOVE', oldValue: 'o', isExport: false },
    ]);
    expect(text).toContain('    [-] ab[31m\n');
    expect(text).not.toContain('\u2028');
  });
});

describe('secretSpanInStoredKey', () => {
  const name = `app-${SECRET_REF}-x`;
  it('returns what lies between the literal ends', () => {
    expect(secretSpanInStoredKey(`app-${SECRET}-x`, name)).toBe(SECRET);
  });
  it('spans from the first token to the last', () => {
    expect(secretSpanInStoredKey('a-S1-mid-S2-z', `a-${SECRET_REF}-mid-${SECRET_REF}-z`)).toBe(
      'S1-mid-S2'
    );
  });
  it('is undefined for a key without the shape, an empty span, or a name with no token', () => {
    expect(secretSpanInStoredKey('other-hunter2pass-x', name)).toBeUndefined();
    expect(secretSpanInStoredKey('app-hunter2pass-y', name)).toBeUndefined();
    expect(secretSpanInStoredKey('app--x', name)).toBeUndefined();
    expect(secretSpanInStoredKey('app-x', name)).toBeUndefined();
    expect(secretSpanInStoredKey('app-hunter2pass', 'app-hunter2pass')).toBeUndefined();
  });
});
