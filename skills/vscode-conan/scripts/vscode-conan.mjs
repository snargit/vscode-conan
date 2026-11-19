#!/usr/bin/env node
// Runs an operation of the "Conan for CMake Tools" VS Code extension from outside VS Code, in the
// VS Code window that has the folder open, and prints the result as JSON. For agents that can't
// call the extension's tools (Copilot can): Claude Code, Codex and others running in a terminal.
//
//   node vscode-conan.mjs <operation> [--folder <path>] [options]
//
// Operations (the same as the tools conan_<operation> and the commands conan.<operation>):
//   getStatus                         profiles, install state, presets, cmakeUsage, hints
//   listProfiles                      the output of 'conan profile list'
//   selectProfiles --host <profile> [--host <profile>...] [--build <profile>]
//                                     saves the profiles to install for; installs nothing
//   installDependencies [--force]     conan install per selected profile, then CMake Tools configures
//
// --folder defaults to the current directory; it may be inside the workspace folder.
// --timeout <seconds> defaults to 1800 for installDependencies and 120 otherwise.
//
// Exit code: 0 the operation succeeded; 1 it failed (an "error", or an install whose outcome is
// partiallyFailed or userPresetsNotOwned); 2 the extension couldn't be reached.
//
// Needs Node.js 18 or later and nothing else. Keep in step with src/core/externalEndpoint.ts.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const PROTOCOL_VERSION = 1;
const OPERATIONS = ['getStatus', 'listProfiles', 'selectProfiles', 'installDependencies'];
const USAGE = 'Usage: node vscode-conan.mjs <getStatus|listProfiles|selectProfiles|installDependencies> '
  + '[--folder <path>] [--host <profile>]... [--build <profile>] [--force] [--timeout <seconds>]';

class Unreachable extends Error {}

try {
  const options = parseArguments(process.argv.slice(2));
  const { endpoint, workspaceFolder } = findEndpoint(options.folder);
  const args = { folder: workspaceFolder };
  if (options.operation === 'selectProfiles') {
    args.hostProfiles = options.hosts;
    if (options.build) {
      args.buildProfile = options.build;
    }
  }
  if (options.operation === 'installDependencies') {
    args.force = options.force;
  }

  const timeout = options.timeout ?? (options.operation === 'installDependencies' ? 1800 : 120);
  const response = await send(endpoint, { version: PROTOCOL_VERSION, token: endpoint.token, operation: options.operation, arguments: args }, timeout);
  const failed = 'error' in response
    || ['partiallyFailed', 'userPresetsNotOwned'].includes(response.result?.outcome);
  print('error' in response ? { error: response.error } : response.result);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  print({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = error instanceof Unreachable ? 2 : 1;
}

function parseArguments(argv) {
  const options = { operation: argv[0], folder: process.cwd(), hosts: [], force: false };
  if (!OPERATIONS.includes(options.operation)) {
    throw new Error(`${options.operation ? `Unknown operation '${options.operation}'. ` : ''}${USAGE}`);
  }

  for (let i = 1; i < argv.length; i++) {
    const value = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${argv[i]} needs a value. ${USAGE}`);
      }
      return argv[++i];
    };
    switch (argv[i]) {
      case '--folder': options.folder = path.resolve(value()); break;
      case '--host': options.hosts.push(...value().split(',').map(p => p.trim()).filter(p => p.length > 0)); break;
      case '--build': options.build = value(); break;
      case '--force': options.force = true; break;
      case '--timeout': options.timeout = Number(value()); break;
      default: throw new Error(`Unknown option '${argv[i]}'. ${USAGE}`);
    }
  }

  if (options.operation === 'selectProfiles' && options.hosts.length === 0) {
    throw new Error('selectProfiles needs at least one --host <profile>; getStatus lists availableProfiles.');
  }
  if (options.timeout !== undefined && !(options.timeout > 0)) {
    throw new Error('--timeout must be a number of seconds.');
  }
  return options;
}

/** The endpoint of the VS Code window whose workspace folder holds `folder` (the innermost, if they nest). */
function findEndpoint(folder) {
  const directory = endpointsDirectory();
  const endpoints = readEndpoints(directory);
  let best;
  for (const endpoint of endpoints) {
    for (const workspaceFolder of endpoint.folders) {
      if (contains(workspaceFolder, folder) && (!best || workspaceFolder.length > best.workspaceFolder.length
        || (workspaceFolder.length === best.workspaceFolder.length && endpoint.startedAt > best.endpoint.startedAt))) {
        best = { endpoint, workspaceFolder };
      }
    }
  }

  if (best) {
    return best;
  }

  const open = endpoints.flatMap(endpoint => endpoint.folders);
  throw new Unreachable(open.length === 0
    ? 'No VS Code window has a Conan CMake project open with the "Conan for CMake Tools" extension '
      + '(or its conan.allowExternalCallers setting is off). Ask the user to open the folder in VS Code.'
    : `No VS Code window has ${folder} open as a Conan CMake project (workspace folders with a conanfile and a CMakeLists.txt). `
      + `Open ones: ${open.join(', ')}. Pass --folder, or ask the user to open the folder in VS Code.`);
}

/** Endpoint files whose VS Code is still running. */
function readEndpoints(directory) {
  let names;
  try {
    names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }

  return names.flatMap(name => {
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      return Array.isArray(endpoint.folders) && typeof endpoint.socket === 'string' && isRunning(endpoint.pid) ? [endpoint] : [];
    } catch {
      return [];
    }
  });
}

/** As in src/core/externalEndpoint.ts. */
function endpointsDirectory() {
  const env = process.env;
  if (env.VSCODE_CONAN_ENDPOINTS_DIR) {
    return env.VSCODE_CONAN_ENDPOINTS_DIR;
  }

  const home = os.homedir();
  switch (process.platform) {
    case 'win32': return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'vscode-conan', 'endpoints');
    case 'darwin': return path.join(home, 'Library', 'Caches', 'vscode-conan', 'endpoints');
    default: return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'vscode-conan', 'endpoints');
  }
}

function contains(parent, child) {
  const normalize = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRunning(pid) {
  if (typeof pid !== 'number') {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function send(endpoint, request, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(endpoint.socket);
    let received = '';
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`No answer within ${timeoutSeconds} seconds. The operation may still be running in VS Code: `
        + 'getStatus reports installing while an install runs.'));
    }, timeoutSeconds * 1000);

    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(JSON.stringify(request) + '\n'));
    connection.on('data', chunk => {
      received += chunk;
    });
    connection.on('error', error => {
      clearTimeout(timer);
      reject(new Unreachable(`Couldn't reach VS Code for ${endpoint.folders.join(', ')}: ${error.message}. `
        + 'If that window has closed, ask the user to open the folder in VS Code.'));
    });
    connection.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(received));
      } catch {
        reject(new Unreachable(`VS Code sent an answer that isn't JSON: ${received.slice(0, 200)}`));
      }
    });
  });
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
