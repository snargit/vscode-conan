/**
 * The hints in results for callers without UI (agents, other extensions): what to do next, in words
 * meant for whoever made the call. They name the extension's operations the way that caller reaches
 * them, so an agent can act on a hint without a lookup.
 */

/** How the caller reached the extension, which decides how hints name the operations. */
export type Caller = 'tool' | 'command' | 'script';

export type Operation = 'getStatus' | 'listProfiles' | 'selectProfiles' | 'installDependencies';

/** `installDependencies` as the caller knows it: the conan_installDependencies tool, the conan.installDependencies command, or the script's operation. */
export function operationName(caller: Caller, operation: Operation): string {
  switch (caller) {
    case 'tool': return `conan_${operation}`;
    case 'command': return `the conan.${operation} command`;
    case 'script': return `the script's ${operation}`;
  }
}

export interface StatusFacts {
  readonly hostProfiles: readonly string[];
  readonly upToDate: boolean;
  readonly installing: boolean;
  readonly usesCmakeLayout: boolean;
  /** Why `conan profile list` failed, if it did. */
  readonly profilesError?: string;
}

export function statusHints(facts: StatusFacts, caller: Caller): string[] | undefined {
  const name = (operation: Operation) => operationName(caller, operation);
  const hints: string[] = [];
  if (facts.profilesError) {
    hints.push(`Conan's profiles couldn't be listed: ${facts.profilesError}`);
  }

  if (facts.hostProfiles.length === 0) {
    hints.push('No host profiles are selected, so no dependencies are installed and this extension leaves CMake Tools alone. '
      + `Choose from availableProfiles, run ${name('selectProfiles')} with them, then ${name('installDependencies')}.`);
  } else if (facts.installing) {
    hints.push(`An install is running for this folder, and ${name('installDependencies')} waits for it to finish.`);
  } else if (!facts.upToDate) {
    hints.push("The installed dependencies don't match the conanfile, conan.lock, conandata.yml or the selected profiles, "
      + `or haven't been installed yet. Run ${name('installDependencies')}.`);
  }

  if (!facts.usesCmakeLayout) {
    hints.push(NO_CMAKE_LAYOUT);
  }

  return hints.length > 0 ? hints : undefined;
}

export interface InstallFacts {
  readonly outcome: 'upToDate' | 'installed' | 'partiallyFailed' | 'userPresetsNotOwned';
  readonly profiles: ReadonlyArray<{ readonly profile: string; readonly succeeded: boolean; readonly hasPresets: boolean }>;
  readonly usesCmakeLayout: boolean;
  readonly configurePresets: readonly string[];
  /** The preset CMake Tools was configured with, if any. */
  readonly configuredPreset?: string;
}

export function installHints(facts: InstallFacts, caller: Caller): string[] | undefined {
  const install = operationName(caller, 'installDependencies');
  const hints: string[] = [];
  if (facts.outcome === 'userPresetsNotOwned') {
    hints.push("Nothing was installed: the folder's CMakeUserPresets.json wasn't written by Conan or this extension, so it won't be overwritten. "
      + "It may be someone's own file: ask the user before deleting or renaming it. "
      + `After that, ${install} installs and writes its own.`);
  }

  const failed = facts.profiles.filter(p => !p.succeeded).map(p => p.profile);
  if (failed.length > 0) {
    hints.push(`Conan failed for ${profileList(failed)}: errorOutput has the end of its output, and VS Code's Conan output channel has the full log. `
      + 'Profiles that succeeded have current presets, and a failed one keeps those of its last successful install. '
      + `Fix the cause, then run ${install} again.`);
  }

  const withoutPresets = facts.profiles.filter(p => p.succeeded && !p.hasPresets).map(p => p.profile);
  if (withoutPresets.length > 0) {
    hints.push(`Conan wrote no CMakePresets.json for ${profileList(withoutPresets)}, so CMake Tools has no configure preset for it. `
      + 'The conanfile needs the CMakeToolchain generator, and CMakeDeps for find_package: '
      + 'under [generators] in a conanfile.txt, or in generators of a conanfile.py.');
  }

  if (facts.outcome !== 'userPresetsNotOwned' && facts.configurePresets.length > 0 && !facts.configuredPreset) {
    hints.push("CMake Tools wasn't configured: a conan-* configure preset couldn't be selected in it. "
      + 'Ask the user to choose one with "CMake: Select Configure Preset", then run "CMake: Configure".');
  }

  // Only worth saying when Conan ran: an up-to-date install got its presets some other way.
  if (facts.profiles.length > 0 && !facts.usesCmakeLayout) {
    hints.push(NO_CMAKE_LAYOUT);
  }

  return hints.length > 0 ? hints : undefined;
}

const NO_CMAKE_LAYOUT = "The conanfile doesn't appear to use cmake_layout. Add it (cmake_layout(self) in layout() of a conanfile.py, "
  + 'or cmake_layout under [layout] in a conanfile.txt): this extension names each profile\'s build folder and presets '
  + 'through it, and without it the presets of different profiles have the same names.';

function profileList(profiles: readonly string[]): string {
  return (profiles.length === 1 ? 'profile ' : 'profiles ') + profiles.map(p => `'${p}'`).join(', ');
}
