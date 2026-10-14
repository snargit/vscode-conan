import * as path from 'node:path';
import * as vscode from 'vscode';
import { configureWithConanPreset, ensureCMakeToolsWaitsForConan } from './cmakeTools';
import { ConanCli } from './core/conanCli';
import { ConanProject, findConanProject, isConanCMakeProject } from './core/conanProject';
import { isUpToDate, SyncResult, syncDependencies } from './core/dependencySync';
import { defaultFolderState, FolderState, FolderStateStore } from './core/settings';
import { pickProfiles } from './profilePicker';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Conan');
  const controller = new ConanController(new WorkspaceStateStore(context.workspaceState), output);

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('conan.installDependencies', () => controller.installDependencies()),
    vscode.commands.registerCommand('conan.selectProfiles', () => controller.selectProfiles()),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      void controller.updateContext();
      event.added.forEach(folder => void controller.onFolderOpened(folder));
    }),
  );

  void controller.updateContext();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void controller.onFolderOpened(folder);
  }
}

export function deactivate(): void {}

/** Per-folder state in VS Code's workspace storage: per user, never written into the project. */
class WorkspaceStateStore implements FolderStateStore {
  constructor(private readonly memento: vscode.Memento) {}

  load(folder: string): FolderState {
    return { ...defaultFolderState(), ...this.memento.get<Partial<FolderState>>(this.key(folder)) };
  }

  async save(folder: string, state: FolderState): Promise<void> {
    await this.memento.update(this.key(folder), state);
  }

  private key(folder: string): string {
    return `vscode-conan.folder:${path.resolve(folder)}`;
  }
}

const CHOOSE_PROFILES = 'Choose Profiles...';
const NOT_NOW = 'Not now';

/**
 * Keeps each managed folder's Conan dependencies installed ahead of CMake Tools, and implements
 * the commands. CMake Tools does the configure and build from the CMakeUserPresets.json written here.
 */
class ConanController {
  private readonly busy = new Set<string>();

  constructor(private readonly store: FolderStateStore, private readonly output: vscode.OutputChannel) {}

  async updateContext(): Promise<void> {
    const any = (vscode.workspace.workspaceFolders ?? []).some(folder => isConanCMakeProject(folder.uri.fsPath));
    await vscode.commands.executeCommand('setContext', 'conan.hasConanCMakeProject', any);
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

  async installDependencies(): Promise<void> {
    try {
      const folder = await this.pickManagedFolder();
      const project = folder && findConanProject(folder.uri.fsPath);
      if (!folder || !project) {
        return;
      }

      if (this.store.load(project.rootDirectory).hostProfiles.length === 0 && !await this.promptForProfiles(folder, project)) {
        return;
      }

      await this.sync(folder, project, true);
    } catch (error) {
      this.reportError(error);
    }
  }

  async selectProfiles(): Promise<void> {
    try {
      const folder = await this.pickManagedFolder();
      const project = folder && findConanProject(folder.uri.fsPath);
      if (folder && project && await this.promptForProfiles(folder, project)) {
        // The fingerprint includes the profiles, so this installs only if the selection changed.
        await this.sync(folder, project, false);
      }
    } catch (error) {
      this.reportError(error);
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

    const state = this.store.load(project.rootDirectory);
    state.firstRunPromptShown = true;
    await this.store.save(project.rootDirectory, state);

    if (choice !== CHOOSE_PROFILES || !await this.promptForProfiles(folder, project)) {
      this.output.appendLine(`Conan dependencies for '${folder.name}' weren't installed. `
        + 'To set them up later, run "Conan: Select Profiles..." from the Command Palette.');
      return;
    }

    await this.sync(folder, project, false);
  }

  /** Lets the user pick profiles; saves them and makes CMake Tools wait for Conan. False if cancelled. */
  private async promptForProfiles(folder: vscode.WorkspaceFolder, project: ConanProject): Promise<boolean> {
    const profiles = await this.cli(folder).listProfiles();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage("No Conan profiles found. Create one with 'conan profile detect'.");
      return false;
    }

    const current = this.store.load(project.rootDirectory);
    const choice = await pickProfiles(profiles, current, folder.name);
    if (!choice) {
      return false;
    }

    await this.store.save(project.rootDirectory, { ...current, ...choice });

    const changed = await ensureCMakeToolsWaitsForConan(folder);
    if (changed.length > 0) {
      this.output.appendLine(`Set ${changed.join(' and ')} in ${folder.name}/.vscode/settings.json so that `
        + 'CMake Tools waits for Conan before configuring. This extension runs the configure instead.');
    }

    return true;
  }

  private async sync(folder: vscode.WorkspaceFolder, project: ConanProject, force: boolean): Promise<void> {
    const directory = project.rootDirectory;
    if (this.busy.has(directory)) {
      this.output.appendLine(`A Conan install is already running for '${folder.name}'.`);
      return;
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
            return syncDependencies(project, this.store, this.cli(folder), {
              force,
              onLine: line => this.output.appendLine(line),
              signal: abort.signal,
            });
          });
        this.reportResult(folder, result);
      }

      if (result.outcome !== 'userPresetsNotOwned') {
        await configureWithConanPreset(result.configurePresetNames, line => this.output.appendLine(line));
      }
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
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => isConanCMakeProject(folder.uri.fsPath));
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

  private cli(folder: vscode.WorkspaceFolder): ConanCli {
    return new ConanCli(vscode.workspace.getConfiguration('conan', folder.uri).get<string>('executable') || 'conan');
  }

  private reportError(error: unknown): void {
    if (error instanceof Error && error.name === 'AbortError') {
      this.output.appendLine('Conan install cancelled.');
      return;
    }

    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = code === 'ENOENT'
      ? "Couldn't run Conan. Install Conan 2, or set 'conan.executable' to its full path."
      : `Conan: ${error instanceof Error ? error.message : String(error)}`;
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }
}
