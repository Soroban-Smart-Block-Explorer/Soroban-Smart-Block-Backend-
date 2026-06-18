/**
 * Expression Language Parser & Evaluator
 * Supports: arithmetic, comparison, logical operations, functions, and aggregations
 * Designed for non-developers to define contract invariants safely
 */

import {
  Token,
  TokenType,
  ASTNode,
  BinaryOpNode,
  UnaryOpNode,
  LiteralNode,
  IdentifierNode,
  FunctionCallNode,
  PrimitiveValue,
  JsonValue,
  ExpressionContext,
} from './types';

// ============================================================================
// LEXER (TOKENIZER)
// ============================================================================

export class Lexer {
  private input: string;
  private position: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    while (this.position < this.input.length) {
      this.skipWhitespace();
      if (this.position >= this.input.length) break;

      const char = this.input[this.position];

      if (this.isDigit(char) || (char === '.' && this.isDigit(this.peek(1)))) {
        this.tokens.push(this.readNumber());
      } else if (this.isAlpha(char) || char === '_') {
        this.tokens.push(this.readIdentifier());
      } else if (char === '"' || char === "'") {
        this.tokens.push(this.readString());
      } else if (this.isOperator(char)) {
        this.tokens.push(this.readOperator());
      } else if (char === '(') {
        this.addToken(TokenType.LPAREN, '(');
        this.advance();
      } else if (char === ')') {
        this.addToken(TokenType.RPAREN, ')');
        this.advance();
      } else if (char === ',') {
        this.addToken(TokenType.COMMA, ',');
        this.advance();
      } else {
        throw new Error(`Unexpected character '${char}' at line ${this.line}, column ${this.column}`);
      }
    }

    this.addToken(TokenType.EOF, '');
    return this.tokens;
  }

  private readNumber(): Token {
    const start = this.position;
    const startLine = this.line;
    const startColumn = this.column;

    while (this.position < this.input.length && (this.isDigit(this.input[this.position]) || this.input[this.position] === '.')) {
      this.advance();
    }

    const value = parseFloat(this.input.substring(start, this.position));
    return { type: TokenType.NUMBER, value, line: startLine, column: startColumn };
  }

  private readIdentifier(): Token {
    const start = this.position;
    const startLine = this.line;
    const startColumn = this.column;

    while (
      this.position < this.input.length &&
      (this.isAlphaNumeric(this.input[this.position]) || this.input[this.position] === '_')
    ) {
      this.advance();
    }

    const value = this.input.substring(start, this.position);
    return { type: TokenType.IDENTIFIER, value, line: startLine, column: startColumn };
  }

  private readString(): Token {
    const quote = this.input[this.position];
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip opening quote

    let value = '';
    while (this.position < this.input.length && this.input[this.position] !== quote) {
      if (this.input[this.position] === '\\') {
        this.advance();
        const escaped = this.input[this.position];
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case '\\':
            value += '\\';
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          default:
            value += escaped;
        }
        this.advance();
      } else {
        value += this.input[this.position];
        this.advance();
      }
    }

    if (this.position >= this.input.length) {
      throw new Error(`Unterminated string at line ${startLine}, column ${startColumn}`);
    }

    this.advance(); // skip closing quote
    return { type: TokenType.STRING, value, line: startLine, column: startColumn };
  }

  private readOperator(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const char = this.input[this.position];
    const nextChar = this.peek(1);

    // Two-character operators
    const twoCharOp = char + nextChar;
    if (['==', '!=', '<=', '>=', '&&', '||', '^', '..'].includes(twoCharOp)) {
      this.advance();
      this.advance();
      return { type: TokenType.OPERATOR, value: twoCharOp, line: startLine, column: startColumn };
    }

    // Single-character operators
    if (['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^'].includes(char)) {
      this.advance();
      return { type: TokenType.OPERATOR, value: char, line: startLine, column: startColumn };
    }

    throw new Error(`Unknown operator '${char}' at line ${startLine}, column ${startColumn}`);
  }

  private skipWhitespace(): void {
    while (this.position < this.input.length && /\s/.test(this.input[this.position])) {
      if (this.input[this.position] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.position++;
    }
  }

  private isDigit(char: string): boolean {
    return /[0-9]/.test(char);
  }

  private isAlpha(char: string): boolean {
    return /[a-zA-Z_]/.test(char);
  }

  private isAlphaNumeric(char: string): boolean {
    return /[a-zA-Z0-9_]/.test(char);
  }

  private isOperator(char: string): boolean {
    return /[+\-*/%<>=!&|^]/.test(char);
  }

  private peek(offset: number = 1): string {
    const pos = this.position + offset;
    return pos < this.input.length ? this.input[pos] : '\0';
  }

  private advance(): void {
    this.column++;
    this.position++;
  }

  private addToken(type: TokenType, value: string | number): void {
    this.tokens.push({ type, value, line: this.line, column: this.column });
  }
}

