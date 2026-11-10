/**
 * go-to-k/cdkd#6078: a row whose stale `newValue` is replaced on screen by its
 * template value (`newValueTemplate`) must have that value pass the same
 * `NoEcho` display mask as `newValue` (go-to-k/cdkd#4049).
 */
import { describe, expect, it } from 'vite-plus/test';
import { maskResourceChangeForDisplay } from '../../../src/cli/commands/diff-recursive/printing.js';
import type { ResourceChange } from '../../../src/types/state.js';

const NEEDLE = 'hunter2-noecho-value';
const mask = (text: string): string => text.split(NEEDLE).join('***');

const changeWith = (newValueTemplate: unknown): ResourceChange => ({
  logicalId: 'Param',
  changeType: 'UPDATE',
  resourceType: 'AWS::SSM::Parameter',
  propertyChanges: [
    {
      path: 'Value',
      oldValue: 'arn:aws:sns:us-east-1:123:Topic1|old',
      newValue: 'arn:aws:sns:us-east-1:123:Topic1|new',
      requiresReplacement: false,
      newValueKnownAfterDeploy: true,
      newValueTemplate,
    },
  ],
});

describe('maskResourceChangeForDisplay masks newValueTemplate (go-to-k/cdkd#6078)', () => {
  it('masks a needle inside the template value and withholds the old side', () => {
    const shown = maskResourceChangeForDisplay(
      changeWith({ 'Fn::Join': ['|', [{ Ref: 'Topic' }, NEEDLE]] }),
      mask
    );
    const pc = shown.propertyChanges?.[0];
    expect(pc?.newValueTemplate).toEqual({ 'Fn::Join': ['|', [{ Ref: 'Topic' }, '***']] });
    expect(JSON.stringify(shown)).not.toContain(NEEDLE);
    // A needle on the new side withholds the old side whole, as for `newValue`.
    expect(pc?.oldValue).toBe('***');
  });

  it('returns the same object when nothing is masked', () => {
    const change = changeWith({ 'Fn::Join': ['|', [{ Ref: 'Topic' }, 'plain']] });
    expect(maskResourceChangeForDisplay(change, mask)).toBe(change);
  });
});
