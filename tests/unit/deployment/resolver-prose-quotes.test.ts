import { describe, expect, it, vi } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { getLogger } from '../../../src/utils/logger.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#3950: the resolver's messages wrapped a `displayMasked` /
 * `displayLeaf` render, or a `logged*` binding of one, in a hand-written
 * `'...'` or `"..."`. The render keeps `'`, `"`, `$`, `(`, a backtick and a
 * space, so a template mapping key, an export name or a dynamic-reference
 * name closed cdkd's quote, and pasting the sentence ran the payload. Now a
 * render of plain-identifier characters (plus `|`, `*`, `<`, `>`) keeps its
 * quotes byte-identically and any other is described. One message per family
 * is driven through the public `resolve`, and fed WHOLE to the paste harness.
 */

/** The SSM client the `{{resolve:ssm:...}}` family reaches; an empty answer drives the not-found refusal. */
const ssmSend = vi.hoisted(() => vi.fn(async () => ({ Parameter: undefined })));
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ssm')>();
  return {
    ...actual,
    SSMClient: vi.fn().mockImplementation(() => ({
      send: ssmSend,
      destroy: vi.fn(),
      config: { region: () => 'us-east-1' },
    })),
  };
});

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

const NOT_SHOWN = '(not shown: it is not a plain identifier)';

function context(
  template: CloudFormationTemplate = { Resources: {} },
  resources: ResolverContext['resources'] = {}
): ResolverContext {
  return {
    template,
    resources,
    stackName: 'Consumer',
    stateBackend: {
      listStacks: vi.fn(async () => []),
      getState: vi.fn(async () => null),
    } as unknown as S3StateBackend,
  };
}

async function refusal(
  value: unknown,
  template?: CloudFormationTemplate,
  resources?: ResolverContext['resources']
): Promise<string> {
  const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
  const err = await resolver.resolve(value, context(template, resources)).then(
    () => undefined,
    (e: unknown) => e as Error
  );
  expect(err, `expected a refusal for ${JSON.stringify(value)}`).toBeDefined();
  return String(err?.message ?? '');
}

const MAPPINGS = (name: string, top: string): CloudFormationTemplate => ({
  Resources: {},
  Mappings: { [name]: { [top]: { present: 'v' } } },
});

/**
 * Each family's message for `value`, with the text it must carry: the value
 * quoted when it is plain, and `described` otherwise.
 */
async function familiesFor(
  value: string
): Promise<Array<{ family: string; message: string; quoted: string; described: string }>> {
  return [
    {
      family: 'Fn::FindInMap mapping',
      message: await refusal({ 'Fn::FindInMap': [value, 'k', 'present'] }, MAPPINGS('M', 'k')),
      quoted: `mapping '${value}' not found`,
      described: `mapping ${NOT_SHOWN} not found`,
    },
    {
      family: 'Fn::FindInMap top-level key',
      message: await refusal({ 'Fn::FindInMap': ['M', value, 'present'] }, MAPPINGS('M', 'k')),
      quoted: `top-level key '${value}' not found in mapping 'M'`,
      described: `top-level key ${NOT_SHOWN} not found in mapping 'M'`,
    },
    {
      family: 'Fn::FindInMap second-level key',
      message: await refusal({ 'Fn::FindInMap': ['M', 'k', value] }, MAPPINGS('M', 'k')),
      quoted: `second-level key '${value}' not found in mapping 'M' -> 'k'`,
      described: `second-level key ${NOT_SHOWN} not found in mapping 'M' -> 'k'`,
    },
    {
      // The key is PRESENT, so the refusal names it at the end, after `->`.
      family: 'Fn::FindInMap second-level refusal naming the top-level key',
      message: await refusal({ 'Fn::FindInMap': ['M', value, 'absent'] }, MAPPINGS('M', value)),
      quoted: `not found in mapping 'M' -> '${value}'`,
      described: `not found in mapping 'M' -> ${NOT_SHOWN}`,
    },
    {
      // The mapping EXISTS under the payload's name, so the key refusals name it.
      family: 'Fn::FindInMap top-level refusal naming the mapping',
      message: await refusal({ 'Fn::FindInMap': [value, 'absent', 'present'] }, MAPPINGS(value, 'k')),
      quoted: `not found in mapping '${value}'`,
      described: `top-level key 'absent' not found in mapping ${NOT_SHOWN}`,
    },
    {
      family: 'Fn::FindInMap second-level refusal naming the mapping',
      message: await refusal({ 'Fn::FindInMap': [value, 'k', 'absent'] }, MAPPINGS(value, 'k')),
      quoted: `not found in mapping '${value}' -> 'k'`,
      described: `second-level key 'absent' not found in mapping ${NOT_SHOWN} -> 'k'`,
    },
    {
      // A pre-#1681 placeholder ARN read off the STATE record.
      family: 'placeholder-ARN refusal',
      message: await refusal(
        { 'Fn::GetAtt': ['Ds', 'DataSourceArn'] },
        { Resources: { Ds: { Type: 'AWS::AppSync::DataSource', Properties: {} } } },
        {
          Ds: {
            physicalId: 'ds-1',
            resourceType: 'AWS::AppSync::DataSource',
            attributes: { DataSourceArn: `arn:aws:appsync:*:*:apis/${value}` },
          },
        } as never
      ),
      quoted: `the recorded value "arn:aws:appsync:*:*:apis/${value}" is a placeholder`,
      described: `the recorded value ${NOT_SHOWN} is a placeholder`,
    },
    {
      family: 'Fn::ImportValue not found',
      message: await refusal({ 'Fn::ImportValue': value }),
      quoted: `export '${value}' not found in any stack`,
      described: `export ${NOT_SHOWN} not found in any stack`,
    },
    {
      family: 'SSM parameter not found',
      message: await refusal(`{{resolve:ssm:${value}}}`),
      quoted: `SSM parameter '${value}' not found`,
      described: `SSM parameter ${NOT_SHOWN} not found`,
    },
    {
      family: 'Fn::Select operand shape',
      message: await refusal({ 'Fn::Select': [value, ['a', 'b']] }),
      quoted: `got string "${value}"`,
      described: `got string ${NOT_SHOWN}`,
    },
  ];
}

