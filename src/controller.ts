import * as path from 'node:path';
import * as vscode from 'vscode';
import { configureWithConanPreset, ensureCMakeToolsWaitsForConan } from './cmakeTools';
import { ConanCli } from './core/conanCli';
import { ConanProject, findConanProject, isConanCMakeProject } from './core/conanProject';
import { currentConfigurePresetNames, isUpToDate, SyncResult, syncDependencies } from './core/dependencySync';
import { ProfileChoice, validateProfileChoice } from './core/profileChoice';
import { FolderStateStore } from './core/settings';
import { pickProfiles } from './profilePicker';

/** A problem with a request made without UI (command argument or agent tool); the message is for the caller. */
export class ConanRequestError extends Error {
  override readonly name = 'ConanRequestError';
}

/** Everything a caller needs to decide what to do next with a folder. */
export interface ConanStatus {
  readonly folder: string;
  readonly folderName: string;
  readonly conanfile: string;
  readonly usesCmakeLayout: boolean;
  /** Host profiles selected for install; empty until profiles are chosen. */
  readonly hostProfiles: readonly string[];
  readonly buildProfile: string;
  /** True if the last install still matches the conanfile, conan.lock and profiles. */
  readonly upToDate: boolean;
  /** conan-* configure presets currently available to CMake Tools. */
  readonly configurePresets: readonly string[];
}

export interface InstallReport {
  readonly folder: string;
  readonly outcome: SyncResult['outcome'];
  readonly profiles: ReadonlyArray<{ profile: string; succeeded: boolean; exitCode: number }>;
  readonly configurePresets: readonly string[];
  /** The preset CMake Tools was configured with, if the configure was started. */
  readonly configuredPreset?: string;
}

const CHOOSE_PROFILES = 'Choose Profiles...';
const NOT_NOW = 'Not now';

/**
 * Keeps each managed folder's Conan dependencies installed ahead of CMake Tools. The public methods
 * without UI (resolveFolder, listProfiles, getStatus, setProfiles, install) back the commands' argument
 * forms and the agent tools; the interactive flows are built on top of them.
 */
export class ConanController {
  private readonly busy = new Set<string>();

  constructor(private readonly store: FolderStateStore, private readonly output: vscode.OutputChannel) {}

  // ---- Operations without UI -------------------------------------------------------------------

