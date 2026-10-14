// Runs out/hostTest/index.js inside the installed VS Code, with a throwaway user data directory and
// a scratch copy of samples/hello-app as the workspace. CMake Tools is loaded from your normal
// extensions directory. Usage: npm run test:host
//
// The VS Code executable is run directly (like @vscode/test-electron): the 'code' launcher detaches,
// so it would return before the tests finish. Set VSCODE_EXECUTABLE to override the one found from
// the 'code' launcher on PATH.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-conan-host-'));
const workspace = path.join(scratch, 'hello-app');
fs.cpSync(path.join(repo, 'samples', 'hello-app'), workspace, {
  recursive: true,
  filter: source => !/[\\/](build|\.vscode)([\\/]|$)|CMakeUserPresets\.json$/.test(source),
});

const logFile = path.join(scratch, 'host-test.log');
const extensionsDir = process.env.VSCODE_EXTENSIONS ?? path.join(os.homedir(), '.vscode', 'extensions');
const result = spawnSync(findVSCode(), [
  '--new-window',
  '--disable-workspace-trust',
  `--user-data-dir=${path.join(scratch, 'user-data')}`,
  `--extensions-dir=${extensionsDir}`,
  `--extensionDevelopmentPath=${repo}`,
  `--extensionTestsPath=${path.join(repo, 'out', 'hostTest', 'index.js')}`,
  workspace,
], {
  // VS Code's own console output isn't needed (results come from the log file) and mustn't be shown:
  // extensions' debug logging, e.g. CMake Tools', can include the full environment, secrets and all.
  stdio: 'ignore',
  env: { ...process.env, VSCODE_CONAN_HOST_TEST_LOG: logFile },
});

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
process.stdout.write(log || `No test output (code exited with ${result.status}).\n`);
const passed = log.includes('[host-test] passed');

// Best effort: VS Code can keep files in the user data directory open for a moment after exiting.
try {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch {
  console.warn(`Couldn't remove ${scratch}; delete it later.`);
}
process.exit(passed ? 0 : 1);

function findVSCode() {
  if (process.env.VSCODE_EXECUTABLE) {
    return process.env.VSCODE_EXECUTABLE;
  }

  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  const launcher = which.stdout.split(/\r?\n/).find(line => line.trim().length > 0);
  if (!launcher) {
    throw new Error("Couldn't find VS Code: put 'code' on PATH or set VSCODE_EXECUTABLE.");
  }

  // The launcher lives in <install>/bin (Windows, Linux) or <app>/Contents/Resources/app/bin (macOS).
  const install = path.dirname(path.dirname(fs.realpathSync(launcher.trim())));
  const candidates = {
    win32: [path.join(install, 'Code.exe')],
    darwin: [path.join(install, '..', '..', 'MacOS', 'Electron'), path.join(install, '..', '..', 'MacOS', 'Code')],
    linux: [path.join(install, 'code')],
  }[process.platform] ?? [];
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(`Couldn't find the VS Code executable next to ${launcher}; set VSCODE_EXECUTABLE.`);
  }
  return executable;
}