describe('the resolver never puts a render inside cdkd quotes (go-to-k/cdkd#3950)', () => {
  it('keeps a plain value quoted, byte-identical to before', async () => {
    const families = await familiesFor('Plain-1');
    expect(families).toHaveLength(10);
    for (const { family, message, quoted } of families) {
      expect(message, family).toContain(quoted);
      expect(message, family).not.toContain(NOT_SHOWN);
    }
  });

  it('describes every payload, names none of it, and no pasted span runs', async () => {
    const rendered: Array<{ label: string; value: string; message: string; described: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const f of await familiesFor(value)) {
        rendered.push({ label: `${f.family}: ${value}`, value, message: f.message, described: f.described });
      }
    }
    expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 10);
    withPasteDir((dir) => {
      for (const { label, value, message, described } of rendered) {
        expect(message, label).toContain(described);
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('quotes exactly the admitted characters, one printable ASCII character at a time', async () => {
    // The invariant, not a payload instance: each payload carries several
    // refused characters, so admitting ONE of them alone would leave every
    // payload case described and green.
    const admitted = /[A-Za-z0-9:_@./+=,~|*<>-]/;
    let quoted = 0;
    for (let code = 0x21; code <= 0x7e; code++) {
      const c = String.fromCharCode(code);
      const value = `a${c}b`;
      const message = await refusal({ 'Fn::FindInMap': [value, 'k', 'present'] }, MAPPINGS('M', 'k'));
      if (admitted.test(c)) {
        quoted++;
        expect(message, value).toContain(`mapping '${value}' not found`);
      } else {
        expect(message, value).toContain(`mapping ${NOT_SHOWN} not found`);
      }
    }
    // 62 alphanumerics plus the 14 listed punctuation characters.
    expect(quoted).toBe(76);
  });

  it('describes a value carrying a space, which could put a clause break inside the quote', async () => {
    for (const value of ['a b', 'a: b', 'a. b']) {
      expect(
        await refusal({ 'Fn::FindInMap': [value, 'k', 'present'] }, MAPPINGS('M', 'k')),
        value
      ).toContain(`mapping ${NOT_SHOWN} not found`);
    }
  });

  it('describes a payload on the Fn::Split debug line, and no pasted span runs', async () => {
    const debug = getLogger().debug as unknown as { mock: { calls: unknown[][] }; mockClear: () => void };
    const lineOf = (prefix: string): string => {
      const line = debug.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(prefix));
      expect(line, `no debug line starting ${JSON.stringify(prefix)}`).toBeDefined();
      return line!;
    };
    const rendered: Array<{ label: string; value: string; message: string; described: string }> = [];
    for (const { value } of [{ value: 'Plain-1' }, ...PASTE_PAYLOADS]) {
      debug.mockClear();
      await new IntrinsicFunctionResolver('us-east-1').resolve(
        { 'Fn::Split': [value, 'a'] },
        context()
      );
      const split = lineOf('Resolved Fn::Split: split by ');
      if (value === 'Plain-1') {
        expect(split).toContain('split by "Plain-1" -> ');
        continue;
      }
      rendered.push(
        { label: `Fn::Split delimiter: ${value}`, value, message: split, described: `split by a delimiter ${NOT_SHOWN} -> ` }
      );
    }
    withPasteDir((dir) => {
      for (const { label, value, message, described } of rendered) {
        expect(message, label).toContain(described);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('keeps an empty mapping name visible as an empty quote', async () => {
    expect(await refusal({ 'Fn::FindInMap': ['', 'k', 'present'] }, MAPPINGS('M', 'k'))).toContain(
      "mapping '' not found"
    );
  });
});
