import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONAN_INPUT_FILES } from './core/fingerprint';

// A burst of saves (or a tool rewriting several files) is treated as one change.
const DEBOUNCE_MS = 2000;

/** What changed, for the user-facing message (e.g. "conanfile.txt changed"). */
export type ChangeHandler = (folder: vscode.WorkspaceFolder, reasons: string[]) => Promise<void>;

/**
 * Watches each managed folder's Conan inputs: the conanfile, conan.lock, conandata.yml and .conanrc
 * in the folder, plus the profiles in the folder's Conan home. A change only means "check": the
 * handler compares fingerprints, so saves that don't change anything are ignored there.
 */
export class ChangeWatcher implements vscode.Disposable {
  private readonly folders = new Map<string, FolderWatch>();

  constructor(
    private readonly onChange: ChangeHandler,
    /** Resolves the folder's Conan home ('conan config home' run in the folder), or undefined. */
    private readonly conanHome: (folder: vscode.WorkspaceFolder) => Promise<string | undefined>,
  ) {}

  async watch(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.folders.has(key)) {
      return;
    }

    const watch = new FolderWatch(folder, this.onChange, this.conanHome);
    this.folders.set(key, watch);
    await watch.start();
  }

  unwatch(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    this.folders.get(key)?.dispose();
    this.folders.delete(key);
  }

  dispose(): void {
    this.folders.forEach(watch => watch.dispose());
    this.folders.clear();
  }
}

class FolderWatch implements vscode.Disposable {
  private readonly inputs: vscode.FileSystemWatcher;
  private profiles?: vscode.FileSystemWatcher;
  private profilesFolder?: string;
  private timer?: NodeJS.Timeout;
  private readonly reasons = new Set<string>();
  private disposed = false;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly onChange: ChangeHandler,
    private readonly conanHome: (folder: vscode.WorkspaceFolder) => Promise<string | undefined>,
  ) {
    const names = [...CONAN_INPUT_FILES, '.conanrc'];
    this.inputs = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `{${names.join(',')}}`));
    const onInput = (uri: vscode.Uri) => {
      const name = path.basename(uri.fsPath);
      if (name === '.conanrc') {
        // The Conan home (and so the profiles to watch) may have moved.
        void this.watchProfiles();
      }
      this.schedule(`${name} changed`);
    };
    this.inputs.onDidChange(onInput);
    this.inputs.onDidCreate(onInput);
    this.inputs.onDidDelete(onInput);
  }

  async start(): Promise<void> {
    await this.watchProfiles();
  }

  /** (Re)creates the watcher on <Conan home>/profiles, following the folder's current Conan home. */
  private async watchProfiles(): Promise<void> {
    const home = await this.conanHome(this.folder);
    const profilesFolder = home ? path.join(home, 'profiles') : undefined;
    if (this.disposed || profilesFolder === this.profilesFolder) {
      return;
    }

    this.profiles?.dispose();
    this.profiles = undefined;
    this.profilesFolder = profilesFolder;
    if (!profilesFolder) {
      return;
    }

    this.profiles = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(profilesFolder), '**/*'));
    const onProfile = (uri: vscode.Uri) => {
      const name = path.relative(profilesFolder, uri.fsPath).split(path.sep).join('/');
      this.schedule(`Conan profile '${name}' changed`);
    };
    this.profiles.onDidChange(onProfile);
    this.profiles.onDidCreate(onProfile);
    this.profiles.onDidDelete(onProfile);
  }

  private schedule(reason: string): void {
    this.reasons.add(reason);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const reasons = [...this.reasons];
      this.reasons.clear();
      if (!this.disposed) {
        void this.onChange(this.folder, reasons);
      }
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.inputs.dispose();
    this.profiles?.dispose();
  }
}
