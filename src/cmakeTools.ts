import * as vscode from 'vscode';

/**
 * CMake Tools settings that make it wait for Conan. They're written to the folder's
 * .vscode/settings.json, so they're in force from the moment the folder next opens.
 */
const WAIT_FOR_CONAN_SETTINGS: ReadonlyArray<readonly [key: string, value: unknown]> = [
  // Don't configure when the folder opens; this extension configures once Conan has run.
  ['configureOnOpen', false],
  // Use presets even though CMakeUserPresets.json may not exist yet when the folder opens:
  // with the default "auto", CMake Tools decides at open time and would fall back to kits.
  ['useCMakePresets', 'always'],
];

/**
 * Makes CMake Tools wait for Conan in `folder`.
 * @returns the settings that had to be changed, for telling the user.
 */
export async function ensureCMakeToolsWaitsForConan(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('cmake', folder.uri);
  const changed: string[] = [];
  for (const [key, value] of WAIT_FOR_CONAN_SETTINGS) {
    if (config.inspect(key)?.workspaceFolderValue !== value) {
      await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      changed.push(`cmake.${key}`);
    }
  }

  return changed;
}

/**
 * Selects one of the Conan configure presets in CMake Tools, unless one already is, then
 * configures. Uses CMake Tools' commands, so it acts on CMake Tools' active folder.
 */
export async function configureWithConanPreset(presetNames: readonly string[], log: (line: string) => void): Promise<void> {
  if (presetNames.length === 0) {
    return;
  }

  const active = await activeConfigurePreset();
  if (active === undefined || !presetNames.includes(active)) {
    const target = presetNames[0];
    if (!await trySelectConfigurePreset(target)) {
      log(`Couldn't select the '${target}' configure preset in CMake Tools. `
        + 'Choose one with "CMake: Select Configure Preset", then run "CMake: Configure".');
      return;
    }
  }

  await vscode.commands.executeCommand('cmake.configure');
}

/**
 * CMake Tools reloads presets asynchronously after CMakeUserPresets.json changes, and selecting a
 * preset it hasn't loaded yet just clears the selection. So retry until the selection sticks.
 */
async function trySelectConfigurePreset(name: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await vscode.commands.executeCommand('cmake.setConfigurePreset', name);
    if (await activeConfigurePreset() === name) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return false;
}

async function activeConfigurePreset(): Promise<string | undefined> {
  const name = await vscode.commands.executeCommand<string | undefined>('cmake.activeConfigurePresetName');
  return name ? name : undefined;
}
