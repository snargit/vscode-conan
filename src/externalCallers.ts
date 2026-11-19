import * as vscode from 'vscode';
import { ConanController, ConanRequestError, describeError } from './controller';
import { isConanCMakeProject } from './core/conanProject';
import { EndpointRequest, ExternalEndpoint } from './core/externalEndpoint';

const SETTING = 'allowExternalCallers';

/**
 * Lets agents outside VS Code's chat (Claude Code, Codex and the like, in a terminal) run the same
 * operations as the agent tools, through skills/vscode-conan/scripts/vscode-conan.mjs. While
 * conan.allowExternalCallers is on, this window listens on a local endpoint and advertises its Conan
 * CMake folders (see core/externalEndpoint.ts).
 */
export class ExternalCallers implements vscode.Disposable {
  private endpoint: ExternalEndpoint | undefined;
  /** Refreshes run one at a time, so the endpoint is started once. */
  private refreshing: Promise<void> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly controller: ConanController, private readonly output: vscode.OutputChannel) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`conan.${SETTING}`)) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    ];
    void this.refresh();
  }

  /** Starts or stops the endpoint to match the setting, and advertises the current Conan folders. */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.update());
    return this.refreshing;
  }

  private async update(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .map(folder => folder.uri)
      .filter(uri => uri.scheme === 'file' && isConanCMakeProject(uri.fsPath))
      .map(uri => uri.fsPath);
    const allowed = vscode.workspace.getConfiguration('conan').get<boolean>(SETTING, true);
    try {
      if (!allowed || folders.length === 0) {
        this.endpoint?.dispose();
        this.endpoint = undefined;
        return;
      }

      this.endpoint ??= await ExternalEndpoint.start(request => this.handle(request), describeError);
      this.endpoint.setFolders(folders);
    } catch (error) {
      this.output.appendLine(`Couldn't open the endpoint for agents outside VS Code: ${describeError(error)}`);
    }
  }

  private async handle(request: EndpointRequest): Promise<unknown> {
    const args = request.arguments;
    const folderSpec = typeof args.folder === 'string' ? args.folder : undefined;
    const folder = request.operation === 'listProfiles' && !folderSpec ? undefined : this.controller.resolveFolder(folderSpec);
    this.output.appendLine(`Request from outside VS Code: ${request.operation}${folder ? ` for '${folder.name}'` : ''}.`);

    switch (request.operation) {
      case 'getStatus':
        return this.controller.getStatus(folder!, 'script');
      case 'listProfiles':
        return { profiles: await this.controller.listProfiles(folder) };
      case 'selectProfiles': {
        const hosts = args.hostProfiles;
        if (!Array.isArray(hosts) || !hosts.every(host => typeof host === 'string')) {
          throw new ConanRequestError('selectProfiles needs hostProfiles, a list of profile names.');
        }
        const build = typeof args.buildProfile === 'string' ? args.buildProfile : undefined;
        return this.controller.setProfiles(folder!, hosts, build, 'script');
      }
      case 'installDependencies':
        return this.controller.install(folder!, args.force === true, undefined, 'script');
      default:
        throw new ConanRequestError(`Unknown operation '${request.operation}'. Operations: getStatus, listProfiles, selectProfiles, installDependencies.`);
    }
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.endpoint?.dispose();
    this.endpoint = undefined;
  }
}
