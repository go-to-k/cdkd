import { describe, expect, it } from 'vite-plus/test';
import {
  renderDownstreamConsumers,
  type DownstreamConsumer,
} from '../../../../src/cli/commands/recreate-downstream-consumers.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../../utils/paste-harness.js';

/**
 * go-to-k/cdkd#4165: the `--recreate-via-cc-api` data-loss prompt listed each
 * downstream consumer as `${consumerStack} (${consumerRegion}) reads
 * ${exportName}` raw. All three are record-derived (the consumer's state key
 * and `state.json` body), so a state-bucket writer could plant a span that
 * runs when pasted, or a newline that forges a consumer row.
 */
const CONSUMER: DownstreamConsumer = {
  consumerStack: 'Consumer',
  consumerRegion: 'us-east-1',
  exportName: 'Producer:ExportsOutputRefBucket83908E7781C90AC0',
  intrinsic: 'ImportValue',
};

function rendered(consumer: DownstreamConsumer): string {
  const out = renderDownstreamConsumers('Producer', [consumer]);
  expect(out).not.toBeNull();
  return out!;
}

/** The two row shapes: a matched consumer and a CANNOT NAME one. */
const ARMS: readonly { label: string; base: DownstreamConsumer }[] = [
  { label: 'matched row', base: CONSUMER },
  {
    label: 'CANNOT NAME row',
    base: { ...CONSUMER, intrinsic: 'GetStackOutput', producerUnresolvable: true },
  },
];

/** Each record-derived position, with the description a non-plain value gets there. */
function positions(base: DownstreamConsumer): readonly {
  label: string;
  consumer: (value: string) => DownstreamConsumer;
  described: string;
}[] {
  const what = base.intrinsic === 'ImportValue' ? 'an export' : 'an output';
  return [
    {
      label: 'consumer stack',
      consumer: (v) => ({ ...base, consumerStack: v }),
      described: '    - a stack name that is not a plain identifier (us-east-1) reads ',
    },
    {
      label: 'consumer region',
      consumer: (v) => ({ ...base, consumerRegion: v }),
      described: '    - Consumer (a region that is not a plain identifier) reads ',
    },
    {
      label: 'export name',
      consumer: (v) => ({ ...base, exportName: v }),
      described: ` reads ${what} whose name is not a plain identifier via Fn::${base.intrinsic}`,
    },
  ];
}

/**
 * Values with no whitespace that only the plain-identifier test refuses: a
 * substitution spelled with `${IFS}`, and brace expansion, which bash runs as
 * `touch OWNED`.
 */
const NO_WHITESPACE_PAYLOADS = ['x$(touch${IFS}OWNED)', '{touch,OWNED}'] as const;

describe('renderDownstreamConsumers — no non-plain record value printed raw (go-to-k/cdkd#4165)', () => {
  it('keeps a plain row byte-identical, a CDK export name with `:` included', () => {
    expect(rendered(CONSUMER)).toBe(
      "  Downstream consumers of Producer's outputs (will need re-deploy after this run):\n" +
        '    - Consumer (us-east-1) reads Producer:ExportsOutputRefBucket83908E7781C90AC0 via Fn::ImportValue'
    );
  });

  it('keeps a nested-stack consumer name byte-identical', () => {
    expect(rendered({ ...CONSUMER, consumerStack: 'Parent~Child' })).toContain(
      '    - Parent~Child (us-east-1) reads Producer:ExportsOutputRefBucket83908E7781C90AC0 via Fn::ImportValue'
    );
  });

  it('describes a masked `***` name on a CANNOT NAME row', () => {
    for (const exportName of ['***', 'Endpoint-***']) {
      const message = rendered({ ...ARMS[1]!.base, exportName });
      expect(message, exportName).toContain(
        ' reads an output whose name is not a plain identifier via Fn::GetStackOutput'
      );
      expect(message, exportName).not.toContain('***');
    }
  });

  for (const { label: arm, base } of ARMS) {
    for (const { label, consumer, described } of positions(base)) {
      it(`${arm}: describes a payload ${label}, never shows it, and no pasted span runs`, () => {
        withPasteDir((dir) => {
          const values = [
            ...PASTE_PAYLOADS.map((p) => p.value),
            CLAUSE_BREAK_PAYLOAD.value,
            ...NO_WHITESPACE_PAYLOADS,
          ];
          for (const value of values) {
            const message = rendered(consumer(value));
            expect(message, value).toContain(described);
            expect(message, value).not.toContain(value);
            expect(spansThatRun(message, dir), value).toEqual([]);
          }
        });
        // Spawns a shell per span.
      }, 120_000);
    }
  }

  it('a newline in a record value forges no consumer row', () => {
    for (const { base } of ARMS) {
      for (const { consumer } of positions(base)) {
        const message = rendered(consumer('x\n    - Forged (us-east-1) reads Y via Fn::ImportValue'));
        expect(message.split('\n')).toHaveLength(2);
        expect(message).not.toContain('Forged');
      }
    }
  });

  it('describes only the payload consumer in a mixed list', () => {
    withPasteDir((dir) => {
      const message = renderDownstreamConsumers('Producer', [
        CONSUMER,
        { ...CONSUMER, consumerStack: 'x$(touch OWNED)' },
      ])!;
      const [, first, second] = message.split('\n');
      expect(first).toBe(
        '    - Consumer (us-east-1) reads Producer:ExportsOutputRefBucket83908E7781C90AC0 via Fn::ImportValue'
      );
      expect(second).toBe(
        '    - a stack name that is not a plain identifier (us-east-1) reads ' +
          'Producer:ExportsOutputRefBucket83908E7781C90AC0 via Fn::ImportValue'
      );
      expect(spansThatRun(message, dir)).toEqual([]);
    });
  }, 120_000);
});
