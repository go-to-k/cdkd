import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/analyzer/outputs-diff.ts` slice: both resolution catches in
 * `resolveTemplateOutputs` stringified their caught value with a bare
 * `String()` before `continue`-ing to the next output, which turned a graceful
 * degradation into a hard failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * Each case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the call resolves, the sibling output is still in the bag), never
 * merely "it did not throw". The placeholder is asserted too, so a fix that
 * swallowed the failure without reporting it would not pass.
 */

const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { resolveTemplateOutputs } from '../../../src/analyzer/outputs-diff.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const PLACEHOLDER = 'a value that could not be converted to text';

/** Rejects `{ Ref: 'Unconvertible' }` with a null-prototype value; resolves every other `Ref`. */
async function resolver(value: unknown): Promise<unknown> {
  if (value !== null && typeof value === 'object' && 'Ref' in value) {
    const ref = (value as { Ref: string }).Ref;
    if (ref === 'Unconvertible') throw Object.create(null);
    return `resolved-${ref}`;
  }
  return value;
}

function debugLines(): string[] {
  return debugSpy.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  debugSpy.mockClear();
});

describe('resolveTemplateOutputs with an unconvertible rejection (#3361)', () => {
  it('skips the failing output VALUE and still resolves its sibling', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Broken: { Value: { Ref: 'Unconvertible' } },
        Fine: { Value: { Ref: 'Bucket' } },
      },
    };

    const r = await resolveTemplateOutputs(template, resolver);

    expect(r.outputs).toEqual({ Fine: 'resolved-Bucket' });
    expect(r.resolutionFailed).toBe(true);
    expect(debugLines()).toContain(`Diff could not resolve output Broken: ${PLACEHOLDER}`);
  });

  it('skips the failing Export.Name and still aliases its sibling', async () => {
    const template = {
      Resources: {},
      Outputs: {
        Broken: { Value: { Ref: 'Topic' }, Export: { Name: { Ref: 'Unconvertible' } } },
        Fine: { Value: { Ref: 'Bucket' }, Export: { Name: 'FineExport' } },
      },
    } as unknown as CloudFormationTemplate;

    const r = await resolveTemplateOutputs(template, resolver);

    expect(r.outputs).toEqual({
      Broken: 'resolved-Topic',
      Fine: 'resolved-Bucket',
      FineExport: 'resolved-Bucket',
    });
    expect(r.resolutionFailed).toBe(true);
    expect(debugLines()).toContain(
      `Diff could not resolve Export.Name of Broken: ${PLACEHOLDER}`
    );
  });
});
