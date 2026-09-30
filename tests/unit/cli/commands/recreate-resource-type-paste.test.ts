import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import type { RecreateTarget } from '../../../../src/deployment/recreate-targets.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import type { StackState } from '../../../../src/types/state.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../../utils/paste-harness.js';

const warnSpy = vi.fn();
vi.mock('../../../../src/utils/logger.js', () => {
  const logger = { warn: warnSpy, info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

const { promptRecreateConfirm } = await import(
  '../../../../src/cli/commands/recreate-confirm-prompt.js'
);
const { validateRecreateTargets, renderRecreateTargetsErrors } = await import(
  '../../../../src/deployment/recreate-targets.js'
);

/**
 * go-to-k/cdkd#4165 (security review of go-to-k/cdkd#4169): the recreate
 * prompt's target row and two refusal rows printed `resourceType` raw. It is
 * the STATE record's type, which only a `typeof === 'string'` check stands
 * between a state-bucket writer and these lines: a value could carry a span
 * that runs when pasted (`AWS::S3::Bucket. touch OWNED #` runs at sentence
 * granularity in any shell) or a newline that forges a `DATA:` row.
 */
const DESCRIBED = 'a resource type that is not a plain identifier';
const PAYLOADS = [
  ...PASTE_PAYLOADS.map((p) => p.value),
  CLAUSE_BREAK_PAYLOAD.value,
  'AWS::S3::Bucket. touch OWNED #',
  'AWS::S3::Bucket) [SDK → CC]\n    DATA: nothing will be lost',
] as const;

function target(resourceType: string, overrides: Partial<RecreateTarget> = {}): RecreateTarget {
  return {
    logicalId: 'Bucket',
    resourceType,
    physicalId: 'pid',
    statefulReason: null,
    direction: 'to-cc-api',
    ...overrides,
  };
}

async function promptLines(t: RecreateTarget): Promise<string> {
  warnSpy.mockReset();
  await promptRecreateConfirm({
    stackName: 'S',
    targets: [t],
    yes: true,
    forceStatefulRecreation: t.statefulReason !== null,
  });
  return warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

function cleanValidation(): ReturnType<typeof validateRecreateTargets> {
  const template: CloudFormationTemplate = { Resources: {} };
  const state: StackState = {
    version: 7,
    stackName: 'S',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
  };
  return validateRecreateTargets({
    template,
    state,
    recreateViaCcApi: [],
    allowUnsupportedProperties: new Set(),
    forceStatefulRecreation: false,
  });
}

function statefulRefusal(resourceType: string): string {
  return renderRecreateTargetsErrors({
    ...cleanValidation(),
    blockedStatefulTargets: [{ ...target(resourceType), statefulReason: 'always' }],
  })!;
}

const LISTS = ['blockedAlreadySdk', 'blockedAlreadyCcApi', 'blockedNoSdkProvider'] as const;
type BlockedList = (typeof LISTS)[number];

function listRefusal(list: BlockedList, resourceType: string): string {
  return renderRecreateTargetsErrors({ ...cleanValidation(), [list]: [target(resourceType)] })!;
}

function inverseIntentRefusal(resourceType: string): string {
  return renderRecreateTargetsErrors({
    ...cleanValidation(),
    ambiguousIntentSdk: [{ logicalId: 'Bucket', resourceType, property: 'Tags' }],
  })!;
}

function nestedRefusal(resourceType: string, templateNested: boolean): string {
  return renderRecreateTargetsErrors({
    ...cleanValidation(),
    blockedNestedStackTargets: [target(resourceType)],
    nestedStackLogicalIds: templateNested ? ['Bucket'] : [],
  })!;
}

describe('recreate target rows — no non-plain recorded resource type printed raw (go-to-k/cdkd#4165)', () => {
  beforeEach(() => warnSpy.mockReset());

  it('keeps a plain type byte-identical on every row', async () => {
    expect(await promptLines(target('AWS::Lambda::Function'))).toContain(
      '  - Bucket (AWS::Lambda::Function) [SDK → CC]'
    );
    expect(statefulRefusal('AWS::RDS::DBInstance')).toContain('  - Bucket (AWS::RDS::DBInstance) — ');
    expect(nestedRefusal('AWS::SNS::Topic', true)).toContain(
      '  - Bucket (AWS::SNS::Topic in state, AWS::CloudFormation::Stack in the template)'
    );
    expect(nestedRefusal('AWS::CloudFormation::Stack', false)).toContain(
      '  - Bucket (AWS::CloudFormation::Stack)'
    );
    expect(inverseIntentRefusal('AWS::S3::Bucket')).toContain(
      '  - Bucket (AWS::S3::Bucket) — template uses Tags;'
    );
    for (const list of LISTS) {
      expect(listRefusal(list, 'AWS::S3::Bucket'), list).toContain('  - Bucket (AWS::S3::Bucket)\n');
    }
  });

  const SITES: readonly { label: string; render: (v: string) => Promise<string> | string; described: string }[] = [
    {
      label: 'prompt target row',
      render: (v) => promptLines(target(v)),
      described: `  - Bucket (${DESCRIBED}) [SDK → CC]`,
    },
    {
      label: 'prompt DATA LOSS row',
      render: (v) => promptLines(target(v, { statefulReason: 'always' })),
      described: `Bucket (${DESCRIBED}) [SDK → CC] — stateful`,
    },
    {
      label: 'stateful refusal row',
      render: (v) => statefulRefusal(v),
      described: `  - Bucket (${DESCRIBED}) — `,
    },
    {
      label: 'nested refusal row, template nested',
      render: (v) => nestedRefusal(v, true),
      described: `  - Bucket (${DESCRIBED} in state, AWS::CloudFormation::Stack in the template)`,
    },
    {
      label: 'nested refusal row, state nested',
      render: (v) => nestedRefusal(v, false),
      described: `  - Bucket (${DESCRIBED})`,
    },
    {
      label: 'inverse ambiguous-intent refusal row',
      render: (v) => inverseIntentRefusal(v),
      described: `  - Bucket (${DESCRIBED}) — template uses Tags;`,
    },
    ...LISTS.map((list) => ({
      label: `${list} refusal row`,
      render: (v: string) => listRefusal(list, v),
      described: `  - Bucket (${DESCRIBED})\n`,
    })),
  ];

  it('no Fix: line of any refusal block carries a `<...>` hole', () => {
    // `remove --recreate-via-cc-api <id> for these resources.`, pasted, is a
    // redirection: `<id>` reads a file and `> for` truncates one. Every block
    // is rendered at once, with plain values, so a hole in any Fix: line reds
    // here whichever block it is in.
    const t = target('AWS::S3::Bucket');
    const message = renderRecreateTargetsErrors({
      ...cleanValidation(),
      blockedAlreadySdk: [t],
      blockedAlreadyCcApi: [t],
      blockedNoSdkProvider: [t],
      blockedNoCcRoute: [{ ...t, templateType: 'AWS::S3::Bucket', reason: 'no CC handler' }],
      blockedCcBroken: [{ ...t, templateType: 'AWS::S3::Bucket' }],
      ambiguousIntentSdk: [{ logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket', property: 'Tags' }],
    })!;
    const fixLines = message.split('\n').filter((l) => l.includes('Fix:'));
    expect(fixLines).toHaveLength(6);
    for (const line of fixLines) expect(line).not.toMatch(/[<>]/);
  });

  for (const { label, render, described } of SITES) {
    it(`${label}: describes a payload type, never shows it, and no pasted span runs`, async () => {
      const messages: [string, string][] = [];
      for (const value of PAYLOADS) messages.push([value, await render(value)]);
      withPasteDir((dir) => {
        for (const [value, message] of messages) {
          expect(message, value).toContain(described);
          expect(message, value).not.toContain(value);
          expect(message, value).not.toContain('nothing will be lost');
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
      // Spawns a shell per span.
    }, 120_000);
  }
});
