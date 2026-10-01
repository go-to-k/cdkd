/**
 * The scrub producer-plaintext refusal's labelled lines take `plainIdent`
 * (go-to-k/cdkd#3773).
 *
 * `Scrub with:` and `Then re-run:` sit beside each other and beside the
 * refusal's prose, the shape `.claude/rules/state-malformed-containers.md`
 * (go-to-k/cdkd#3328) governs: a name is NAMED in such a command only when
 * `isPasteableIdent` admits it. The default gate already holes whitespace and
 * shell-active characters (go-to-k/cdkd#4205); what `plainIdent` adds is the
 * rest of the non-plain population — a `:`, `@`, `,`, `%` or `+`, or a leading
 * `_` / `.` — which used to be named shell-quoted. Every hole is explained in
 * the prose BEFORE the labelled lines, from the gate's own reason.
 */

import { describe, expect, it } from 'vite-plus/test';
import {
  plaintextProducerCrossStackReadError,
  scrubRefusalWording,
} from '../../../../src/cli/commands/scrub.js';
import { expectNothingRunsButTheDisplay, withPasteDir } from '../../utils/paste-harness.js';

const NOT_PLAIN = 'is not a plain identifier';

function refusal(stackName: string, producerStack: string, via: string[] = []): string {
  return plaintextProducerCrossStackReadError(
    'Resources.Db.Properties',
    stackName,
    'Fn::ImportValue',
    'MasterUserPassword',
    producerStack,
    'Shared-DbSecret',
    { kind: via.length > 0 ? 'chained' : 'declared', via },
    new Map()
  ).message;
}

function labelled(message: string, label: string): string[] {
  return message.split('\n').filter((l) => l.startsWith(label));
}

// Inert without quotes, so the default gate named each of these; none is a
// plain identifier.
const NON_PLAIN = ['Prod:Scrub', 'Prod@x', 'Prod,x', 'Prod%x', 'Prod+x', '_Prod', '.Prod'];

