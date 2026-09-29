import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4049: the deploy's diff resolver resolves a `Ref` to a `NoEcho`
// parameter to its plaintext and records it as a LOG-ONLY needle. The
// calculator's `requires replacement (<old> -> <new>)` debug line prints
// resolved values, so it masks with the printing masker the caller passes,
// while the changes it RETURNS keep the values unmasked.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
// No DescribeType: `AWS::SSM::Parameter`'s `Name` is registry-classified, and
// nothing here should reach the schema fallback.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return { ...actual, getCreateOnlyPropertyPaths: vi.fn().mockResolvedValue([]) };
});
vi.mock('../../../src/provisioning/write-only-properties.js', () => ({
  tryGetTopLevelWriteOnlyProperties: vi.fn().mockResolvedValue([]),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { getCreateOnlyPropertyPaths } from '../../../src/provisioning/create-only-properties.js';
import {
  SECRET_MASK,
  createSecretMasker,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const NOECHO = 'hunter2-noecho-name';
const PREVIOUS = 'previous-noecho-name';

function stateWith(properties: Record<string, unknown>): StackState {
  return {
    version: 1,
    stackName: 'S',
    resources: {
      R: {
        physicalId: '/app/param',
        resourceType: 'AWS::SSM::Parameter',
        properties,
        attributes: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

function templateWith(properties: Record<string, unknown>): CloudFormationTemplate {
  return { Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: properties } } };
}

/**
 * A resolver standing in for the deploy's diff resolver: a `{Ref: Secret}`
 * resolves to `value` and records it as a log-only needle of `bag`, the way
 * `recordNoEchoParameterValue` does. The needle is recorded DURING the diff,
 * after the masker was bound.
 */
function noEchoResolver(bag: RecordedSecretValues, value: unknown) {
  const resolve = (node: unknown): unknown => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      const obj = node as Record<string, unknown>;
      if (obj['Ref'] === 'Secret') {
        recordLogOnlyValue(bag, String(value));
        return value;
      }
      if (Array.isArray(obj['Fn::Join'])) {
        const [sep, parts] = obj['Fn::Join'] as [string, unknown[]];
        return parts.map((part) => String(resolve(part))).join(sep);
      }
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v)]));
    }
    return node;
  };
  return async (value: unknown): Promise<unknown> => resolve(value);
}

