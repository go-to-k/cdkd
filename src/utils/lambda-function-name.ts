/**
 * How a Lambda `FunctionName` value addresses a function (issue #4118): the
 * function NAME, plus the partition / region / account an ARN spelling pins.
 * A bare name pins none of them; a partial ARN (`<account>:function:<name>`)
 * pins the account. `undefined` for a value that is none of these shapes, such
 * as a QUALIFIED ARN, which keeps its qualifier and is compared verbatim. A LEAF.
 */
export interface LambdaFunctionAddress {
  name: string;
  partition?: string;
  region?: string;
  account?: string;
}

export function parseLambdaFunctionAddress(value: string): LambdaFunctionAddress | undefined {
  const full = /^arn:([^:]+):lambda:([^:]+):(\d{12}):function:([^:]+)$/.exec(value);
  if (full) return { partition: full[1]!, region: full[2]!, account: full[3]!, name: full[4]! };
  const partial = /^(\d{12}):function:([^:]+)$/.exec(value);
  if (partial) return { account: partial[1]!, name: partial[2]! };
  if (/^[A-Za-z0-9_-]+$/.test(value)) return { name: value };
  return undefined;
}

/**
 * Whether two `FunctionName` spellings can address the same function: the
 * names match and every field BOTH spellings pin matches. A bare name against
 * an ARN leaves the ARN's account and region unconfirmed, which the caller
 * must settle against AWS before it acts on the answer.
 */
export function sameLambdaFunctionAddress(a: string, b: string): boolean {
  if (a === b) return true;
  const x = parseLambdaFunctionAddress(a);
  const y = parseLambdaFunctionAddress(b);
  if (x === undefined || y === undefined) return false;
  return (
    x.name === y.name &&
    (x.partition === undefined || y.partition === undefined || x.partition === y.partition) &&
    (x.region === undefined || y.region === undefined || x.region === y.region) &&
    (x.account === undefined || y.account === undefined || x.account === y.account)
  );
}

/** The function NAME a spelling addresses, or the value itself when it is not a recognized shape. */
export function canonicalLambdaFunctionName(value: string): string {
  return parseLambdaFunctionAddress(value)?.name ?? value;
}
