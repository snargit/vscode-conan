// Smoke test that runs inside a VS Code extension host (see scripts/host-test.mjs). It drives the
// extension the way another extension or an agent would: through the tools and the commands'
// argument forms, with no UI. Expects the workspace to be a fresh copy of samples/hello-app, with
// greeting/0.1 exported to the Conan cache and a 'default' profile.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const TOOLS = ['conan_getStatus', 'conan_listProfiles', 'conan_selectProfiles', 'conan_installDependencies'];

// The 'code' launcher doesn't forward the extension host's console, so progress also goes to a log file.
const LOG = process.env.VSCODE_CONAN_HOST_TEST_LOG;
const log = (line: string) => {
  console.log(line);
  if (LOG) {
    fs.appendFileSync(LOG, line + '\n');
  }
};

export async function run(): Promise<void> {
  try {
    await runSteps();
  } catch (error) {
    log(`[host-test] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw error;
  }
}

async function runSteps(): Promise<void> {
  const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-conan');
  assert.ok(extension, 'extension not loaded');
  await extension.activate();
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const step = (name: string) => log(`[host-test] ${name}`);

  step('tools are registered');
  const registered = vscode.lm.tools.map(tool => tool.name);
  for (const name of TOOLS) {
    assert.ok(registered.includes(name), `${name} missing from vscode.lm.tools`);
  }

  step('conan_listProfiles tool');
  const profiles = await invokeReadOnlyTool('conan_listProfiles', {}) as { profiles: string[] };
  assert.ok(profiles.profiles.includes('default'), JSON.stringify(profiles));

  step('conan_getStatus tool on a fresh folder');
  const before = await invokeReadOnlyTool('conan_getStatus', {}) as Record<string, unknown>;
  assert.deepEqual(before.hostProfiles, []);
  assert.equal(before.upToDate, false);

  step('conan.selectProfiles rejects unknown profiles');
  await assert.rejects(
    Promise.resolve(vscode.commands.executeCommand('conan.selectProfiles', { hostProfiles: ['no-such-profile'] })),
    /Unknown Conan profile\(s\): no-such-profile/);

  step('conan.installDependencies needs profiles first');
  await assert.rejects(
    Promise.resolve(vscode.commands.executeCommand('conan.installDependencies', {})),
    /No Conan profiles are selected/);

  step('conan.selectProfiles with arguments');
  const selected = await vscode.commands.executeCommand<Record<string, unknown>>('conan.selectProfiles', { hostProfiles: ['default'], folder });
  assert.deepEqual(selected.hostProfiles, ['default']);
  const settings = JSON.parse(fs.readFileSync(path.join(folder, '.vscode', 'settings.json'), 'utf8'));
  assert.equal(settings['cmake.configureOnOpen'], false);
  assert.equal(settings['cmake.useCMakePresets'], 'always');

  step('conan.installDependencies with arguments');
  const report = await vscode.commands.executeCommand<Record<string, unknown>>('conan.installDependencies', {});
  log(`[host-test] install report: ${JSON.stringify(report)}`);
  assert.equal(report.outcome, 'installed');
  assert.deepEqual(report.configurePresets, ['conan-default-release']);

  step('conan_getStatus tool after the install');
  const after = await invokeReadOnlyTool('conan_getStatus', { folder: path.basename(folder) }) as Record<string, unknown>;
  assert.equal(after.upToDate, true);
  assert.deepEqual(after.configurePresets, ['conan-default-release']);

  step('a conanfile edit is noticed and, with conan.autoInstallOnChange, reinstalled');
  await vscode.workspace.getConfiguration('conan').update('autoInstallOnChange', true, vscode.ConfigurationTarget.Global);
  fs.appendFileSync(path.join(folder, 'conanfile.txt'), '\n# edited by the host test\n');
  const stale = await vscode.commands.executeCommand<Record<string, unknown>>('conan.getStatus', {});
  assert.equal(stale.upToDate, false, 'the edit should make the install out of date');
  // The watcher waits for changes to settle, then reinstalls; the status turns up to date again.
  let reinstalled = false;
  for (let attempt = 0; attempt < 60 && !reinstalled; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    reinstalled = (await vscode.commands.executeCommand<Record<string, unknown>>('conan.getStatus', {})).upToDate === true;
  }
  assert.ok(reinstalled, 'no reinstall within 60 seconds of the conanfile edit');

  step('conan_getStatus tool reports a bad folder as an error result');
  const bad = await invokeReadOnlyTool('conan_getStatus', { folder: 'not-a-folder' }) as { error?: string };
  assert.match(bad.error ?? '', /isn't an open workspace folder/);

  step('passed');
}

/** Tools without confirmation messages can be invoked outside a chat without any UI. */
async function invokeReadOnlyTool(name: string, input: object): Promise<unknown> {
  const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
  const text = result.content.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');
  return JSON.parse(text);
}
