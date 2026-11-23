/** Evaluate the test operators supported by the browser shell, without rewriting shell source. */
export function testExpression(
  args: string[],
  fileTest: (operator: string, operand: string) => boolean,
): boolean {
  let pos = 0;
  const operand = (): string => {
    if (pos >= args.length) throw new Error('argument expected');
    return args[pos++]!;
  };
  const atom = (): boolean => {
    const left = operand();
    if (left === '!') return !atom();
    if (left === '(') {
      const value = or();
      if (operand() !== ')') throw new Error('missing )');
      return value;
    }
    if (['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(args[pos] ?? '')) {
      const op = operand();
      const right = operand();
      if (op === '=' || op === '==') return left === right;
      if (op === '!=') return left !== right;
      if (op === '<') return left < right;
      if (op === '>') return left > right;
      if (!/^[+-]?\d+$/.test(left) || !/^[+-]?\d+$/.test(right)) throw new Error('integer expected');
      const a = Number(left);
      const b = Number(right);
      return op === '-eq' ? a === b : op === '-ne' ? a !== b : op === '-lt' ? a < b
        : op === '-le' ? a <= b : op === '-gt' ? a > b : a >= b;
    }
    if (pos < args.length && /^-[efdsrwxzn]$/.test(left)) {
      const right = operand();
      if (left === '-z') return right.length === 0;
      if (left === '-n') return right.length > 0;
      return fileTest(left, right);
    }
    return left.length > 0;
  };
  const and = (): boolean => {
    let value = atom();
    while (args[pos] === '-a') {
      pos++;
      const next = atom();
      value = value && next;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (args[pos] === '-o') {
      pos++;
      const next = and();
      value = value || next;
    }
    return value;
  };
  if (!args.length) return false;
  // Single arguments are strings, including operator-looking filenames.
  if (args.length === 1) return args[0]!.length > 0;
  const value = or();
  if (pos !== args.length) throw new Error('too many arguments');
  return value;
}