function replacementLine(): string {
  const lines = logLines.filter((line) => line.includes('requires replacement ('));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

beforeEach(() => {
  logLines.length = 0;
});

describe('DiffCalculator - the replacement debug line masks a NoEcho value (go-to-k/cdkd#4049)', () => {
  it('masks the new side and withholds the old side of a create-only property served by NoEcho', async () => {
    const bag: RecordedSecretValues = new Map();
    const changes = await new DiffCalculator().calculateDiff(
      stateWith({ Name: PREVIOUS, Type: 'String', Value: 'v' }),
      templateWith({ Name: { Ref: 'Secret' }, Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(changes.get('R')?.propertyChanges?.[0]?.requiresReplacement).toBe(true);
    const line = replacementLine();
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (${SECRET_MASK} -> "${SECRET_MASK}")`
    );
    // The PREVIOUS value is no needle (only the current one is recorded), so
    // only the withholding keeps it out.
    expect(logLines.join('\n')).not.toContain(NOECHO);
    expect(logLines.join('\n')).not.toContain(PREVIOUS);
  });

  it('masks a needle JSON.stringify would escape out of the finished line', async () => {
    const needle = 'pa"ss\\word-noecho';
    const bag: RecordedSecretValues = new Map();
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: 'p-old', Type: 'String', Value: 'v' }),
      templateWith({
        Name: { 'Fn::Join': ['', ['p-', { Ref: 'Secret' }]] },
        Type: 'String',
        Value: 'v',
      }),
      noEchoResolver(bag, needle),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    const line = replacementLine();
    expect(line).toContain(`-> "p-${SECRET_MASK}")`);
    expect(line).not.toContain(needle);
    expect(line).not.toContain(JSON.stringify(needle).slice(1, -1));
  });

  it("masks a number leaf whose printed form is the needle (a Number parameter's value)", async () => {
    const bag: RecordedSecretValues = new Map();
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: { Port: 1 }, Type: 'String', Value: 'v' }),
      templateWith({ Name: { Port: { Ref: 'Secret' } }, Type: 'String', Value: 'v' }),
      noEchoResolver(bag, 739),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    const line = replacementLine();
    expect(line).toContain(`-> {"Port":"${SECRET_MASK}"})`);
    expect(line).not.toContain('739');
  });

  it("masks a boolean leaf whose printed form is the needle", async () => {
    const bag: RecordedSecretValues = new Map();
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: { Flag: false }, Type: 'String', Value: 'v' }),
      templateWith({ Name: { Flag: { Ref: 'Secret' } }, Type: 'String', Value: 'v' }),
      noEchoResolver(bag, true),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (${SECRET_MASK} -> {"Flag":"${SECRET_MASK}"})`
    );
  });

  it('prints an absent side as undefined, not as nothing', async () => {
    const bag: RecordedSecretValues = new Map();
    await new DiffCalculator().calculateDiff(
      stateWith({ Type: 'String', Value: 'v' }),
      templateWith({ Name: 'new-name', Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      'Property Name of AWS::SSM::Parameter requires replacement (undefined -> "new-name")'
    );
  });

  it("does not withhold the old side because the walk's depth cap reshaped the new one", async () => {
    // Deeper than `maskDeep`'s cap: the walk replaces the tail with its marker
    // whatever the masker, which must not read as a needle on the new side.
    const nest = (leaf: string): unknown => {
      let node: unknown = leaf;
      for (let i = 0; i < 10; i++) node = { a: node };
      return node;
    };
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, NOECHO);
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: nest('old'), Type: 'String', Value: 'v' }),
      templateWith({ Name: nest('new'), Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    const line = replacementLine();
    expect(line).toContain('requires replacement ({"a":');
    expect(line).not.toContain(`requires replacement (${SECRET_MASK} ->`);
  });

  it('masks a needle in the property KEY, which only the finished line carries', async () => {
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, 'Name');
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: 'old-name', Type: 'String', Value: 'v' }),
      templateWith({ Name: 'new-name', Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      `Property ${SECRET_MASK} of AWS::SSM::Parameter requires replacement ("old-name" -> "new-name")`
    );
  });

  it('masks a key needle carrying a control character before safeMsg strips it', async () => {
    // `safeMsg` strips the BEL, so a mask applied only to the finished line
    // no longer finds the needle and prints the rest of the key.
    const key = 'Se\u0007cretKeyName';
    vi.mocked(getCreateOnlyPropertyPaths).mockResolvedValueOnce([[key]]);
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, key);
    await new DiffCalculator().calculateDiff(
      {
        version: 1,
        stackName: 'S',
        resources: {
          R: { physicalId: 'r', resourceType: 'Custom::Thing', properties: { [key]: 'a' }, attributes: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      { Resources: { R: { Type: 'Custom::Thing', Properties: { [key]: 'b' } } } },
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      `Property ${SECRET_MASK} of Custom::Thing requires replacement ("a" -> "b")`
    );
  });

  it('masks a type-name needle carrying a control character before safeMsg strips it', async () => {
    const type = 'Custom::Se\u0007cretTypeName';
    vi.mocked(getCreateOnlyPropertyPaths).mockResolvedValueOnce([['Prop']]);
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, type);
    await new DiffCalculator().calculateDiff(
      {
        version: 1,
        stackName: 'S',
        resources: {
          R: { physicalId: 'r', resourceType: type, properties: { Prop: 'a' }, attributes: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      { Resources: { R: { Type: type, Properties: { Prop: 'b' } } } },
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      `Property Prop of ${SECRET_MASK} requires replacement ("a" -> "b")`
    );
  });

  it('prints both sides when the new side carries no needle (negative control)', async () => {
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, NOECHO);
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: 'old-name', Type: 'String', Value: 'v' }),
      templateWith({ Name: 'new-name', Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      'Property Name of AWS::SSM::Parameter requires replacement ("old-name" -> "new-name")'
    );
  });

  it('masks a needle on the OLD side when the new side carries none', async () => {
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, NOECHO);
    await new DiffCalculator().calculateDiff(
      stateWith({ Name: NOECHO, Type: 'String', Value: 'v' }),
      templateWith({ Name: 'literal-name', Type: 'String', Value: 'v' }),
      noEchoResolver(bag, NOECHO),
      undefined,
      undefined,
      undefined,
      createSecretMasker(bag)
    );
    expect(replacementLine()).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement ("${SECRET_MASK}" -> "literal-name")`
    );
  });

  it('returns the same unmasked changes with and without the masker', async () => {
    const run = async (withMasker: boolean) => {
      const bag: RecordedSecretValues = new Map();
      return new DiffCalculator().calculateDiff(
        stateWith({ Name: PREVIOUS, Type: 'String', Value: 'v' }),
        templateWith({ Name: { Ref: 'Secret' }, Type: 'String', Value: { Ref: 'Secret' } }),
        noEchoResolver(bag, NOECHO),
        undefined,
        undefined,
        undefined,
        withMasker ? createSecretMasker(bag) : undefined
      );
    };
    const masked = await run(true);
    const unmasked = await run(false);
    const nameChange = masked.get('R')?.propertyChanges?.find((c) => c.path === 'Name');
    // Non-vacuity: the value the engine compares and provisions from is the
    // plaintext, not the mask.
    expect(nameChange?.newValue).toBe(NOECHO);
    expect(nameChange?.oldValue).toBe(PREVIOUS);
    expect(JSON.stringify([...masked])).toBe(JSON.stringify([...unmasked]));
  });
});
