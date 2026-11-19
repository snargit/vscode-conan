import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CMakeUsage, CMakeUsageCollector, cmakeUsageOf } from '../core/cmakeUsage';
import { ProfileInstallResult } from '../core/conanCli';
import { rememberCMakeUsage } from '../core/dependencySync';
import { endpointsDirectory, EndpointRequest, ExternalEndpoint, PROTOCOL_VERSION, socketPath } from '../core/externalEndpoint';
import { installHints, InstallFacts, operationName, statusHints } from '../core/hints';
import { OutputTail } from '../core/outputTail';
import { TempDirectory } from './helpers';

describe('OutputTail', () => {
  it('keeps the last lines, skipping blank ones', () => {
    const tail = new OutputTail(3);
    ['one', '', 'two', '   ', 'three', 'four  '].forEach(line => tail.add(line));
    assert.equal(tail.text(), 'two\nthree\nfour');
  });

  it('is undefined when nothing was printed', () => {
    assert.equal(new OutputTail().text(), undefined);
  });

  it('keeps the end within the character limit, from a line boundary', () => {
    const tail = new OutputTail(20, 12);
    ['aaaaaaaa', 'bbbbbbbb', 'ERROR: x'].forEach(line => tail.add(line));
    assert.equal(tail.text(), 'ERROR: x');
  });
});

describe('CMakeUsageCollector', () => {
  const summary = [
    'conanfile.txt: Generating aggregated env files',
    '\x1B[32mconanfile.txt: CMakeDeps necessary find_package() and targets for your CMakeLists.txt\x1B[0m',
    '    find_package(fmt)',
    '    find_package(ZLIB)',
    "    find_package(protobuf) # Optional. This is a tool-require, can't link its targets",
    '    target_link_libraries(... fmt::fmt ZLIB::ZLIB)',
    'conanfile.txt: Generating CMakeToolchain',
    '    find_package(notpartofit)',
  ];

  it('reads the find_package names and targets of the summary', () => {
    const collector = new CMakeUsageCollector();
    summary.forEach(line => collector.add(line));
    assert.deepEqual(collector.result(), { findPackages: ['fmt', 'ZLIB', 'protobuf'], targets: ['fmt::fmt', 'ZLIB::ZLIB'] });
  });

  it('is undefined without a summary', () => {
    const collector = new CMakeUsageCollector();
    collector.add('conanfile.txt: Generating CMakeToolchain');
    assert.equal(collector.result(), undefined);
  });

  it('takes each name once', () => {
    const collector = new CMakeUsageCollector();
    [...summary.slice(1, 6), ...summary.slice(1, 6)].forEach(line => collector.add(line));
    assert.deepEqual(collector.result()?.findPackages, ['fmt', 'ZLIB', 'protobuf']);
  });
});

describe('remembering CMake usage', () => {
  const fmt: CMakeUsage = { findPackages: ['fmt'], targets: ['fmt::fmt'] };
  const zlib: CMakeUsage = { findPackages: ['ZLIB'], targets: ['ZLIB::ZLIB'] };
  const result = (profile: string, exitCode: number, cmakeUsage?: CMakeUsage): ProfileInstallResult => ({ profile, exitCode, cmakeUsage });

  it("takes a successful install's usage and keeps a failed one's last", () => {
    const remembered = { a: fmt, b: fmt, c: fmt };
    assert.deepEqual(
      rememberCMakeUsage(remembered, ['a', 'b'], [result('a', 0, zlib), result('b', 1)]),
      { a: zlib, b: fmt });
  });

  it('drops a profile whose successful install reported none', () => {
    assert.equal(rememberCMakeUsage({ a: fmt }, ['a'], [result('a', 0)]), undefined);
  });

  it('reports the selected profiles in order', () => {
    assert.deepEqual(Object.keys(cmakeUsageOf({ a: fmt, b: zlib, c: fmt }, ['b', 'a', 'x'])!), ['b', 'a']);
    assert.equal(cmakeUsageOf(undefined, ['a']), undefined);
  });
});

