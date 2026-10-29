import { describe, it, expect } from 'vite-plus/test';

import {
  CreatedResourceSink,
  clearCreatedReportOnReturn,
  collectCreatedResources,
  reportCreatedResource,
  retractCreatedResource,
} from '../../../src/provisioning/created-resource-sink.js';

/**
 * go-to-k/cdkd#5511: the engine-owned record of what a provider's create call
 * made, which survives the per-resource deadline dropping the marked error.
 */
describe('created-resource sink (go-to-k/cdkd#5511)', () => {
  const sinkFor = () => new CreatedResourceSink('L', 'AWS::X::Y');

  it('records a report made inside the scope, identity included', async () => {
    const sink = sinkFor();
    await collectCreatedResources(sink, async () => {
      reportCreatedResource('L', 'AWS::X::Y', 'id-1', 'token-1');
    });
    expect(sink.report).toEqual({ physicalId: 'id-1', createdResourceIdentity: 'token-1' });
  });

  it('keeps a report made after the scope function was abandoned', async () => {
    const sink = sinkFor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void collectCreatedResources(sink, async () => {
      await gate;
      reportCreatedResource('L', 'AWS::X::Y', 'late');
    });
    release();
    await gate;
    await Promise.resolve();
    expect(sink.report?.physicalId).toBe('late');
  });

  it('keeps the last report (a retried attempt names its own resource)', async () => {
    const sink = sinkFor();
    await collectCreatedResources(sink, async () => {
      reportCreatedResource('L', 'AWS::X::Y', 'first');
      reportCreatedResource('L', 'AWS::X::Y', 'second');
    });
    expect(sink.report).toEqual({ physicalId: 'second' });
  });

  it.each([
    ['another logical id', 'Other', 'AWS::X::Y', 'id-1'],
    ['another type', 'L', 'AWS::X::Z', 'id-1'],
    ['an empty id', 'L', 'AWS::X::Y', ''],
  ])('ignores a report naming %s', async (_label, logicalId, type, id) => {
    const sink = sinkFor();
    await collectCreatedResources(sink, async () => reportCreatedResource(logicalId, type, id));
    expect(sink.report).toBeUndefined();
  });

  it('drops an empty identity, keeping the report', async () => {
    const sink = sinkFor();
    await collectCreatedResources(sink, async () => reportCreatedResource('L', 'AWS::X::Y', 'id-1', ''));
    expect(sink.report).toEqual({ physicalId: 'id-1' });
  });

  it('retracts only a report naming the same id', async () => {
    const sink = sinkFor();
    await collectCreatedResources(sink, async () => {
      reportCreatedResource('L', 'AWS::X::Y', 'id-1');
      retractCreatedResource('L', 'AWS::X::Y', 'other');
    });
    expect(sink.report?.physicalId).toBe('id-1');
    await collectCreatedResources(sink, async () => retractCreatedResource('L', 'AWS::X::Y', 'id-1'));
    expect(sink.report).toBeUndefined();
  });

  it('a nested scope shadows the outer one', async () => {
    const outer = sinkFor();
    const inner = sinkFor();
    await collectCreatedResources(outer, () =>
      collectCreatedResources(inner, async () => reportCreatedResource('L', 'AWS::X::Y', 'child'))
    );
    expect(inner.report?.physicalId).toBe('child');
    expect(outer.report).toBeUndefined();
  });

  describe('clearCreatedReportOnReturn', () => {
    it('clears the report when the provider call resolves', async () => {
      const sink = sinkFor();
      await collectCreatedResources(sink, () =>
        clearCreatedReportOnReturn(async () => reportCreatedResource('L', 'AWS::X::Y', 'id-1'))
      );
      expect(sink.report).toBeUndefined();
    });

    it('keeps it when the provider call rejects', async () => {
      const sink = sinkFor();
      await expect(
        collectCreatedResources(sink, () =>
          clearCreatedReportOnReturn(async () => {
            reportCreatedResource('L', 'AWS::X::Y', 'id-1');
            throw new Error('wait failed');
          })
        )
      ).rejects.toThrow('wait failed');
      expect(sink.report?.physicalId).toBe('id-1');
    });
  });

  it('is a no-op outside any scope', async () => {
    expect(() => reportCreatedResource('L', 'AWS::X::Y', 'id-1')).not.toThrow();
    expect(() => retractCreatedResource('L', 'AWS::X::Y', 'id-1')).not.toThrow();
    await expect(clearCreatedReportOnReturn(async () => 7)).resolves.toBe(7);
  });
});
