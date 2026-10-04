import { describe, expect, it } from 'vite-plus/test';
import { displayIdent } from '../../../src/utils/display-safe.js';
import {
  StackHasActiveImportsError,
  type ActiveImportConsumer,
} from '../../../src/utils/error-handler.js';
import { CLAUSE_BREAK_PAYLOAD, PASTE_PAYLOADS, spansThatRun, withPasteDir } from './paste-harness.js';

/**
 * go-to-k/cdkd#3950's `StackHasActiveImportsError` row: the refusal printed
 * `imports export '${exportName}'` and `Cannot destroy stack '${producerStack}'`
 * raw, beside the raw consumer name and both regions. Every one of them is
 * record-derived (a consumer's state key and `state.json` body), so a `'` in
 * the value closed cdkd's quote and a pasted sentence ran the rest.
 */
const CONSUMER: ActiveImportConsumer = {
  consumerStack: 'Consumer',
  consumerRegion: 'us-east-1',
  exportName: 'Producer:ExportsOutputRefBucket83908E7781C90AC0',
};

function refusal(producer: string, region: string, consumer: ActiveImportConsumer): string {
  return new StackHasActiveImportsError(producer, region, [consumer]).message;
}

/** Each record-derived position, with the description a non-plain value gets there. */
const POSITIONS: readonly {
  label: string;
  render: (value: string) => string;
  described: string;
}[] = [
  {
    label: 'export name',
    render: (v) => refusal('Producer', 'us-east-1', { ...CONSUMER, exportName: v }),
    described: 'imports an export whose name is not a plain identifier',
  },
  {
    label: 'producer stack',
    render: (v) => refusal(v, 'us-east-1', CONSUMER),
    described: 'Cannot destroy stack a stack name that is not a plain identifier (us-east-1)',
  },
  {
    label: 'producer region',
    render: (v) => refusal('Producer', v, CONSUMER),
    described: "Cannot destroy stack 'Producer' (a region that is not a plain identifier)",
  },
  {
    label: 'consumer stack',
    render: (v) => refusal('Producer', 'us-east-1', { ...CONSUMER, consumerStack: v }),
    described: '  - a stack name that is not a plain identifier (us-east-1): imports export',
  },
  {
    label: 'consumer region',
    render: (v) => refusal('Producer', 'us-east-1', { ...CONSUMER, consumerRegion: v }),
    described: '  - Consumer (a region that is not a plain identifier): imports export',
  },
];

describe('StackHasActiveImportsError — no non-plain record value inside cdkd quotes or raw (go-to-k/cdkd#3950)', () => {
  it('keeps a plain refusal byte-identical, a CDK export name with `:` included', () => {
    expect(refusal('Producer', 'us-east-1', CONSUMER)).toBe(
      "Cannot destroy stack 'Producer' (us-east-1): the following stacks still import its outputs via Fn::ImportValue:\n" +
        "  - Consumer (us-east-1): imports export 'Producer:ExportsOutputRefBucket83908E7781C90AC0'\n\n" +
        "This matches CloudFormation's strong-reference semantics — exports are\n" +
        'protected as long as a consumer references them.\n\n' +
        'To proceed:\n' +
        '  1. Destroy the consumer first: cdkd destroy <consumer-stack>\n' +
        "  2. Or remove the Fn::ImportValue from the consumer's template\n" +
        '     (e.g. inline the value, or refactor) and re-deploy the consumer,\n' +
        '     then retry this destroy.\n\n' +
        "Note: cdkd's Fn::GetStackOutput intrinsic is a weak alternative that\n" +
        'does NOT protect the producer — use it when you intentionally want\n' +
        'the producer to be deletable independently of consumers.'
    );
  });

  for (const { label, render, described } of POSITIONS) {
    it(`describes a payload ${label}, never shows it, and no pasted span runs`, () => {
      withPasteDir((dir) => {
        // The clause-break payload too: every position refuses whitespace, so
        // this site opts in (go-to-k/cdkd#4131 review m2).
        for (const { value } of [...PASTE_PAYLOADS, CLAUSE_BREAK_PAYLOAD]) {
          const message = render(value);
          expect(message, value).toContain(described);
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
      // Spawns a shell per span.
    }, 120_000);
  }

  it('describes only the payload consumer when a plain one is listed before it', () => {
    // Each consumer line is rendered on its own: a plain first consumer keeps
    // its names, and only the second, carrying the payload, is described
    // (go-to-k/cdkd#4131 review m3).
    const payload = "x'$(touch OWNED) #";
    const message = new StackHasActiveImportsError('Producer', 'us-east-1', [
      CONSUMER,
      { consumerStack: payload, consumerRegion: 'us-east-1', exportName: payload },
    ]).message;
    expect(message).toContain(
      "  - Consumer (us-east-1): imports export 'Producer:ExportsOutputRefBucket83908E7781C90AC0'\n" +
        '  - a stack name that is not a plain identifier (us-east-1): imports an export whose name is not a plain identifier\n'
    );
    expect(message).not.toContain(payload);
    withPasteDir((dir) => {
      expect(spansThatRun(message, dir)).toEqual([]);
    });
  }, 120_000);

  it('describes an export name with no whitespace that is not plain, or is past the cap', () => {
    // No whitespace, so only the `displayIdent` round-trip refuses these: a
    // quote and a substitution (`${IFS}` instead of a space), and a plain
    // name one character past the 255 cap, which `displayIdent` cuts.
    for (const exportName of ["x'$(touch${IFS}OWNED)", 'a'.repeat(256)]) {
      const message = refusal('Producer', 'us-east-1', { ...CONSUMER, exportName });
      expect(message, exportName).toContain('imports an export whose name is not a plain identifier');
      expect(message, exportName).not.toContain(exportName);
    }
  });

  it('describes an export name forged to end in displayIdent’s own cut marker', () => {
    // 255 plain characters (the default cap) plus the pre-go-to-k/cdkd#4002
    // marker for 35 withheld characters: `displayIdent` cut it to exactly
    // itself until the marker carried a digest of the withheld tail, and the
    // whitespace test refuses it either way.
    const forged = `${'a'.repeat(255)} [cut: 35 more characters withheld]`;
    expect(displayIdent(forged)).not.toBe(forged);
    const message = refusal('Producer', 'us-east-1', { ...CONSUMER, exportName: forged });
    expect(message).toContain('imports an export whose name is not a plain identifier');
    expect(message).not.toContain(forged);
  });
});
