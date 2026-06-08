import type { Position } from "./locations";

const KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "declare",
  "else",
  "elseif",
  "end",
  "export",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "type",
  "typeof",
  "until",
  "while",
]);

const MULTI_SYMBOLS = [
  "...",
  "->",
  "==",
  "~=",
  "<=",
  ">=",
  "//=",
  "..=",
  "..",
  "//",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
  "::",
];

export interface TokenLocation {
  start: Position;
  end: Position;
}

export interface Token {
  type: string;
  value: string;
  line: number;
  column: number;
  range: [number, number];
  loc: TokenLocation;
}

export interface TokenizerInstance {
  source: string;
  length: number;
  index: number;
  line: number;
  column: number;
  peeked: Token | null;
  next(): Token;
  peek(): Token;
}

export interface TokenizerConstructor {
  new (source: string): TokenizerInstance;
}

export class Tokenizer implements TokenizerInstance {
  source: string;
  length: number;
  index: number;
  line: number;
  column: number;
  peeked: Token | null;

  constructor(source: string) {
    this.source = source;
    this.length = source.length;
    this.index = 0;
    this.line = 1;
    this.column = 1;
    this.peeked = null;
  }

  makeToken(type: string, value: string, startIndex: number, startLine: number, startColumn: number): Token {
    return {
      type,
      value,
      line: startLine,
      column: startColumn,
      range: [startIndex, this.index],
      loc: {
        start: { line: startLine, column: startColumn },
        end: { line: this.line, column: this.column },
      },
    };
  }

  peek(): Token {
    if (!this.peeked) {
      this.peeked = this.next();
    }
    return this.peeked;
  }

  next(): Token {
    if (this.peeked) {
      const tok = this.peeked;
      this.peeked = null;
      return tok;
    }
    this.skipWhitespace();
    if (this.index >= this.length) {
      return this.makeToken("eof", "", this.index, this.line, this.column);
    }

    const ch = this.source[this.index];

    if (this.isIdentifierStart(ch)) {
      return this.readIdentifier();
    }
    if (this.isDigit(ch)) {
      return this.readNumber();
    }
    if (ch === "\"" || ch === "'") {
      return this.readQuotedString();
    }
    if (ch === "`") {
      return this.readInterpolatedString();
    }
    if (ch === "[") {
      const long = this.readLongString();
      if (long) {
        return long;
      }
    }
    if (ch === "-" && this.source[this.index + 1] === "-") {
      this.readComment();
      return this.next();
    }

    return this.readSymbol();
  }