describe('hints', () => {
  const status = { hostProfiles: ['default'], upToDate: true, installing: false, usesCmakeLayout: true };

  it('name the operations the way the caller reaches them', () => {
    assert.equal(operationName('tool', 'installDependencies'), 'conan_installDependencies');
    assert.equal(operationName('command', 'installDependencies'), 'the conan.installDependencies command');
    assert.equal(operationName('script', 'installDependencies'), "the script's installDependencies");
    const hints = statusHints({ ...status, hostProfiles: [] }, 'tool')!;
    assert.match(hints[0], /run conan_selectProfiles with them, then conan_installDependencies/);
  });

  it('say nothing when the install is current', () => {
    assert.equal(statusHints(status, 'tool'), undefined);
  });

  it('report an install that is running, out of date, or lacks cmake_layout', () => {
    assert.match(statusHints({ ...status, installing: true, upToDate: false }, 'script')![0], /An install is running/);
    assert.match(statusHints({ ...status, upToDate: false }, 'script')![0], /Run the script's installDependencies/);
    assert.match(statusHints({ ...status, usesCmakeLayout: false }, 'tool')![0], /cmake_layout/);
  });

  it('pass on why the profiles could not be listed', () => {
    assert.match(statusHints({ ...status, profilesError: "Couldn't run Conan." }, 'tool')![0], /Couldn't run Conan/);
  });

  const install: InstallFacts = {
    outcome: 'installed',
    profiles: [{ profile: 'default', succeeded: true, hasPresets: true }],
    usesCmakeLayout: true,
    configurePresets: ['conan-default-release'],
    configuredPreset: 'conan-default-release',
  };

  it('say nothing after a clean install', () => {
    assert.equal(installHints(install, 'tool'), undefined);
  });

  it('point at errorOutput for failed profiles', () => {
    const hints = installHints({
      ...install,
      outcome: 'partiallyFailed',
      profiles: [{ profile: 'default', succeeded: false, hasPresets: false }, { profile: 'debug', succeeded: false, hasPresets: false }],
    }, 'tool')!;
    assert.equal(hints.length, 1);
    assert.match(hints[0], /^Conan failed for profiles 'default', 'debug': errorOutput/);
  });

  it('report a profile without presets, a hand-written CMakeUserPresets.json and a missed configure', () => {
    assert.match(installHints({ ...install, profiles: [{ profile: 'default', succeeded: true, hasPresets: false }] }, 'tool')![0],
      /no CMakePresets.json for profile 'default'/);
    assert.match(installHints({ ...install, outcome: 'userPresetsNotOwned', profiles: [], configurePresets: [], configuredPreset: undefined }, 'tool')![0],
      /ask the user before deleting or renaming it/);
    assert.match(installHints({ ...install, configuredPreset: undefined }, 'tool')![0], /CMake Tools wasn't configured/);
  });

  it('mention cmake_layout only when Conan ran', () => {
    assert.match(installHints({ ...install, usesCmakeLayout: false }, 'tool')![0], /cmake_layout/);
    assert.equal(installHints({ ...install, outcome: 'upToDate', profiles: [], usesCmakeLayout: false }, 'tool'), undefined);
  });
});

describe('endpointsDirectory', () => {
  it('is under the local application data of each platform', () => {
    assert.equal(endpointsDirectory({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'),
      path.join('C:\\Users\\u\\AppData\\Local', 'vscode-conan', 'endpoints'));
    assert.equal(endpointsDirectory({}, 'darwin', '/Users/u'), path.join('/Users/u', 'Library', 'Caches', 'vscode-conan', 'endpoints'));
    assert.equal(endpointsDirectory({}, 'linux', '/home/u'), path.join('/home/u', '.cache', 'vscode-conan', 'endpoints'));
    assert.equal(endpointsDirectory({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/u'), path.join('/c', 'vscode-conan', 'endpoints'));
    assert.equal(endpointsDirectory({ VSCODE_CONAN_ENDPOINTS_DIR: '/x' }, 'linux', '/home/u'), '/x');
  });
});

describe('socketPath', () => {
  const id = '0123456789abcdef';

  it('is a named pipe on Windows', () => {
    assert.equal(socketPath('C:\\deep', id, 'win32'), `\\\\.\\pipe\\vscode-conan-${id}`);
  });

  it('is beside the endpoint file when the path fits', () => {
    assert.equal(socketPath('/home/u/.cache/vscode-conan/endpoints', id, 'linux', {}, '/tmp'), `/home/u/.cache/vscode-conan/endpoints/${id}.sock`);
  });

  it('moves to a shorter per-user folder when the path would be too long', () => {
    const deep = '/' + 'd'.repeat(90);
    assert.equal(socketPath(deep, id, 'darwin', {}, '/var/folders/x/T'), `/var/folders/x/T/vscode-conan-${id}.sock`);
    assert.equal(socketPath(deep, id, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp'), `/run/user/1000/vscode-conan-${id}.sock`);
    assert.equal(socketPath(deep, id, 'linux', {}, '/tmp'), `/tmp/vscode-conan-${id}.sock`);
  });
});

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'vscode-conan', 'scripts', 'vscode-conan.mjs');

/** Runs the skill's script, as an agent would, with `env` added to this process's environment. */
function runScript(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; output: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, cwd }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      try {
        resolve({ code, output: JSON.parse(stdout) });
      } catch {
        reject(new Error(`The script printed something that isn't JSON (exit code ${code}): ${stdout}`));
      }
    });
  });
}

describe('the external endpoint and the skill script', () => {
  async function withEndpoint(
    handler: (request: EndpointRequest) => Promise<unknown>,
    body: (context: { dir: TempDirectory; endpoints: string; workspace: string; endpoint: ExternalEndpoint }) => Promise<void>,
  ): Promise<void> {
    const dir = new TempDirectory();
    const endpoints = path.join(dir.path, 'endpoints');
    const workspace = path.join(dir.path, 'app');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const endpoint = await ExternalEndpoint.start(handler, error => (error instanceof Error ? error.message : String(error)), endpoints);
    try {
      endpoint.setFolders([workspace]);
      await body({ dir, endpoints, workspace, endpoint });
    } finally {
      endpoint.dispose();
      dir.dispose();
    }
  }

  it("runs an operation in the window whose workspace folder holds the script's folder", async () => {
    const requests: EndpointRequest[] = [];
    await withEndpoint(async request => {
      requests.push(request);
      return { upToDate: true };
    }, async ({ endpoints, workspace }) => {
      const { code, output } = await runScript(['getStatus'], { VSCODE_CONAN_ENDPOINTS_DIR: endpoints }, path.join(workspace, 'src'));
      assert.equal(code, 0);
      assert.deepEqual(output, { upToDate: true });
      assert.deepEqual(requests, [{ operation: 'getStatus', arguments: { folder: workspace } }]);
    });
  });

  it('passes the profiles and force', async () => {
    const requests: EndpointRequest[] = [];
    await withEndpoint(async request => {
      requests.push(request);
      return {};
    }, async ({ endpoints, workspace }) => {
      const env = { VSCODE_CONAN_ENDPOINTS_DIR: endpoints };
      assert.equal((await runScript(['selectProfiles', '--host', 'default,debug', '--host', 'gcc', '--build', 'default', '--folder', workspace], env)).code, 0);
      assert.equal((await runScript(['installDependencies', '--force', '--folder', workspace], env)).code, 0);
      assert.deepEqual(requests.map(r => r.arguments), [
        { folder: workspace, hostProfiles: ['default', 'debug', 'gcc'], buildProfile: 'default' },
        { folder: workspace, force: true },
      ]);
    });
  });

  it('exits with 1 for an error or a failed install, and 2 when no window has the folder', async () => {
    await withEndpoint(async request => {
      if (request.operation === 'getStatus') {
        throw new Error('No Conan profiles are selected.');
      }
      return { outcome: 'partiallyFailed' };
    }, async ({ dir, endpoints, workspace }) => {
      const env = { VSCODE_CONAN_ENDPOINTS_DIR: endpoints };
      assert.deepEqual(await runScript(['getStatus', '--folder', workspace], env), { code: 1, output: { error: 'No Conan profiles are selected.' } });
      assert.equal((await runScript(['installDependencies', '--folder', workspace], env)).code, 1);

      const elsewhere = await runScript(['getStatus', '--folder', dir.path], env);
      assert.equal(elsewhere.code, 2);
      assert.match(String(elsewhere.output.error), /Open ones: .*app/);
    });
  });

  it('rejects bad arguments before contacting VS Code', async () => {
    const { code, output } = await runScript(['selectProfiles'], { VSCODE_CONAN_ENDPOINTS_DIR: path.join(__dirname, 'no-such-dir') });
    assert.equal(code, 1);
    assert.match(String(output.error), /needs at least one --host/);
  });

  it('ignores the endpoint files of exited windows, and is gone once disposed', async () => {
    await withEndpoint(async () => ({ live: true }), async ({ endpoints, workspace, endpoint }) => {
      fs.writeFileSync(path.join(endpoints, 'stale.json'), JSON.stringify({
        version: PROTOCOL_VERSION, pid: 2 ** 30, socket: path.join(endpoints, 'gone.sock'), token: 'x', folders: [workspace], startedAt: '9999',
      }));
      const env = { VSCODE_CONAN_ENDPOINTS_DIR: endpoints };
      assert.deepEqual((await runScript(['getStatus', '--folder', workspace], env)).output, { live: true });

      endpoint.dispose();
      assert.equal(fs.existsSync(endpoint.infoFile), false);
      assert.equal((await runScript(['getStatus', '--folder', workspace], env)).code, 2);
    });
  });

  it('refuses a request without the right token', async () => {
    await withEndpoint(async () => ({}), async ({ endpoint }) => {
      const info = JSON.parse(fs.readFileSync(endpoint.infoFile, 'utf8'));
      const reply = await new Promise<string>((resolve, reject) => {
        const connection = net.createConnection(info.socket, () =>
          connection.write(JSON.stringify({ version: PROTOCOL_VERSION, token: 'guess', operation: 'getStatus', arguments: {} }) + '\n'));
        let text = '';
        connection.setEncoding('utf8');
        connection.on('data', chunk => (text += chunk));
        connection.on('end', () => resolve(text));
        connection.on('error', reject);
      });
      assert.match(JSON.parse(reply).error, /Wrong token/);
    });
  });

  it('works from an endpoints folder too deep for a socket beside it', { skip: process.platform === 'win32' ? 'named pipes have no path limit' : false }, async () => {
    const dir = new TempDirectory();
    try {
      const endpoints = path.join(dir.path, 'x'.repeat(60), 'y'.repeat(60));
      const endpoint = await ExternalEndpoint.start(async () => ({ deep: true }), String, endpoints);
      let info: { socket: string } | undefined;
      try {
        endpoint.setFolders([dir.path]);
        info = JSON.parse(fs.readFileSync(endpoint.infoFile, 'utf8')) as { socket: string };
        assert.equal(path.dirname(info.socket) === endpoints, false, info.socket);
        assert.deepEqual((await runScript(['getStatus', '--folder', dir.path], { VSCODE_CONAN_ENDPOINTS_DIR: endpoints })).output, { deep: true });
      } finally {
        endpoint.dispose();
      }
      assert.equal(fs.existsSync(info.socket), false, 'the socket outlived the endpoint');
    } finally {
      dir.dispose();
    }
  });

  it("finds the endpoint in the platform's default folder", async () => {
    const dir = new TempDirectory();
    try {
      // os.homedir() follows HOME on Linux and macOS; Windows uses LOCALAPPDATA.
      const env = { HOME: dir.path, LOCALAPPDATA: dir.path, XDG_CACHE_HOME: path.join(dir.path, '.cache'), VSCODE_CONAN_ENDPOINTS_DIR: '' };
      const endpoint = await ExternalEndpoint.start(async () => ({ found: true }), String,
        endpointsDirectory(env, process.platform, dir.path));
      try {
        endpoint.setFolders([dir.path]);
        assert.deepEqual((await runScript(['getStatus', '--folder', dir.path], env)).output, { found: true });
      } finally {
        endpoint.dispose();
      }
    } finally {
      dir.dispose();
    }
  });
});
