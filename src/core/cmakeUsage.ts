/**
 * What a CMakeLists.txt needs to use a profile's direct dependencies: the names for find_package()
 * and the targets for target_link_libraries(). They come from the summary CMakeDeps (and
 * CMakeConfigDeps) print during an install, so they're the names the recipes really define, which
 * often differ from the package names.
 */
export interface CMakeUsage {
  readonly findPackages: readonly string[];
  readonly targets: readonly string[];
}

const HEADER = 'CMakeDeps necessary find_package() and targets for your CMakeLists.txt';
const FIND_PACKAGE = 'find_package(';
const TARGET_LINK_LIBRARIES = 'target_link_libraries(';
const ESCAPES = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * Picks the CMakeDeps summary out of `conan install`'s log as it streams:
 *
 * ```
 * CMakeDeps necessary find_package() and targets for your CMakeLists.txt
 *     find_package(fmt)
 *     find_package(protobuf) # Optional. This is a tool-require, can't link its targets
 *     target_link_libraries(... fmt::fmt)
 * ```
 *
 * The header may follow a prefix such as `conanfile.py (app/1.0): `.
 */
export class CMakeUsageCollector {
  private readonly packages: string[] = [];
  private readonly targets: string[] = [];
  private inSummary = false;

  add(line: string): void {
    line = line.replace(ESCAPES, '');
    if (line.includes(HEADER)) {
      this.inSummary = true;
      return;
    }

    if (!this.inSummary) {
      return;
    }

    const text = line.trim();
    const close = text.indexOf(')');
    const end = text.lastIndexOf(')');
    if (text.startsWith(FIND_PACKAGE) && close > 0) {
      addDistinct(this.packages, [text.slice(FIND_PACKAGE.length, close).trim()]);
    } else if (text.startsWith(TARGET_LINK_LIBRARIES) && end > 0) {
      addDistinct(this.targets, text.slice(TARGET_LINK_LIBRARIES.length, end).split(/\s+/).filter(name => name !== '...'));
    } else {
      this.inSummary = false;
    }
  }

  /** The names collected, or undefined if the log had no CMakeDeps summary. */
  result(): CMakeUsage | undefined {
    return this.packages.length === 0 && this.targets.length === 0
      ? undefined
      : { findPackages: [...this.packages], targets: [...this.targets] };
  }
}

function addDistinct(list: string[], names: readonly string[]): void {
  for (const name of names) {
    if (name.length > 0 && !list.includes(name)) {
      list.push(name);
    }
  }
}

/** The usage remembered for the given profiles, in their order; undefined if there's none. */
export function cmakeUsageOf(
  remembered: Readonly<Record<string, CMakeUsage>> | undefined,
  profiles: readonly string[],
): Record<string, CMakeUsage> | undefined {
  const usage: Record<string, CMakeUsage> = {};
  for (const profile of profiles) {
    const kept = remembered?.[profile];
    if (kept) {
      usage[profile] = kept;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}
