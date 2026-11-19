/**
 * The last lines of a process's output, kept as it streams, so a failure can be reported with
 * Conan's own error message without holding the whole log.
 */
export class OutputTail {
  private readonly lines: string[] = [];

  constructor(private readonly maxLines = 20, private readonly maxCharacters = 4000) {}

  /** Adds a line; blank lines are skipped. */
  add(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    this.lines.push(line.trimEnd());
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }

  /** The kept lines, newest last, cut from the start to the character limit; undefined if there are none. */
  text(): string | undefined {
    if (this.lines.length === 0) {
      return undefined;
    }

    const text = this.lines.join('\n');
    if (text.length <= this.maxCharacters) {
      return text;
    }

    // Keep the end, where Conan prints the error, starting at a line boundary if there is one.
    const cut = text.slice(text.length - this.maxCharacters);
    const newline = cut.indexOf('\n');
    return newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
  }
}
