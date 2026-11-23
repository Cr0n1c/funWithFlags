type Token =
  | { kind: 'word'; raw: string; text: string }
  | { kind: 'space' | 'comment'; text: string }
  | { kind: 'operator'; text: string };

const replacements: Readonly<Record<string, string>> = {
  test: '__hpux_test',
  '[': '__hpux_bracket',
  cd: '__hpux_cd',
};

const commandKeywords = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!']);
const commandSeparators = new Set([';', '&&', '||', '|', '&', '\n', '(', '{']);
const redirections = new Set(['<', '>', '>>', '<>', '>|', '<&', '>&']);
const operators = ['&&', '||', ';;', '>>', '<<-', '<<', '<>', '>|', '<&', '>&', ';', '|', '&', '(', ')', '<', '>'];

function fail(message: string): never {
  throw new Error(`Cannot safely adapt shell source: ${message}`);
}

function decodeLiteralWord(raw: string): string | undefined {
  let decoded = '';
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === "'") {
      const end = raw.indexOf("'", index + 1);
      if (end < 0) return undefined;
      decoded += raw.slice(index + 1, end);
      index = end + 1;
    } else if (raw[index] === '"') {
      const end = raw.indexOf('"', index + 1);
      if (end < 0) return undefined;
      const body = raw.slice(index + 1, end);
      if (/[$`]/.test(body)) return undefined;
      decoded += body.replace(/\\(["\\])/g, '$1');
      index = end + 1;
    } else if (raw[index] === '\\') {
      if (index + 1 >= raw.length) return undefined;
      decoded += raw[index + 1];
      index += 2;
    } else if ('$`'.includes(raw[index] ?? '')) {
      return undefined;
    } else {
      decoded += raw[index];
      index += 1;
    }
  }
  return decoded;
}

function isOperatorStart(source: string, index: number): boolean {
  return ';|&()<>'.includes(source[index] ?? '');
}

function scanSingleQuote(source: string, start: number): number {
  const end = source.indexOf("'", start + 1);
  if (end < 0) fail('unterminated single quote');
  return end + 1;
}

function scanArithmetic(source: string, start: number): number {
  let depth = 1;
  let index = start + 3;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source[index] === "'") {
      index = scanSingleQuote(source, index);
    } else if (source[index] === '"') {
      index = scanDoubleQuote(source, index).end;
    } else if (source.startsWith('((', index)) {
      depth += 1;
      index += 2;
    } else if (source.startsWith('))', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return fail('unterminated arithmetic expansion');
}

function scanBacktick(source: string, start: number): { end: number; text: string } {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source[index] === '`') {
      const body = source.slice(start + 1, index);
      return { end: index + 1, text: `\`${adaptShellCommands(body)}\`` };
    } else {
      index += 1;
    }
  }
  return fail('unterminated backtick command substitution');
}

function scanParameterExpansion(source: string, start: number): { end: number; text: string } {
  let index = start + 2;
  let depth = 1;
  let text = '${';
  while (index < source.length) {
    if (source[index] === '\\') {
      text += source.slice(index, index + 2);
      index += 2;
    } else if (source[index] === "'") {
      const end = scanSingleQuote(source, index);
      text += source.slice(index, end);
      index = end;
    } else if (source[index] === '"') {
      const quoted = scanDoubleQuote(source, index);
      text += quoted.text;
      index = quoted.end;
    } else if (source.startsWith('$((', index)) {
      const end = scanArithmetic(source, index);
      text += source.slice(index, end);
      index = end;
    } else if (source.startsWith('$(', index)) {
      const nested = tokenize(source, index + 2, ')');
      text += `$(${render(nested.tokens)})`;
      index = nested.end;
    } else if (source[index] === '`') {
      const nested = scanBacktick(source, index);
      text += nested.text;
      index = nested.end;
    } else {
      const char = source[index];
      text += char;
      index += 1;
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) return { end: index, text };
    }
  }
  return fail('unterminated parameter expansion');
}