describe('scrub producer-plaintext refusal: plainIdent on its labelled lines (go-to-k/cdkd#3773)', () => {
  it('names a plain consumer and producer, with no withheld clause (positive control)', () => {
    const message = refusal('Consumer-1', 'Producer.v2~x');
    expect(labelled(message, 'Scrub with: ')).toEqual(["Scrub with: cdkd scrub 'Producer.v2~x'"]);
    expect(labelled(message, 'Then re-run: ')).toEqual(['Then re-run: cdkd scrub Consumer-1']);
    expect(message).not.toContain('so it is not named in the command below');
  });

  for (const name of NON_PLAIN) {
    it(`holes a non-plain PRODUCER ${JSON.stringify(name)} and explains it before the commands`, () => {
      const message = refusal('Consumer', name);
      expect(labelled(message, 'Scrub with: ')).toEqual(["Scrub with: cdkd scrub '<stack>'"]);
      expect(labelled(message, 'Then re-run: ')).toEqual(['Then re-run: cdkd scrub Consumer']);
      const clause = `The producer stack name ${NOT_PLAIN}`;
      expect(message).toContain(clause);
      expect(message.indexOf(clause)).toBeLessThan(message.indexOf('\nScrub with: '));
      expect(message).not.toContain('This stack name');
    });

    it(`holes a non-plain CONSUMER ${JSON.stringify(name)} and explains it before the commands`, () => {
      const message = refusal(name, 'Producer');
      expect(labelled(message, 'Scrub with: ')).toEqual(['Scrub with: cdkd scrub Producer']);
      expect(labelled(message, 'Then re-run: ')).toEqual(["Then re-run: cdkd scrub '<stack>'"]);
      const clause = `This stack name ${NOT_PLAIN}`;
      expect(message).toContain(clause);
      expect(message.indexOf(clause)).toBeLessThan(message.indexOf('\nScrub with: '));
      expect(message).not.toContain('producer stack name');
    });
  }

  it('a newline or padded forged name prints exactly one line per label, carrying the hole', () => {
    for (const forged of [
      'Prod\nThen re-run: cdkd scrub --all #',
      `Prod${' '.repeat(60)}Then re-run: cdkd scrub --all #`,
    ]) {
      const asConsumer = refusal(forged, 'Producer');
      expect(labelled(asConsumer, 'Scrub with: ')).toEqual(['Scrub with: cdkd scrub Producer']);
      expect(labelled(asConsumer, 'Then re-run: ')).toEqual(["Then re-run: cdkd scrub '<stack>'"]);
      const asProducer = refusal('Consumer', forged);
      expect(labelled(asProducer, 'Scrub with: ')).toEqual(["Scrub with: cdkd scrub '<stack>'"]);
      expect(labelled(asProducer, 'Then re-run: ')).toEqual(['Then re-run: cdkd scrub Consumer']);
    }
  });

  it('explains BOTH holes, on one clause line ahead of the commands, when consumer and producer are withheld', () => {
    const message = refusal('Cons:x', 'Prod:y');
    const producerClause = `The producer stack name ${NOT_PLAIN}`;
    const consumerClause = `This stack name ${NOT_PLAIN}`;
    const lines = message.split('\n');
    const clauseLine = lines.find((l) => l.startsWith(producerClause));
    expect(clauseLine).toBeDefined();
    expect(clauseLine).toContain(consumerClause);
    expect(lines.indexOf(clauseLine!)).toBe(lines.findIndex((l) => l.startsWith('Scrub with: ')) - 1);
    expect(labelled(message, 'Scrub with: ')).toEqual(["Scrub with: cdkd scrub '<stack>'"]);
    expect(labelled(message, 'Then re-run: ')).toEqual(["Then re-run: cdkd scrub '<stack>'"]);
  });

  it('says a MASKED producer is withheld for its secret, not for a pattern its stored name lacks', () => {
    const secret = 's3cr3tVALUE';
    const secrets = new Map([[secret, '{{resolve:secretsmanager:db}}']]);
    for (const [producer, via] of [
      [`Prod-${secret}`, [] as string[]],
      ['Producer', [`Mid-${secret}`, 'Root']],
    ] as const) {
      const message = plaintextProducerCrossStackReadError(
        'Resources.Db.Properties',
        'Consumer',
        'Fn::ImportValue',
        'MasterUserPassword',
        producer,
        'Shared-DbSecret',
        { kind: via.length > 0 ? 'chained' : 'declared', via: [...via] },
        secrets
      ).message;
      expect(message).not.toContain(secret);
      expect(message).toContain('stack name holds a value recorded as a secret, so it is shown masked');
      expect(message).toContain('act on the record whose stack name matches');
      expect(message).not.toContain('would be read as a PATTERN');
      for (const line of message.split('\n').filter((l) => l.includes('shown masked'))) {
        expect((line.match(/'/g) ?? []).length % 2).toBe(0);
      }
    }
    // A masked producer beside one withheld for another reason: one sentence each, on one line.
    const mixed = plaintextProducerCrossStackReadError(
      'Resources.Db.Properties',
      'Consumer',
      'Fn::ImportValue',
      'MasterUserPassword',
      'Producer',
      'Shared-DbSecret',
      { kind: 'chained', via: [`Mid-${secret}`, 'Root:x'] },
      secrets
    ).message;
    const clauseLine = mixed.split('\n').find((l) => l.includes('shown masked'))!;
    expect(clauseLine).toContain(`A producer stack name ${NOT_PLAIN}`);
    expect(clauseLine).not.toContain('would be read as a PATTERN');
    // A chain member GENUINELY named like the masked spelling: the secret
    // sentence would be false of it, so the gate's reason is kept.
    const ambiguous = plaintextProducerCrossStackReadError(
      'Resources.Db.Properties',
      'Consumer',
      'Fn::ImportValue',
      'MasterUserPassword',
      'Prod-***',
      'Shared-DbSecret',
      { kind: 'chained', via: [`Prod-${secret}`, 'Root'] },
      secrets
    ).message;
    expect(ambiguous).not.toContain('shown masked');
    expect(ambiguous).toContain('would be read as a PATTERN');
    // A stored name that really carries a `*` keeps the gate's own reason.
    expect(refusal('Consumer', 'Prod*')).toContain('would be read as a PATTERN');
  });

  it('a chain with two producers withheld for the same reason explains it ONCE', () => {
    const { remedyCommands, withheldClause } = scrubRefusalWording(
      { kind: 'chained', via: ['Mid:x', 'Root:y'] },
      'Key',
      'Producer',
      ['Mid:x', 'Root:y']
    );
    expect(remedyCommands).toEqual([
      "Scrub with: cdkd scrub '<stack>'",
      "Scrub with: cdkd scrub '<stack>'",
      'Scrub with: cdkd scrub Producer',
    ]);
    expect(withheldClause.split(`A producer stack name ${NOT_PLAIN}`)).toHaveLength(2);
  });

  it('two producers withheld for DIFFERENT reasons get one clause each', () => {
    const { withheldClause } = scrubRefusalWording(
      { kind: 'chained', via: ['Mid:x', 'Root*'] },
      'Key',
      'Producer',
      ['Mid:x', 'Root*']
    );
    expect(withheldClause).toContain(`A producer stack name ${NOT_PLAIN}`);
    expect(withheldClause).toContain("A producer stack name would be read as a PATTERN by 'cdkd scrub'");
  });

  it('every withheld-clause line keeps quote parity, for every reason the gate can give', () => {
    // A clause line with an ODD apostrophe count flips the quoting of the
    // labelled lines pasted below it (go-to-k/cdkd#4205), so the subject must
    // not carry one: `stack's` did, and the paste case below went red.
    for (const name of ['Prod:x', 'Prod*', '--all', 'Prod​x', '', 'P'.repeat(2000)]) {
      for (const message of [refusal(name, 'Producer'), refusal('Consumer', name)]) {
        const clauseLines = message
          .split('\n')
          .filter((l) => l.includes('so it is not named in the command below'));
        expect(clauseLines.length, JSON.stringify(name).slice(0, 40)).toBeGreaterThan(0);
        for (const line of clauseLines) expect((line.match(/'/g) ?? []).length % 2).toBe(0);
      }
    }
  });

  it('no pasted span of a refusal naming a non-plain stack runs anything', () => {
    withPasteDir((dir) => {
      for (const name of NON_PLAIN) {
        expectNothingRunsButTheDisplay(refusal(name, 'Producer'), dir, name, `${name} consumer`);
        expectNothingRunsButTheDisplay(refusal('Consumer', name), dir, name, `${name} producer`);
      }
    });
  }, 120_000);
});
