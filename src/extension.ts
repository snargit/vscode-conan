import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConanController, describeError } from './controller';
import { defaultFolderState, FolderState, FolderStateStore } from './core/settings';
import { registerTools } from './tools';

/** Optional argument for the commands, for other extensions, tasks, keybindings and agents. */
interface CommandArgs {
  /** Workspace folder path or name. Optional when only one Conan CMake project is open. */
  folder?: string;
  force?: boolean;
  hostProfiles?: string[];
  buildProfile?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Conan');
  const controller = new ConanController(new WorkspaceStateStore(context.workspaceState), output);

  context.subscriptions.push(
    output,

    // Without an argument these are the interactive Command Palette commands. With one, they skip
    // all UI and return a result, throwing an Error with a readable message on failure.
    vscode.commands.registerCommand('conan.installDependencies', (args?: CommandArgs) => args
      ? withoutUi(() => controller.install(controller.resolveFolder(args.folder), args.force ?? false))
      : controller.installInteractive()),
    vscode.commands.registerCommand('conan.selectProfiles', (args?: CommandArgs) => args?.hostProfiles
      ? withoutUi(() => controller.setProfiles(controller.resolveFolder(args.folder), args.hostProfiles!, args.buildProfile))
      : controller.selectProfilesInteractive()),
    vscode.commands.registerCommand('conan.getStatus', (args?: CommandArgs) =>
      withoutUi(async () => controller.getStatus(controller.resolveFolder(args?.folder)))),
    vscode.commands.registerCommand('conan.listProfiles', (args?: CommandArgs) =>
      withoutUi(() => controller.listProfiles(args?.folder ? controller.resolveFolder(args.folder) : undefined))),

    ...registerTools(controller),

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

/** Runs a command's argument form, turning failures into an Error whose message suits the caller. */
async function withoutUi<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw new Error(describeError(error));
  }
}

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