function scanDoubleQuote(source: string, start: number): { end: number; text: string } {
  let index = start + 1;
  let text = '"';
  while (index < source.length) {
    if (source[index] === '\\') {
      text += source.slice(index, index + 2);
      index += 2;
    } else if (source[index] === '"') {
      return { end: index + 1, text: `${text}"` };
    } else if (source.startsWith('$((', index)) {
      const end = scanArithmetic(source, index);
      text += source.slice(index, end);
      index = end;
    } else if (source.startsWith('$(', index)) {
      const nested = tokenize(source, index + 2, ')');
      text += `$(${render(nested.tokens)})`;
      index = nested.end;
    } else if (source.startsWith('${', index)) {
      const expansion = scanParameterExpansion(source, index);
      text += expansion.text;
      index = expansion.end;
    } else if (source[index] === '`') {
      const nested = scanBacktick(source, index);
      text += nested.text;
      index = nested.end;
    } else {
      text += source[index];
      index += 1;
    }
  }
  return fail('unterminated double quote');
}

function scanWord(source: string, start: number): { end: number; raw: string; text: string } {
  let index = start;
  let text = '';
  while (index < source.length && !/\s/.test(source[index] ?? '') && !isOperatorStart(source, index)) {
    if (source[index] === '\\') {
      text += source.slice(index, index + 2);
      index += 2;
    } else if (source[index] === "'") {
      const end = scanSingleQuote(source, index);
      text += source.slice(index, end);
      index = end;
    } else if (source[index] === '"') {
      const quoted = scanDoubleQuote(source, index);
      text += quoted.text;
      index = quoted.end;
    } else if (source.startsWith('$((', index)) {
      const end = scanArithmetic(source, index);
      text += source.slice(index, end);
      index = end;
    } else if (source.startsWith('$(', index)) {
      const nested = tokenize(source, index + 2, ')');
      text += `$(${render(nested.tokens)})`;
      index = nested.end;
    } else if (source.startsWith('${', index)) {
      const expansion = scanParameterExpansion(source, index);
      text += expansion.text;
      index = expansion.end;
    } else if (source[index] === '`') {
      const nested = scanBacktick(source, index);
      text += nested.text;
      index = nested.end;
    } else {
      text += source[index];
      index += 1;
    }
  }
  return { end: index, raw: source.slice(start, index), text };
}

function tokenize(source: string, start = 0, terminator?: ')'): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let index = start;
  let atTokenBoundary = true;

  while (index < source.length) {
    if (terminator && source[index] === terminator) return { tokens, end: index + 1 };
    if (/\s/.test(source[index] ?? '')) {
      const whitespaceStart = index;
      while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
      const whitespace = source.slice(whitespaceStart, index);
      for (const part of whitespace.split(/(\n)/)) {
        if (part === '\n') tokens.push({ kind: 'operator', text: part });
        else if (part) tokens.push({ kind: 'space', text: part });
      }
      atTokenBoundary = true;
      continue;
    }
    if (source[index] === '#' && atTokenBoundary) {
      const end = source.indexOf('\n', index);
      const commentEnd = end < 0 ? source.length : end;
      tokens.push({ kind: 'comment', text: source.slice(index, commentEnd) });
      index = commentEnd;
      atTokenBoundary = true;
      continue;
    }
    if (
      (source[index] === '{' || source[index] === '}')
      && atTokenBoundary
      && (index + 1 === source.length || /\s/.test(source[index + 1] ?? '') || isOperatorStart(source, index + 1))
    ) {
      tokens.push({ kind: 'operator', text: source[index] ?? '' });
      index += 1;
      atTokenBoundary = true;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      if (operator === '<<' || operator === '<<-') fail('here-documents are unsupported');
      tokens.push({ kind: 'operator', text: operator });
      index += operator.length;
      atTokenBoundary = true;
      continue;
    }
    const word = scanWord(source, index);
    if (word.end === index) fail(`unsupported token ${JSON.stringify(source[index])}`);
    tokens.push({ kind: 'word', raw: word.raw, text: word.text });
    index = word.end;
    atTokenBoundary = false;
  }
  if (terminator) fail('unterminated command substitution');
  return { tokens, end: index };
}

