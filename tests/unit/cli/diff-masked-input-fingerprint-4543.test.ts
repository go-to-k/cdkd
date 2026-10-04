/**
 * go-to-k/cdkd#4543, the PREVIEW half: `cdkd diff` compares a masked
 * property's layout-2 fingerprint against the stack's resolved inputs, so a
 * changed parameter behind unchanged template text previews the UPDATE the
 * deploy sends. A nested child does not compare it (its deploy classifies a
 * parent-supplied value by secrets this preview never resolves). Through
 * `computeStackDiff` with the real resolver.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

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
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  maskedInputFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const VALUE = {
  'Fn::Base64': {
    'Fn::Join': ['', ['b=', { Ref: 'P' }, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
  },
};
const templateAt = (value: string): CloudFormationTemplate => ({
  Parameters: { P: { Type: 'String', Default: value } },
  Resources: {
    R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: VALUE } },
  },
});

async function stateStampedAt(value: string): Promise<StackState> {
  const template = templateAt(value);
  const fingerprint = await maskedInputFingerprint(VALUE, {
    template,
    parameterInput: parameterInputsFor({ template, values: { P: value } }).parameterInput,
    resolve: () => Promise.reject(new Error('no node to resolve')),
  });
  return {
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      R: {
        physicalId: 'n',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'n', Type: 'String', Value: '***' },
        maskedPropertyFingerprints: { Value: fingerprint! },
      },
    },
    outputs: {},
    version: 10,
    lastModified: 0,
  };
}

async function changeOf(state: StackState, template: CloudFormationTemplate, preview: boolean) {
  const backend = { getState: async () => null } as unknown as S3StateBackend;
  const result = await computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator(), {
    previewMaskedInputs: preview,
  });
  return result.changes.get('R')!;
}

describe('cdkd diff previews a masked property whose parameter moved (go-to-k/cdkd#4543)', () => {
  it('previews the UPDATE for the stack the user named', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('two'), true);
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', maskedExpressionChanged: true }),
    ]);
  });

  it('previews nothing for an unchanged parameter (control)', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('one'), true);
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('does not compare the inputs in a nested child, but still sees a template edit there', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('two'), false);
    expect(change.changeType).toBe('NO_CHANGE');
    const edited = templateAt('one');
    (edited.Resources['R']!.Properties as Record<string, unknown>)['Value'] = {
      'Fn::Base64': {
        'Fn::Join': ['', ['c=', { Ref: 'P' }, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
      },
    };
    const textEdit = await changeOf(await stateStampedAt('one'), edited, false);
    expect(textEdit.changeType).toBe('UPDATE');
  });
});

describe('buildDiffTree compares the inputs for the root only (go-to-k/cdkd#4543)', () => {
  it('previews the root row, and reads the same change in a nested child as unmoved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4543-'));
    try {
      const childPath = join(dir, 'child.json');
      // The child reads `P` from its parent row, which now passes `two`.
      writeFileSync(childPath, JSON.stringify(templateAt('one')));
      const parentTemplate = templateAt('two');
      parentTemplate.Resources['Child'] = {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': 'child.json' },
        Properties: { Parameters: { P: 'two' } },
      };
      const parentState = await stateStampedAt('one');
      parentState.resources['Child'] = {
        physicalId: 'child',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { Parameters: { P: 'two' } },
      };
      const childState = { ...(await stateStampedAt('one')), stackName: 'S~Child' };
      const states: Record<string, StackState> = { S: parentState, 'S~Child': childState };
      const root = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(root.changes.get('R')!.changeType).toBe('UPDATE');
      expect(root.children).toHaveLength(1);
      expect(root.children[0]!.changes.get('R')!.changeType).toBe('NO_CHANGE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