  /**
   * The managed workspace folder for `spec`: a workspace folder's path, name or URI. With no spec,
   * the only managed folder.
   */
  resolveFolder(spec?: string | vscode.Uri): vscode.WorkspaceFolder {
    const managed = this.managedFolders();
    if (spec === undefined || spec === '') {
      if (managed.length === 1) {
        return managed[0];
      }
      throw new ConanRequestError(managed.length === 0
        ? 'No Conan CMake project is open. A workspace folder needs a conanfile.py or conanfile.txt and a CMakeLists.txt at its root.'
        : `Several Conan CMake projects are open; specify the folder. Open projects: ${describeFolders(managed)}.`);
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = spec instanceof vscode.Uri
      ? vscode.workspace.getWorkspaceFolder(spec)
      : folders.find(f => f.name === spec || samePath(f.uri.fsPath, spec));
    if (!folder) {
      throw new ConanRequestError(`'${spec}' isn't an open workspace folder. Open Conan CMake projects: ${describeFolders(managed) || '(none)'}.`);
    }
    if (!managed.includes(folder)) {
      throw new ConanRequestError(`'${folder.name}' isn't a Conan CMake project: it needs a conanfile.py or conanfile.txt and a CMakeLists.txt at its root.`);
    }

    return folder;
  }

  async listProfiles(folder?: vscode.WorkspaceFolder, signal?: AbortSignal): Promise<string[]> {
    return this.cli(folder).listProfiles(signal);
  }

  getStatus(folder: vscode.WorkspaceFolder): ConanStatus {
    const project = this.project(folder);
    const state = this.store.load(project.rootDirectory);
    return {
      folder: folder.uri.fsPath,
      folderName: folder.name,
      conanfile: path.basename(project.conanfilePath),
      usesCmakeLayout: project.usesCmakeLayout,
      hostProfiles: state.hostProfiles,
      buildProfile: state.buildProfile,
      upToDate: state.hostProfiles.length > 0 && isUpToDate(project, this.store),
      configurePresets: currentConfigurePresetNames(project.rootDirectory),
    };
  }

  /** Saves a profile choice (validated against `conan profile list`) and makes CMake Tools wait for Conan. Doesn't install. */
  async setProfiles(folder: vscode.WorkspaceFolder, hostProfiles: readonly string[], buildProfile?: string): Promise<ConanStatus> {
    const project = this.project(folder);
    const available = await this.listProfiles(folder);
    const current = this.store.load(project.rootDirectory);
    const validation = validateProfileChoice(available, hostProfiles, buildProfile ?? current.buildProfile);
    if ('error' in validation) {
      throw new ConanRequestError(validation.error);
    }

    await this.saveChoice(folder, project, validation.choice);
    return this.getStatus(folder);
  }

  /** Runs the install for the folder's saved profiles, then configures CMake Tools. */
  async install(folder: vscode.WorkspaceFolder, force: boolean, cancellation?: vscode.CancellationToken): Promise<InstallReport> {
    const project = this.project(folder);
    if (this.store.load(project.rootDirectory).hostProfiles.length === 0) {
      throw new ConanRequestError(`No Conan profiles are selected for '${folder.name}'. Select some first (conan_selectProfiles or "Conan: Select Profiles...").`);
    }

    return this.sync(folder, project, force, cancellation);
  }

  // ---- Interactive flows -----------------------------------------------------------------------

  async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'conan.hasConanCMakeProject', this.managedFolders().length > 0);
  }

  /**
   * Managed folders have CMake Tools' configureOnOpen turned off, so this runs Conan first and then
   * configures. Any other folder is left alone.
   */
  async onFolderOpened(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const project = findConanProject(folder.uri.fsPath);
      if (!project) {
        return;
      }

      const state = this.store.load(project.rootDirectory);
      if (state.hostProfiles.length === 0) {
        if (!state.firstRunPromptShown) {
          await this.runFirstTimeSetup(folder, project);
        }
        return;
      }

      await this.sync(folder, project, false);
    } catch (error) {
      this.reportError(error);
    }
  }

  /** "Conan: Install Dependencies" from the UI: picks the folder and profiles if needed. */
  async installInteractive(): Promise<InstallReport | undefined> {
    try {
      const folder = await this.pickManagedFolder();
      if (!folder) {
        return undefined;
      }

      const project = this.project(folder);
      if (this.store.load(project.rootDirectory).hostProfiles.length === 0 && !await this.promptForProfiles(folder, project)) {
        return undefined;
      }

      return await this.sync(folder, project, true);
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  /** "Conan: Select Profiles..." from the UI: picks profiles, then installs if the selection changed. */
  async selectProfilesInteractive(): Promise<InstallReport | undefined> {
    try {
      const folder = await this.pickManagedFolder();
      if (!folder) {
        return undefined;
      }

      const project = this.project(folder);
      return await this.promptForProfiles(folder, project) ? await this.sync(folder, project, false) : undefined;
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  /**
   * The first time a Conan folder opens, offers to set it up rather than leaving the user to find the
   * commands. Shown once per folder: after "Not now" the folder is left to CMake Tools as usual.
   */
  private async runFirstTimeSetup(folder: vscode.WorkspaceFolder, project: ConanProject): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `'${folder.name}' has a ${path.basename(project.conanfilePath)} and a CMakeLists.txt. `
        + 'Install its Conan dependencies so CMake Tools can configure and build it?',
      CHOOSE_PROFILES,
      NOT_NOW);

    // Profiles may have been chosen meanwhile (e.g. by an agent), in which case there's nothing to do.
    const state = this.store.load(project.rootDirectory);
    state.firstRunPromptShown = true;
    await this.store.save(project.rootDirectory, state);
    if (state.hostProfiles.length > 0) {
      return;
    }

    if (choice !== CHOOSE_PROFILES || !await this.promptForProfiles(folder, project)) {
      this.output.appendLine(`Conan dependencies for '${folder.name}' weren't installed. `
        + 'To set them up later, run "Conan: Select Profiles..." from the Command Palette.');
      return;
    }

    await this.sync(folder, project, false);
  }

  /** Lets the user pick profiles and saves them. False if cancelled. */
  private async promptForProfiles(folder: vscode.WorkspaceFolder, project: ConanProject): Promise<boolean> {
    const profiles = await this.listProfiles(folder);
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage("No Conan profiles found. Create one with 'conan profile detect'.");
      return false;
    }

    const choice = await pickProfiles(profiles, this.store.load(project.rootDirectory), folder.name);
    if (!choice) {
      return false;
    }

    await this.saveChoice(folder, project, choice);
    return true;
  }

  private async saveChoice(folder: vscode.WorkspaceFolder, project: ConanProject, choice: ProfileChoice): Promise<void> {
    const state = this.store.load(project.rootDirectory);
    // Once profiles are chosen, by whatever means, the first-run prompt has nothing left to offer.
    await this.store.save(project.rootDirectory, { ...state, ...choice, firstRunPromptShown: true });

    const changed = await ensureCMakeToolsWaitsForConan(folder);
    if (changed.length > 0) {
      this.output.appendLine(`Set ${changed.join(' and ')} in ${folder.name}/.vscode/settings.json so that `
        + 'CMake Tools waits for Conan before configuring. This extension runs the configure instead.');
    }
  }

  private async sync(
    folder: vscode.WorkspaceFolder,
    project: ConanProject,
    force: boolean,
    cancellation?: vscode.CancellationToken,
  ): Promise<InstallReport> {
    const directory = project.rootDirectory;
    if (this.busy.has(directory)) {
      throw new ConanRequestError(`A Conan install is already running for '${folder.name}'.`);
    }

    this.busy.add(directory);
    try {
      let result: SyncResult;
      if (!force && isUpToDate(project, this.store)) {
        result = await syncDependencies(project, this.store, this.cli(folder), { force, onLine: () => {} });
      } else {
        if (!project.usesCmakeLayout) {
          this.output.appendLine(`Warning: ${project.conanfilePath} doesn't appear to use cmake_layout. `
            + 'Without it, CMake presets for different profiles will have clashing names.');
        }

        this.output.show(true);
        result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Conan: installing dependencies for ${folder.name}`, cancellable: true },
          (_progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            cancellation?.onCancellationRequested(() => abort.abort());
            return syncDependencies(project, this.store, this.cli(folder), {
              force,
              onLine: line => this.output.appendLine(line),
              signal: abort.signal,
            });
          });
        this.reportResult(folder, result);
      }

      const configuredPreset = result.outcome === 'userPresetsNotOwned'
        ? undefined
        : await configureWithConanPreset(result.configurePresetNames, line => this.output.appendLine(line));

      return {
        folder: folder.uri.fsPath,
        outcome: result.outcome,
        profiles: result.profiles.map(p => ({ profile: p.profile, succeeded: p.exitCode === 0, exitCode: p.exitCode })),
        configurePresets: result.configurePresetNames,
        configuredPreset,
      };
    } finally {
      this.busy.delete(directory);
    }
  }

  private reportResult(folder: vscode.WorkspaceFolder, result: SyncResult): void {
    if (result.outcome === 'upToDate' || result.outcome === 'userPresetsNotOwned') {
      return;
    }

    this.output.appendLine('========== Conan install summary ==========');
    for (const profile of result.profiles) {
      this.output.appendLine(profile.exitCode === 0
        ? `  ${profile.profile}: succeeded`
        : `  ${profile.profile}: FAILED (exit code ${profile.exitCode})`);
    }

    const failed = result.profiles.filter(profile => profile.exitCode !== 0).length;
    if (failed > 0) {
      void vscode.window.showErrorMessage(
        `Conan: ${failed} of ${result.profiles.length} profile(s) failed for ${folder.name}. See the Conan output for details.`);
    }
  }

  /** The managed folder to act on: the only one, or the user's pick if there are several. */
  private async pickManagedFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = this.managedFolders();
    if (folders.length <= 1) {
      if (folders.length === 0) {
        void vscode.window.showWarningMessage(
          'No Conan CMake project is open. A folder needs a conanfile.py or conanfile.txt and a CMakeLists.txt at its root.');
      }
      return folders[0];
    }

    const pick = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), {
      placeHolder: 'Choose the Conan project folder',
    });
    return pick?.folder;
  }

  private managedFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => isConanCMakeProject(folder.uri.fsPath));
  }

  private project(folder: vscode.WorkspaceFolder): ConanProject {
    const project = findConanProject(folder.uri.fsPath);
    if (!project) {
      throw new ConanRequestError(`'${folder.name}' isn't a Conan CMake project: it needs a conanfile.py or conanfile.txt and a CMakeLists.txt at its root.`);
    }
    return project;
  }

  private cli(folder?: vscode.WorkspaceFolder): ConanCli {
    return new ConanCli(vscode.workspace.getConfiguration('conan', folder?.uri).get<string>('executable') || 'conan');
  }

  /** Reports a failure from an interactive flow to the user. */
  reportError(error: unknown): void {
    const message = describeError(error);
    this.output.appendLine(message);
    if (!isAbort(error)) {
      void vscode.window.showErrorMessage(message);
    }
  }
}

/** A message for a failure, worded for both people and agents. */
export function describeError(error: unknown): string {
  if (isAbort(error)) {
    return 'Conan install cancelled.';
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return "Couldn't run Conan. Install Conan 2, or set 'conan.executable' to its full path.";
  }
  return error instanceof ConanRequestError ? error.message : `Conan: ${error instanceof Error ? error.message : String(error)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describeFolders(folders: readonly vscode.WorkspaceFolder[]): string {
  return folders.map(folder => `${folder.name} (${folder.uri.fsPath})`).join(', ');
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
