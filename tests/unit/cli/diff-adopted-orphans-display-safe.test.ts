/**
 * go-to-k/cdkd#3642 review: `cdkd diff`'s "resource(s) to adopt from a previous
 * rollback" line names each adopted orphan by its STATE-CHOSEN logical id.
 *
 * It used `stripControlChars`, which keeps U+2028 / U+2029 and draws no
 * boundary, so on the `', '`-joined line an id spelled `A (AWS::IAM::Role), B`
 * read as two adoptions. It now takes `displayLogicalId`, as the
 * unreadable-row line beside it does. `--json`'s `adoptedOrphans` keeps the raw
 * keys and is pinned here too, so a later "fix" that sanitizes the machine
 * payload (where a many-to-one rendering is a collision) is a visible choice.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  diffTreeToJson,
  renderDiffTree,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';

function node(adoptedOrphans: string[]): DiffTreeNode {
  return {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: new Map(),
    ccApiRoutes: new Map(),
    outputChanges: [],
    adoptedOrphans,
    unreadable: [],
    blocking: [],
    children: [],
  };
}

function adoptLine(adopted: string[]): string | undefined {
  const lines: string[] = [];
  renderDiffTree(node(adopted), true, (m) => lines.push(m));
  return lines.find((l) => l.includes('to adopt from a previous rollback'));
}

describe('cdkd diff adopted-orphan line (#3642)', () => {
  it('quotes a spoofing id, so it cannot read as two adoptions', () => {
    expect(adoptLine(['A (AWS::IAM::Role), B', 'C'])).toBe(
      '2 resource(s) to adopt from a previous rollback: "A (AWS::IAM::Role), B", C'
    );
  });

  it('removes a line separator and a bidi override, keeping the id findable', () => {
    expect(adoptLine(['Kept\u2028Role\u202e'])).toBe(
      '1 resource(s) to adopt from a previous rollback: "Kept Role"'
    );
  });

  it('renders ordinary ids byte-identically', () => {
    expect(adoptLine(['KeptRole', 'My-Bucket'])).toBe(
      '2 resource(s) to adopt from a previous rollback: KeptRole, My-Bucket'
    );
  });

  it('keeps the raw keys in --json', () => {
    expect(diffTreeToJson(node(['Kept\u2028Role'])).adoptedOrphans).toEqual(['Kept\u2028Role']);
  });
});