// ============================================================================
// PARSER (AST BUILDER)
// ============================================================================

export class Parser {
  private tokens: Token[];
  private current: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode {
    return this.parseExpression();
  }

  private parseExpression(): ASTNode {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): ASTNode {
    let left = this.parseLogicalAnd();

    while (this.match('||')) {
      const operator = this.previous().value as string;
      const right = this.parseLogicalAnd();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseLogicalAnd(): ASTNode {
    let left = this.parseEquality();

    while (this.match('&&')) {
      const operator = this.previous().value as string;
      const right = this.parseEquality();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseEquality(): ASTNode {
    let left = this.parseComparison();

    while (this.match('==', '!=')) {
      const operator = this.previous().value as string;
      const right = this.parseComparison();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseComparison(): ASTNode {
    let left = this.parseAddition();

    while (this.match('<', '>', '<=', '>=')) {
      const operator = this.previous().value as string;
      const right = this.parseAddition();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseAddition(): ASTNode {
    let left = this.parseMultiplication();

    while (this.match('+', '-')) {
      const operator = this.previous().value as string;
      const right = this.parseMultiplication();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseMultiplication(): ASTNode {
    let left = this.parseExponentiation();

    while (this.match('*', '/', '%')) {
      const operator = this.previous().value as string;
      const right = this.parseExponentiation();
      left = { type: 'BinaryOp', operator, left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseExponentiation(): ASTNode {
    let left = this.parseUnary();

    if (this.match('^')) {
      const right = this.parseExponentiation(); // right associative
      return { type: 'BinaryOp', operator: '^', left, right } as BinaryOpNode;
    }

    return left;
  }

  private parseUnary(): ASTNode {
    if (this.match('!', '-', 'NOT')) {
      const operator = this.previous().value as string;
      const operand = this.parseUnary();
      return { type: 'UnaryOp', operator, operand } as UnaryOpNode;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    // Literals
    if (this.match(TokenType.NUMBER)) {
      return { type: 'Literal', value: this.previous().value } as LiteralNode;
    }

    if (this.match(TokenType.STRING)) {
      return { type: 'Literal', value: this.previous().value } as LiteralNode;
    }

    // Parenthesized expression
    if (this.match(TokenType.LPAREN)) {
      const expr = this.parseExpression();
      this.consume(TokenType.RPAREN, 'Expected ) after expression');
      return expr;
    }

    // Function calls or identifiers
    if (this.match(TokenType.IDENTIFIER)) {
      const name = this.previous().value as string;

      // Check for function call
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        const args: ASTNode[] = [];

        if (!this.check(TokenType.RPAREN)) {
          do {
            args.push(this.parseExpression());
          } while (this.match(TokenType.COMMA));
        }

        this.consume(TokenType.RPAREN, 'Expected ) after function arguments');
        return { type: 'FunctionCall', name, arguments: args } as FunctionCallNode;
      }

      // Variable reference
      return { type: 'Identifier', name } as IdentifierNode;
    }

    throw new Error(`Unexpected token: ${this.peek().value}`);
  }

  private match(...types: (TokenType | string)[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private check(type: TokenType | string): boolean {
    if (this.isAtEnd()) return false;
    const token = this.peek();
    if (typeof type === 'string') {
      return token.type === TokenType.OPERATOR && token.value === type;
    }
    return token.type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw new Error(`${message} at token ${this.peek().value}`);
  }
}

// ============================================================================
// EVALUATOR (AST EXECUTOR)
// ============================================================================

export class Evaluator {
  private context: ExpressionContext;

  constructor(context: Partial<ExpressionContext> = {}) {
    this.context = {
      variables: context.variables || new Map(),
      functions: context.functions || new Map(),
      state: context.state || {},
    };
    this.registerBuiltinFunctions();
  }

  evaluate(ast: ASTNode): JsonValue {
    switch (ast.type) {
      case 'Literal':
        return (ast as LiteralNode).value;

      case 'Identifier': {
        const name = (ast as IdentifierNode).name;
        if (this.context.variables.has(name)) {
          return this.context.variables.get(name)!;
        }
        if (name in this.context.state) {
          return this.context.state[name];
        }
        throw new Error(`Undefined variable: ${name}`);
      }

      case 'BinaryOp': {
        const node = ast as BinaryOpNode;
        const left = this.evaluate(node.left);
        const right = this.evaluate(node.right);
        return this.evaluateBinaryOp(node.operator, left, right);
      }

      case 'UnaryOp': {
        const node = ast as UnaryOpNode;
        const operand = this.evaluate(node.operand);
        return this.evaluateUnaryOp(node.operator, operand);
      }

      case 'FunctionCall': {
        const node = ast as FunctionCallNode;
        const args = node.arguments.map(arg => this.evaluate(arg));
        return this.evaluateFunctionCall(node.name, args);
      }

      default:
        throw new Error(`Unknown AST node type: ${ast.type}`);
    }
  }

  private evaluateBinaryOp(operator: string, left: JsonValue, right: JsonValue): JsonValue {
    switch (operator) {
      // Arithmetic
      case '+':
        return (this.toNumber(left) + this.toNumber(right));
      case '-':
        return (this.toNumber(left) - this.toNumber(right));
      case '*':
        return (this.toNumber(left) * this.toNumber(right));
      case '/': {
        const divisor = this.toNumber(right);
        if (divisor === 0) throw new Error('Division by zero');
        return this.toNumber(left) / divisor;
      }
      case '%':
        return (this.toNumber(left) % this.toNumber(right));
      case '^':
        return Math.pow(this.toNumber(left), this.toNumber(right));

      // Comparison
      case '==':
        return this.deepEqual(left, right);
      case '!=':
        return !this.deepEqual(left, right);
      case '<':
        return this.toNumber(left) < this.toNumber(right);
      case '>':
        return this.toNumber(left) > this.toNumber(right);
      case '<=':
        return this.toNumber(left) <= this.toNumber(right);
      case '>=':
        return this.toNumber(left) >= this.toNumber(right);

      // Logical
      case '&&':
        return this.isTruthy(left) && this.isTruthy(right);
      case '||':
        return this.isTruthy(left) || this.isTruthy(right);

      default:
        throw new Error(`Unknown binary operator: ${operator}`);
    }
  }

  private evaluateUnaryOp(operator: string, operand: JsonValue): JsonValue {
    switch (operator) {
      case '-':
        return -this.toNumber(operand);
      case '!':
      case 'NOT':
        return !this.isTruthy(operand);
      default:
        throw new Error(`Unknown unary operator: ${operator}`);
    }
  }

  private evaluateFunctionCall(name: string, args: JsonValue[]): JsonValue {
    if (this.context.functions.has(name)) {
      const fn = this.context.functions.get(name)!;
      try {
        return fn(...args);
      } catch (error) {
        throw new Error(`Error calling function ${name}: ${error}`);
      }
    }
    throw new Error(`Undefined function: ${name}`);
  }

  private registerBuiltinFunctions(): void {
    this.context.functions.set('abs', (x: JsonValue) => Math.abs(this.toNumber(x)));
    this.context.functions.set('floor', (x: JsonValue) => Math.floor(this.toNumber(x)));
    this.context.functions.set('ceil', (x: JsonValue) => Math.ceil(this.toNumber(x)));
    this.context.functions.set('round', (x: JsonValue) => Math.round(this.toNumber(x)));
    this.context.functions.set('sqrt', (x: JsonValue) => Math.sqrt(this.toNumber(x)));
    this.context.functions.set('min', (...args: JsonValue[]) => Math.min(...args.map(a => this.toNumber(a))));
    this.context.functions.set('max', (...args: JsonValue[]) => Math.max(...args.map(a => this.toNumber(a))));
    this.context.functions.set('sum', (...args: JsonValue[]) => args.reduce((acc, v) => this.toNumber(acc) + this.toNumber(v), 0));
    this.context.functions.set('length', (x: JsonValue) => {
      if (typeof x === 'string') return x.length;
      if (Array.isArray(x)) return x.length;
      return 0;
    });
  }

  private toNumber(value: JsonValue): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const num = Number(value);
      if (isNaN(num)) throw new Error(`Cannot convert '${value}' to number`);
      return num;
    }
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    throw new Error(`Cannot convert ${typeof value} to number`);
  }

  private isTruthy(value: JsonValue): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    return true;
  }

  private deepEqual(a: JsonValue, b: JsonValue): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => this.deepEqual(v, b[i]));
    }
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(key => this.deepEqual((a as any)[key], (b as any)[key]));
    }
    return false;
  }

  setVariable(name: string, value: JsonValue): void {
    this.context.variables.set(name, value);
  }

  setFunction(name: string, fn: (...args: JsonValue[]) => JsonValue): void {
    this.context.functions.set(name, fn);
  }

  setState(state: Record<string, JsonValue>): void {
    this.context.state = state;
  }
}

// ============================================================================
// EXPRESSION COMPILER
// ============================================================================

export class ExpressionCompiler {
  compile(expression: string): (context: Partial<ExpressionContext>) => JsonValue {
    const lexer = new Lexer(expression);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    return (context: Partial<ExpressionContext>) => {
      const evaluator = new Evaluator(context);
      return evaluator.evaluate(ast);
    };
  }
}
