/**
 * The cross-stack plaintext-producer refusal, pasted (go-to-k/cdkd#4205).
 *
 * Its `Scrub with:` lines (`scrubRefusalWording`) and its `Then re-run:` line
 * named a stack shell-quoted, and the prose above them carries `this stack's`,
 * so a planted producer or consumer name ran once the lines were pasted as one
 * block. The names come from the state listing, so anyone who can write the
 * state bucket can plant one. The PROSE still displays the name through
 * `displayStackName`'s JSON boundary, which a `$( )` or backtick runs inside
 * (the display residual go-to-k/cdkd#3950 tracks, not this issue's), so the
 * three families carrying one are held to that residual and the separator family
 * to nothing at all
 * (`expectNothingRunsButTheDisplay`). The builder is called DIRECTLY: reaching it
 * through `scrubStack` needs a chained state fixture per stack name, and the
 * case is about the text the builder renders.
 */

import { describe, expect, it } from 'vite-plus/test';
import { plaintextProducerCrossStackReadError } from '../../../../src/cli/commands/scrub.js';
import {
  PASTE_PAYLOADS,
  expectNothingRunsButTheDisplay,
  withPasteDir,
} from '../../utils/paste-harness.js';

function refusal(stackName: string, producerStack: string): string {
  return plaintextProducerCrossStackReadError(
    'Resources.Db.Properties',
    stackName,
    'Fn::ImportValue',
    'MasterUserPassword',
    producerStack,
    'Shared-DbSecret',
    { kind: 'declared', via: [] },
    new Map()
  ).message;
}

describe('the scrub producer-plaintext refusal names no shell-active stack (go-to-k/cdkd#4205)', () => {
  it('holes a payload consumer or producer name in its commands, and no pasted span runs', () => {
    expect(refusal('Consumer', 'Producer').split('\n').slice(-2)).toEqual([
      'Scrub with: cdkd scrub Producer',
      'Then re-run: cdkd scrub Consumer',
    ]);
    const messages: Array<[string, string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      const asConsumer = refusal(value, 'Producer');
      expect(asConsumer.split('\n').slice(-2), label).toEqual([
        'Scrub with: cdkd scrub Producer',
        "Then re-run: cdkd scrub '<stack>'",
      ]);
      const asProducer = refusal('Consumer', value);
      expect(asProducer.split('\n').slice(-2), label).toEqual([
        "Scrub with: cdkd scrub '<stack>'",
        'Then re-run: cdkd scrub Consumer',
      ]);
      messages.push([`${label} consumer`, value, asConsumer], [`${label} producer`, value, asProducer]);
    }
    withPasteDir((dir) => {
      for (const [label, value, message] of messages) expectNothingRunsButTheDisplay(message, dir, value, label);
    });
  }, 120_000);
});