function render(tokens: Token[]): string {
  let commandPosition = true;
  let redirectTarget = false;
  let forHeaderDepth = 0;
  let functionNameExpected = false;
  const caseStack: Array<{ stage: 'header' | 'patterns' | 'body'; subjectSeen: boolean }> = [];

  return tokens.map((token, tokenIndex) => {
    const caseContext = caseStack.at(-1);
    const caseStage = caseContext?.stage;

    if (caseStage === 'patterns') {
      if (token.kind === 'word' && token.raw === 'esac') {
        caseStack.pop();
        commandPosition = false;
      } else if (token.kind === 'operator' && token.text === ')') {
        if (caseContext) caseContext.stage = 'body';
        commandPosition = true;
      }
      return token.text;
    }

    if (caseContext?.stage === 'header') {
      if (token.kind === 'word') {
        if (!caseContext.subjectSeen) {
          caseContext.subjectSeen = true;
        } else if (token.raw === 'in') {
          caseContext.stage = 'patterns';
        }
      }
      return token.text;
    }

    if (caseStage === 'body' && token.kind === 'operator' && token.text === ';;') {
      if (caseContext) caseContext.stage = 'patterns';
      commandPosition = false;
      redirectTarget = false;
      return token.text;
    }

    if (forHeaderDepth > 0) {
      if (token.kind === 'operator' && commandSeparators.has(token.text)) {
        commandPosition = true;
      } else if (token.kind === 'word' && token.raw === 'do' && commandPosition) {
        forHeaderDepth -= 1;
        commandPosition = true;
      } else if (token.kind === 'word') {
        commandPosition = false;
      }
      return token.text;
    }

    if (token.kind !== 'word') {
      if (token.kind === 'operator') {
        if (redirections.has(token.text)) {
          redirectTarget = true;
        } else if (commandSeparators.has(token.text)) {
          commandPosition = true;
          redirectTarget = false;
        } else if (token.text === ')' || token.text === ';;') {
          commandPosition = false;
          redirectTarget = false;
        }
      }
      return token.text;
    }

    if (caseStage === 'body' && commandPosition && token.raw === 'esac') {
      caseStack.pop();
      commandPosition = false;
      return token.text;
    }

    if (functionNameExpected) {
      functionNameExpected = false;
      const decodedName = decodeLiteralWord(token.raw);
      if (decodedName !== undefined && replacements[decodedName]) {
        fail(`definitions of compatibility command ${JSON.stringify(token.raw)} are unsupported`);
      }
      commandPosition = false;
      return token.text;
    }

    if (redirectTarget) {
      redirectTarget = false;
      return token.text;
    }

    const next = tokens.slice(tokenIndex + 1).find((candidate) => candidate.kind !== 'space' && candidate.kind !== 'comment');
    const isFileDescriptor = commandPosition
      && /^\d+$/.test(token.raw)
      && next?.kind === 'operator'
      && redirections.has(next.text);
    if (isFileDescriptor || (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw))) {
      return token.text;
    }

    if (commandPosition && commandKeywords.has(token.raw)) return token.text;

    if (commandPosition) {
      if (token.raw === 'case') {
        caseStack.push({ stage: 'header', subjectSeen: false });
        commandPosition = false;
        return token.text;
      }
      if (token.raw === 'for' || token.raw === 'select') {
        forHeaderDepth += 1;
        commandPosition = false;
        return token.text;
      }
      if (token.raw === 'function') {
        functionNameExpected = true;
        commandPosition = false;
        return token.text;
      }

      const following = tokens
        .slice(tokenIndex + 1)
        .filter((candidate) => candidate.kind !== 'space' && candidate.kind !== 'comment');
      if (
        following[0]?.kind === 'operator'
        && following[0].text === '('
        && following[1]?.kind === 'operator'
        && following[1].text === ')'
      ) {
        const decodedName = decodeLiteralWord(token.raw);
        if (decodedName !== undefined && replacements[decodedName]) {
          fail(`definitions of compatibility command ${JSON.stringify(token.raw)} are unsupported`);
        }
        commandPosition = false;
        return token.text;
      }

      const decoded = decodeLiteralWord(token.raw);
      if (decoded !== undefined && replacements[decoded]) {
        commandPosition = false;
        return replacements[decoded];
      }

      commandPosition = false;
      return replacements[token.raw] ?? token.text;
    }
    return token.text;
  }).join('');
}

/**
 * Rewrites HP-UX compatibility builtins only when they are literal command
 * names. All other source bytes, including quoting and whitespace, are retained.
 */
export function adaptShellCommands(source: string): string {
  return render(tokenize(source).tokens);
}