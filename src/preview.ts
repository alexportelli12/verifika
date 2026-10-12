const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** Cursor-up or erase-line: the tool is redrawing the previous line (progress output). */
// eslint-disable-next-line no-control-regex
const REDRAW = /\u001b\[\d*A|\u001b\[2K/;
/** Markers test runners and compilers print for the failure itself. Case-sensitive on purpose. */
const DEFINITE_FAILURE =
  /\bFAILED\b|^\s*FAIL\b|\bAssertionError\b|^\s*Expected\b|\berror TS\d+|\[ERROR\]|^\s*[✗✖×]|\bTraceback\b|\bpanicked\b/;
/** Exception lines; passing tests that exercise error paths print these too. */
const EXCEPTION = /\b\w*Error:/;
/** Lines that often relate to a failure but also appear in passing output. */
const WEAK_FAILURE =
  /\berror\b|\bfail(?:ed|ure|s)?\b|\bexception\b|\bassert(?:ion)?\b|\bcannot\b|\bnot found\b|[✗✖×]/i;
/** Counters that progress reporters rewrite as they go. */
const PROGRESS = /\b\d+\s*(?:of|\/)\s*\d+\b|\d+(?:\.\d+)?%/;
/** Structured log lines: an "error" key or level inside JSON is rarely the failure itself. */
const JSON_LINE = /^\s*[[{]"/;
/** Package-manager wrapper noise that repeats the exit code without saying what failed. */
const WRAPPER_NOISE =
  /^(?:npm (?:error|ERR!|warn|notice)|\s*ELIFECYCLE\b|error Command failed with exit code|info Visit https:\/\/yarnpkg)/;
const MAX_LINE_CHARS = 200;
/** Partial lines are truncated beyond this, so one giant line cannot grow memory. */
const MAX_PENDING_CHARS = 4_096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

interface Entry {
  seq: number;
  text: string;
  /** For progress lines: the line's shape up to its counter; later updates replace earlier ones. */
  progressKey: string | null;
}

/**
 * Keeps a bounded excerpt of command output for failure previews. In order of
 * preference it returns lines that clearly mark a failure (FAIL/FAILED,
 * assertion and compiler errors) with the line after each, then exception lines
 * (`TypeError: ...`), then lines that merely mention errors, then the last lines
 * of output.
 *
 * Progress output is collapsed: terminal redraws and progress counters rewritten
 * on new lines replace the previous line. Memory use is O(limit) regardless of
 * how much the command prints.
 */
export class OutputCapture {
  private readonly limit: number;
  private readonly pending = new Map<unknown, string>();
  private readonly definite: Entry[] = [];
  private readonly exceptions: Entry[] = [];
  private readonly weak: Entry[] = [];
  private readonly tail: Entry[] = [];
  private seq = 0;
  private lastShape: string | null = null;
  /** Most recent unindented, non-matching line, e.g. the file name ESLint prints above its errors. */
  private header: Entry | null = null;
  private headerShown = false;
  /** Whether the next indented line continues a failure marker (e.g. the message under a FAILED test). */
  private continueDefinite = false;

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
    const chosen = [this.definite, this.exceptions, this.weak].find((list) => list.length > 0);
    return (chosen ?? this.tail).map((entry) => entry.text);
  }

  private addLine(raw: string): void {
    // Progress bars redraw with \r; only the final state of the line matters.
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const redraw = REDRAW.test(content);
    const line = stripAnsi(content.slice(content.lastIndexOf("\r") + 1)).trimEnd();
    if (line.trim() === "" || WRAPPER_NOISE.test(line)) return;
    const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;

    // Progress counters ("Executed 12 of 756", "40%") rewritten on new lines are one line;
    // a final progress line often adds a suffix ("… (16.5 secs)").
    const shape = line.replace(/\d+/g, "#");
    const sameProgressLine =
      this.lastShape !== null && PROGRESS.test(line) && shape.startsWith(this.lastShape);
    if (redraw || sameProgressLine) this.replacePrevious();
    else this.seq++;
    this.lastShape = shape;
    const counter = PROGRESS.exec(shape.replace(/#/g, "0"));
    const progressKey = counter ? shape.slice(0, counter.index + counter[0].length) : null;
    const entry: Entry = { seq: this.seq, text, progressKey };

    const indented = /^\s/.test(line);
    const isJson = JSON_LINE.test(line);
    const definite = !isJson && DEFINITE_FAILURE.test(line);
    const exception = !isJson && !definite && EXCEPTION.test(line);
    const weak = !isJson && !definite && !exception && WEAK_FAILURE.test(line);

    if (definite || (this.continueDefinite && indented && !/^\s*at\s/.test(line))) {
      push(this.definite, entry, this.limit, false);
      this.continueDefinite = definite;
    } else {
      this.continueDefinite = false;
      if (exception) push(this.exceptions, entry, this.limit, false);
      else if (weak) this.pushWithHeader(this.weak, entry, indented);
    }
    if (!indented && !definite && !exception && !weak && !isJson) {
      this.header = entry;
      this.headerShown = false;
    }
    push(this.tail, entry, this.limit, true);
  }

  /** An indented failure usually belongs to the heading above it; keep that context once. */
  private pushWithHeader(list: Entry[], entry: Entry, indented: boolean): void {
    if (indented && this.header && !this.headerShown && list.length + 2 <= this.limit) {
      push(list, this.header, this.limit, false);
    }
    this.headerShown = true;
    push(list, entry, this.limit, false);
  }

  private replacePrevious(): void {
    for (const list of [this.definite, this.exceptions, this.weak, this.tail]) {
      if (list.at(-1)?.seq === this.seq) list.pop();
    }
    if (this.header?.seq === this.seq) this.header = null;
  }
}

/** Appends within `limit`, either dropping the oldest entry (tail) or ignoring the new one. */
function push(list: Entry[], entry: Entry, limit: number, rolling: boolean): void {
  // A newer state of the same progress line supersedes the old one, even with output in between.
  const previous = entry.progressKey
    ? list.findIndex((item) => item.progressKey === entry.progressKey)
    : -1;
  if (previous !== -1) list.splice(previous, 1);
  if (list.length < limit) list.push(entry);
  else if (rolling) {
    list.shift();
    list.push(entry);
  }
}
