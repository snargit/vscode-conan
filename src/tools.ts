import * as vscode from 'vscode';
import { ConanController, describeError } from './controller';

interface FolderInput {
  /** Workspace folder path or name. Optional when only one Conan CMake project is open. */
  folder?: string;
}

interface SelectProfilesInput extends FolderInput {
  hostProfiles: string[];
  buildProfile?: string;
}

interface InstallInput extends FolderInput {
  force?: boolean;
}

/**
 * Language model tools, so agents (e.g. Copilot agent mode) can drive the same workflow as the
 * commands. The two tools with side effects ask the user to confirm first. Names and input schemas
 * must match `contributes.languageModelTools` in package.json.
 */
export function registerTools(controller: ConanController): vscode.Disposable[] {
  return [
    vscode.lm.registerTool<FolderInput>('conan_getStatus', {
      invoke: options => run(() => controller.getStatus(controller.resolveFolder(options.input.folder))),
    }),

    vscode.lm.registerTool<FolderInput>('conan_listProfiles', {
      invoke: (_options, token) => run(async () => ({ profiles: await controller.listProfiles(undefined, abortSignal(token)) })),
    }),

    vscode.lm.registerTool<SelectProfilesInput>('conan_selectProfiles', {
      prepareInvocation: options => {
        const { hostProfiles, buildProfile } = options.input;
        const build = buildProfile ? `\`${buildProfile}\`` : 'the current build profile';
        return {
          invocationMessage: 'Selecting Conan profiles',
          confirmationMessages: {
            title: 'Select Conan profiles?',
            message: new vscode.MarkdownString(
              `Install dependencies for host profile(s) ${hostProfiles.map(p => `\`${p}\``).join(', ')} with ${build}`
              + `${options.input.folder ? ` in \`${options.input.folder}\`` : ''}.\n\n`
              + 'The first time, this also sets `cmake.configureOnOpen` and `cmake.useCMakePresets` in the '
              + "folder's `.vscode/settings.json` so CMake Tools waits for Conan. Nothing is installed yet."),
          },
        };
      },
      invoke: options => run(() => controller.setProfiles(
        controller.resolveFolder(options.input.folder), options.input.hostProfiles, options.input.buildProfile)),
    }),

    vscode.lm.registerTool<InstallInput>('conan_installDependencies', {
      prepareInvocation: options => ({
        invocationMessage: 'Installing Conan dependencies',
        confirmationMessages: {
          title: 'Install Conan dependencies?',
          message: new vscode.MarkdownString(
            `Run \`conan install\` for each selected profile${options.input.folder ? ` in \`${options.input.folder}\`` : ''}, `
            + 'then configure with CMake Tools. Packages missing from the Conan cache are built from source, which can take a while.'
            + (options.input.force ? '' : ' Skipped if nothing has changed since the last install.')),
        },
      }),
      invoke: (options, token) => run(() =>
        controller.install(controller.resolveFolder(options.input.folder), options.input.force ?? false, token)),
    }),
  ];
}

/** Runs a tool body, returning its result (or failure) as JSON text for the model. */
async function run(body: () => unknown): Promise<vscode.LanguageModelToolResult> {
  let payload: unknown;
  try {
    payload = await body();
  } catch (error) {
    payload = { error: describeError(error) };
  }

  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))]);
}

function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const abort = new AbortController();
  token.onCancellationRequested(() => abort.abort());
  return abort.signal;
}
