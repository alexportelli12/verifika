import picomatch from "picomatch";

export type Matcher = (file: string) => boolean;

/**
 * Compiles glob patterns into one predicate. Matching is always POSIX-style and
 * case-sensitive, regardless of the host OS, so a config selects the same checks
 * everywhere. Dotfiles match like any other file.
 */
export function compileGlobs(patterns: readonly string[]): Matcher {
  if (patterns.length === 0) return () => false;
  return picomatch([...patterns], { dot: true, windows: false, nocase: false });
}
