const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** Lines that usually carry the actual failure in common tool output. */
const FAILURE_LINE =
  /\berror\b|\bfail(?:ed|ure|s)?\b|\bexception\b|\bassert(?:ion)?\b|\bcannot\b|\bnot found\b|[✗✖×]|\bFAIL\b/i;
/** Package-manager wrapper noise that repeats the exit code without saying what failed. */
const WRAPPER_NOISE =
  /^(?:npm (?:error|ERR!|warn|notice)|\s*ELIFECYCLE\b|error Command failed with exit code|info Visit https:\/\/yarnpkg)/;
const MAX_LINE_CHARS = 200;
/** Partial lines are truncated beyond this, so one giant line cannot grow memory. */
const MAX_PENDING_CHARS = 4_096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Keeps a bounded excerpt of command output for failure previews: the first
 * lines that look like failures, falling back to the last lines of output.
 * Memory use is O(limit) regardless of how much the command prints.
 */
export class OutputCapture {
  private readonly limit: number;
  private readonly pending = new Map<unknown, string>();
  private readonly matches: string[] = [];
  private readonly tail: string[] = [];
  /** Most recent unindented line, e.g. the file name ESLint prints above its indented errors. */
  private header: string | null = null;
  private headerShown = false;

  constructor(limit: number) {
    this.limit = Math.max(0, limit);
  }

  write(source: unknown, text: string): void {
    if (this.limit === 0 || text === "") return;
    let buffer = (this.pending.get(source) ?? "") + text;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      this.addLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    this.pending.set(
      source,
      buffer.length > MAX_PENDING_CHARS ? buffer.slice(0, MAX_PENDING_CHARS) : buffer,
    );
  }

  preview(): string[] {
    for (const [source, rest] of this.pending) {
      if (rest) this.addLine(rest);
      this.pending.set(source, "");
    }
    return this.matches.length > 0 ? [...this.matches] : [...this.tail];
  }

  private addLine(raw: string): void {
    // Progress bars redraw with \r; only the final state of the line matters.
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line = stripAnsi(content.slice(content.lastIndexOf("\r") + 1)).trimEnd();
    if (line.trim() === "" || WRAPPER_NOISE.test(line)) return;
    const bounded = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
    const indented = /^\s/.test(line);
    if (this.matches.length < this.limit && FAILURE_LINE.test(line)) {
      // An indented failure line usually belongs to the heading above it; keep that context.
      if (indented && this.header && !this.headerShown && this.matches.length + 1 < this.limit) {
        this.matches.push(this.header);
      }
      this.headerShown = true;
      this.matches.push(bounded);
    }
    if (!indented && !FAILURE_LINE.test(line)) {
      this.header = bounded;
      this.headerShown = false;
    }
    this.tail.push(bounded);
    if (this.tail.length > this.limit) this.tail.shift();
  }
}
