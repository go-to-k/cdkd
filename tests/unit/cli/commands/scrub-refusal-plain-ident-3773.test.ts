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

/**
 * The same refusal's PROSE (go-to-k/cdkd#3773). `displayIdent` bounds a
 * non-plain name in quotes but keeps the padding inside them, and a terminal
 * wraps a long line at its width, so a planted name could still print a
 * counterfeit `Then re-run:` row at column 0 above the genuine one. Every
 * name the prose shows is withheld when it carries a space after the display
 * sanitizer, the one thing a labelled row cannot be spelled without.
 */
describe('scrub producer-plaintext refusal: no name in its prose can wrap into a labelled row (go-to-k/cdkd#3773)', () => {
  const PAYLOAD = 'Then re-run: cdkd scrub --all #';
  const FORGED = [
    `Prod\n${PAYLOAD}`,
    `Prod${' '.repeat(60)}${PAYLOAD}`,
    `Prod\t${PAYLOAD}`,
    // U+00A0, spelled by code so a reader of the diff can see it.
    `Prod${String.fromCharCode(0xa0)}${PAYLOAD}`,
  ];
  const LABELS = ['Scrub with: ', 'Then re-run: '];

  /** The rows a terminal `width` columns wide prints, hard-wrapped as a terminal does. */
  function rows(message: string, width: number): string[] {
    return message.split('\n').flatMap((line) => {
      const out: string[] = [];
      for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
      return out.length > 0 ? out : [''];
    });
  }

  /** Every labelled row, at every width, is one of the message's own labelled lines. */
  function expectNoForgedRow(message: string): void {
    const genuine = message.split('\n').filter((l) => LABELS.some((p) => l.startsWith(p)));
    for (let width = 16; width <= 240; width++) {
      const labelled = rows(message, width).filter((r) => LABELS.some((p) => r.startsWith(p)));
      expect(labelled, `width ${width}`).toHaveLength(genuine.length);
    }
    expect(message).not.toContain('--all');
  }

  function render(o: {
    consumer?: string;
    producer?: string;
    key?: string;
    path?: string;
    origin?: string;
    via?: string[];
    kind?: 'declared' | 'chained' | 'widened';
    secrets?: Map<string, string>;
  }): string {
    const via = o.via ?? [];
    return plaintextProducerCrossStackReadError(
      o.origin ?? 'resource Db',
      o.consumer ?? 'Consumer',
      'Fn::ImportValue',
      o.path ?? 'MasterUserPassword',
      o.producer ?? 'Producer',
      o.key ?? 'Shared-DbSecret',
      { kind: o.kind ?? (via.length > 0 ? 'chained' : 'declared'), via },
      o.secrets ?? new Map()
    ).message;
  }

  const withheld = (what: string): string =>
    `(${what} withheld: it holds whitespace or a character outside printable ASCII)`;

  it('shows every plain, CDK-generated, bracketed and masked name as before (positive control)', () => {
    const secret = 's3cr3tVALUE';
    const message = render({
      consumer: 'Consumer-1',
      producer: `Prod-${secret}`,
      key: 'Producer:ExportsOutputRefDbSecret1234ABCD',
      path: "Environment['Fn::If'][0]",
      via: ['Mid~Child', 'Root.v2'],
      secrets: new Map([[secret, '{{resolve:secretsmanager:db}}']]),
    });
    expect(message).toContain(
      `Scrub of Consumer-1 resolved the Fn::ImportValue in resource Db at ` +
        `${JSON.stringify("Environment['Fn::If'][0]")} to a PLAINTEXT value: the producer stack ` +
        `"Prod-***" publishes Producer:ExportsOutputRefDbSecret1234ABCD by RE-EXPORTING a value ` +
        `that Root.v2 declares from a {{resolve:...}} expression (through Mid~Child), but`
    );
    expect(message).not.toContain('withheld: it holds whitespace');
    expect(message).not.toContain(secret);
    expect(message).toContain('so it is shown masked and is not named in the command below');
  });

  it('a long space-free stack name is shown whole, at the stack-name cap rather than the default 255', () => {
    const long = `Parent~${'Child'.repeat(80)}`;
    const message = render({ consumer: long, producer: long });
    expect(message).toContain(`Scrub of ${long} resolved`);
    expect(message).toContain(`the producer stack ${long} declares`);
    expect(message.split('\n')[0]).not.toContain('[cut:');
  });

  it('a sanitizer-trimmed edge is shown quoted, since no space is left in it', () => {
    expect(render({ producer: 'Producer\u0000' })).toContain('the producer stack "Producer" declares');
  });

  for (const forged of FORGED) {
    const tag = JSON.stringify(forged).slice(0, 12);

    it(`withholds a forged CONSUMER stack name ${tag}`, () => {
      const message = render({ consumer: forged });
      expect(message.startsWith(`Scrub of ${withheld('stack name')} resolved`)).toBe(true);
      expectNoForgedRow(message);
    });

    it(`withholds a forged PRODUCER stack name ${tag}`, () => {
      const message = render({ producer: forged });
      expect(message).toContain(`the producer stack ${withheld('stack name')} declares`);
      expectNoForgedRow(message);
    });

    it(`withholds a forged EXPORT KEY ${tag}, in every claim arm`, () => {
      for (const [kind, via] of [
        ['declared', []],
        ['chained', ['Root']],
        ['chained', []],
        ['widened', ['Root']],
        ['widened', []],
      ] as const) {
        const message = render({ key: forged, kind, via: [...via] });
        expect(message, `${kind} ${via.length}`).toContain(withheld('export name'));
        expectNoForgedRow(message);
      }
    });

    it(`withholds a forged CHAIN ROOT and a forged chain member ${tag}`, () => {
      for (const kind of ['chained', 'widened'] as const) {
        const root = render({ via: ['Mid', forged], kind });
        expect(root).toContain(`a value ${kind === 'chained' ? 'that ' : ''}${withheld('stack name')} declares`);
        expectNoForgedRow(root);
        const member = render({ via: [forged, 'Root'], kind });
        expect(member).toContain(`(through ${withheld('stack name')})`);
        expectNoForgedRow(member);
      }
    });

    it(`withholds a forged PROPERTY PATH ${tag}`, () => {
      const message = render({ path: forged });
      expect(message).toContain(`in resource Db at ${withheld('property path')} to a PLAINTEXT value`);
      expectNoForgedRow(message);
    });

    it(`withholds a forged name that is ALSO masked ${tag}`, () => {
      const secret = 's3cr3tVALUE';
      const message = render({
        producer: forged.replace('Prod', `Prod-${secret}`),
        secrets: new Map([[secret, '{{resolve:secretsmanager:db}}']]),
      });
      expect(message).toContain(`the producer stack ${withheld('stack name')} declares`);
      expect(message).not.toContain(secret);
      // The clause must agree with the prose: the name is not shown at all.
      expect(message).toContain('so it is not shown above and is not named in the command below');
      expect(message).not.toContain('shown masked');
      expectNoForgedRow(message);
    });

    it(`withholds a forged CHAIN MEMBER that is ALSO masked ${tag}`, () => {
      // The clause is built per chain member, so the branch is pinned at a
      // member as well as at the direct producer.
      const secret = 's3cr3tVALUE';
      const message = render({
        via: [forged.replace('Prod', `Mid-${secret}`), 'Root'],
        secrets: new Map([[secret, '{{resolve:secretsmanager:db}}']]),
      });
      expect(message).toContain(`(through ${withheld('stack name')})`);
      expect(message).not.toContain(secret);
      expect(message).toContain(
        'A producer stack name holds a value recorded as a secret, so it is not shown above and is not named in the command below'
      );
      expect(message).not.toContain('shown masked');
      expectNoForgedRow(message);
    });
  }

  it('says why a name with printable non-ASCII INSIDE it is withheld, since the sanitizer blanks it to a space', () => {
    const message = render({ producer: 'Pro\u00e9d' });
    expect(message).toContain(
      'the producer stack (stack name withheld: it holds whitespace or a character outside printable ASCII) declares'
    );
  });
});