  skipWhitespace(): void {
    while (this.index < this.length) {
      const ch = this.source[this.index];
      if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f") {
        this.advance(1);
        continue;
      }
      if (ch === "\r") {
        if (this.source[this.index + 1] === "\n") {
          this.advance(2);
        } else {
          this.advance(1);
        }
        this.line += 1;
        this.column = 1;
        continue;
      }
      if (ch === "\n") {
        this.advance(1);
        this.line += 1;
        this.column = 1;
        continue;
      }
      break;
    }
  }

  advance(count: number): void {
    this.index += count;
    this.column += count;
  }

  advanceTo(index: number): void {
    const slice = this.source.slice(this.index, index);
    for (let i = 0; i < slice.length; i += 1) {
      const ch = slice[i];
      if (ch === "\r") {
        if (slice[i + 1] === "\n") {
          i += 1;
        }
        this.line += 1;
        this.column = 1;
        continue;
      }
      if (ch === "\n") {
        this.line += 1;
        this.column = 1;
        continue;
      }
      this.column += 1;
    }
    this.index = index;
  }

  isIdentifierStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch);
  }

  isIdentifierPart(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
  }

  isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
  }

  isHexDigit(ch: string): boolean {
    return /[0-9a-fA-F]/.test(ch);
  }

  isBinaryDigit(ch: string): boolean {
    return ch === "0" || ch === "1";
  }

  readIdentifier(): Token {
    const start = this.index;
    const line = this.line;
    const column = this.column;
    this.advance(1);
    while (this.index < this.length && this.isIdentifierPart(this.source[this.index])) {
      this.advance(1);
    }
    const value = this.source.slice(start, this.index);
    if (KEYWORDS.has(value)) {
      return this.makeToken("keyword", value, start, line, column);
    }
    return this.makeToken("identifier", value, start, line, column);
  }

  readNumber(): Token {
    const start = this.index;
    const line = this.line;
    const column = this.column;
    const first = this.source[this.index];
    const next = this.source[this.index + 1];

    if (first === "0" && (next === "x" || next === "X")) {
      this.advance(2);
      let sawDot = false;
      while (this.index < this.length) {
        const ch = this.source[this.index];
        if (this.isHexDigit(ch) || ch === "_") {
          this.advance(1);
          continue;
        }
        if (ch === "." && !sawDot && this.isHexDigit(this.source[this.index + 1] || "")) {
          sawDot = true;
          this.advance(1);
          continue;
        }
        if (ch === "p" || ch === "P") {
          this.advance(1);
          if (this.source[this.index] === "+" || this.source[this.index] === "-") {
            this.advance(1);
          }
          while (this.index < this.length) {
            const expCh = this.source[this.index];
            if (this.isDigit(expCh) || expCh === "_") {
              this.advance(1);
              continue;
            }
            break;
          }
          break;
        }
        break;
      }
      const value = this.source.slice(start, this.index);
      return this.makeToken("number", value, start, line, column);
    }

    if (first === "0" && (next === "b" || next === "B")) {
      this.advance(2);
      while (this.index < this.length) {
        const ch = this.source[this.index];
        if (this.isBinaryDigit(ch) || ch === "_") {
          this.advance(1);
          continue;
        }
        break;
      }
      const value = this.source.slice(start, this.index);
      return this.makeToken("number", value, start, line, column);
    }

    while (this.index < this.length) {
      const ch = this.source[this.index];
      if (this.isDigit(ch) || ch === "_") {
        this.advance(1);
        continue;
      }
      break;
    }
    if (this.source[this.index] === "." && this.isDigit(this.source[this.index + 1])) {
      this.advance(1);
      while (this.index < this.length) {
        const ch = this.source[this.index];
        if (this.isDigit(ch) || ch === "_") {
          this.advance(1);
          continue;
        }
        break;
      }
    }
    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      const expNext = this.source[this.index + 1];
      if (this.isDigit(expNext) || expNext === "+" || expNext === "-") {
        this.advance(1);
        if (this.source[this.index] === "+" || this.source[this.index] === "-") {
          this.advance(1);
        }
        while (this.index < this.length) {
          const ch = this.source[this.index];
          if (this.isDigit(ch) || ch === "_") {
            this.advance(1);
            continue;
          }
          break;
        }
      }
    }
    const value = this.source.slice(start, this.index);
    return this.makeToken("number", value, start, line, column);
  }

  readQuotedString(): Token {
    const quote = this.source[this.index];
    const line = this.line;
    const column = this.column;
    const start = this.index;
    let i = this.index + 1;
    while (i < this.length) {
      const ch = this.source[i];
      if (ch === "\\") {
        const next = this.source[i + 1];
        if (next === "z") {
          i += 2;
          while (i < this.length) {
            const ws = this.source[i];
            if (ws === " " || ws === "\t" || ws === "\v" || ws === "\f" || ws === "\r" || ws === "\n") {
              i += 1;
              continue;
            }
            break;
          }
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        break;
      }
      if (ch === "\n" || ch === "\r") {
        break;
      }
      i += 1;
    }
    const raw = this.source.slice(this.index, i);
    this.advanceTo(i);
    return this.makeToken("string", raw, start, line, column);
  }

  readInterpolatedString(): Token {
    const line = this.line;
    const column = this.column;
    const start = this.index;
    let i = this.index + 1;
    let depth = 0;
    let long: { close: string } | null = null;
    while (i < this.length) {
      if (long) {
        if (this.source.startsWith(long.close, i)) {
          i += long.close.length;
          long = null;
          continue;
        }
        i += 1;
        continue;
      }
      const ch = this.source[i];
      if (ch === "\\") {
        const next = this.source[i + 1];
        if (next === "z") {
          i += 2;
          while (i < this.length) {
            const ws = this.source[i];
            if (ws === " " || ws === "\t" || ws === "\v" || ws === "\f" || ws === "\r" || ws === "\n") {
              i += 1;
              continue;
            }
            break;
          }
          continue;
        }
        if (next === "\r") {
          i += this.source[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (next === "\n") {
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (depth === 0 && ch === "`") {
        i += 1;
        break;
      }
      if (depth === 0 && (ch === "\n" || ch === "\r")) {
        break;
      }
      if (depth > 0 && (ch === "\"" || ch === "'" || ch === "`")) {
        i = this.skipQuotedStringAt(i, ch);
        continue;
      }
      if (depth > 0 && ch === "-" && this.source[i + 1] === "-") {
        const commentLong = this.readLongBracketInfo(i + 2);
        if (commentLong) {
          long = { close: commentLong.close };
          i += 2 + commentLong.openLength;
          continue;
        }
        i += 2;
        while (i < this.length && this.source[i] !== "\n" && this.source[i] !== "\r") {
          i += 1;
        }
        continue;
      }
      if (depth > 0 && ch === "[") {
        const longString = this.readLongBracketInfo(i);
        if (longString) {
          long = { close: longString.close };
          i += longString.openLength;
          continue;
        }
      }
      if (ch === "{") {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === "}" && depth > 0) {
        depth -= 1;
        i += 1;
        continue;
      }
      i += 1;
    }
    const raw = this.source.slice(this.index, i);
    this.advanceTo(i);
    return this.makeToken("interpString", raw, start, line, column);
  }

  skipQuotedStringAt(index: number, quote: string): number {
    let i = index + 1;
    while (i < this.length) {
      const ch = this.source[i];
      if (ch === "\\") {
        const next = this.source[i + 1];
        if (next === "z") {
          i += 2;
          while (i < this.length) {
            const ws = this.source[i];
            if (ws === " " || ws === "\t" || ws === "\v" || ws === "\f" || ws === "\r" || ws === "\n") {
              i += 1;
              continue;
            }
            break;
          }
          continue;
        }
        if (next === "\r") {
          i += this.source[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (next === "\n") {
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === quote) {
        return i + 1;
      }
      i += 1;
    }
    return this.length;
  }

  readLongBracketInfo(index: number): { openLength: number; close: string } | null {
    if (this.source[index] !== "[") {
      return null;
    }
    let i = index + 1;
    let equalsCount = 0;
    while (this.source[i] === "=") {
      equalsCount += 1;
      i += 1;
    }
    if (this.source[i] !== "[") {
      return null;
    }
    return {
      openLength: i - index + 1,
      close: `]${"=".repeat(equalsCount)}]`,
    };
  }

  readLongString(): Token | null {
    const line = this.line;
    const column = this.column;
    const start = this.index;
    let i = this.index + 1;
    let equalsCount = 0;
    while (this.source[i] === "=") {
      equalsCount += 1;
      i += 1;
    }
    if (this.source[i] !== "[") {
      return null;
    }
    i += 1;
    const close = `]${"=".repeat(equalsCount)}]`;
    const end = this.source.indexOf(close, i);
    if (end === -1) {
      return null;
    }
    const raw = this.source.slice(this.index, end + close.length);
    this.advanceTo(end + close.length);
    return this.makeToken("string", raw, start, line, column);
  }

  readComment(): void {
    this.advance(2);
    if (this.source[this.index] === "[") {
      const long = this.readLongString();
      if (long) {
        return;
      }
    }
    while (this.index < this.length && this.source[this.index] !== "\n") {
      this.advance(1);
    }
  }

  readSymbol(): Token {
    const line = this.line;
    const column = this.column;
    const start = this.index;
    for (const symbol of MULTI_SYMBOLS) {
      if (this.source.startsWith(symbol, this.index)) {
        this.advance(symbol.length);
        return this.makeToken("symbol", symbol, start, line, column);
      }
    }
    const value = this.source[this.index];
    this.advance(1);
    return this.makeToken("symbol", value, start, line, column);
  }
}
