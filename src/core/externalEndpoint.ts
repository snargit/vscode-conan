import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A local endpoint through which processes outside VS Code (agents running in a terminal, such as
 * Claude Code or Codex) reach the extension, as Copilot does through its tools. VS Code has no way
 * for another process to run an extension's command, so each window with a Conan project listens
 * on a named pipe (Windows) or Unix socket, and advertises it in a file in a per-user folder.
 * skills/vscode-conan/scripts/vscode-conan.mjs is the client; keep the two in step.
 *
 * Protocol: the client connects, writes one line of JSON `{ "version": 1, "token", "operation",
 * "arguments" }`, and reads one line back: `{ "result": ... }` or `{ "error": "..." }`. The token,
 * from the endpoint file, keeps out anyone who can't read the user's own files.
 */
export const PROTOCOL_VERSION = 1;

/** The endpoint file, `<endpoints folder>/<id>.json`. */
export interface EndpointInfo {
  readonly version: number;
  /** The extension host's process id; a file whose process has gone is stale. */
  readonly pid: number;
  /** Named pipe or Unix socket path. */
  readonly socket: string;
  readonly token: string;
  /** The window's Conan CMake workspace folders. */
  readonly folders: readonly string[];
  readonly startedAt: string;
}

export interface EndpointRequest {
  readonly operation: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Answers a request; a rejection becomes `{ error: <message> }`. */
export type EndpointHandler = (request: EndpointRequest) => Promise<unknown>;

/** Turns a handler failure into the message sent back. */
export type DescribeError = (error: unknown) => string;

const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Where endpoint files go: under the user's local application data, never in the project.
 * `VSCODE_CONAN_ENDPOINTS_DIR` overrides it, for tests.
 */
export function endpointsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.VSCODE_CONAN_ENDPOINTS_DIR) {
    return env.VSCODE_CONAN_ENDPOINTS_DIR;
  }

  switch (platform) {
    case 'win32': return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'vscode-conan', 'endpoints');
    case 'darwin': return path.join(home, 'Library', 'Caches', 'vscode-conan', 'endpoints');
    default: return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'vscode-conan', 'endpoints');
  }
}

export class ExternalEndpoint {
  private folders: readonly string[] = [];

  private constructor(
    private readonly server: net.Server,
    private readonly directory: string,
    private readonly id: string,
    private readonly socket: string,
    private readonly token: string,
  ) {}

  /** Starts listening. The endpoint isn't advertised until it has folders (see `setFolders`). */
  static async start(handler: EndpointHandler, describeError: DescribeError, directory = endpointsDirectory()): Promise<ExternalEndpoint> {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    removeStaleEndpoints(directory);

    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const socket = socketPath(directory, id);
    const server = net.createServer(connection => serve(connection, token, handler, describeError));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(socket, 0o600);
    }

    return new ExternalEndpoint(server, directory, id, socket, token);
  }

  /** The folders this window answers for; with none, the endpoint file is removed. */
  setFolders(folders: readonly string[]): void {
    this.folders = [...folders];
    if (this.folders.length === 0) {
      removeFile(this.infoFile);
      return;
    }

    const info: EndpointInfo = {
      version: PROTOCOL_VERSION,
      pid: process.pid,
      socket: this.socket,
      token: this.token,
      folders: this.folders,
      startedAt: new Date().toISOString(),
    };
    // Written whole and then renamed, so a client never reads half a file.
    const temporary = `${this.infoFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(info, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.infoFile);
  }

  get infoFile(): string {
    return path.join(this.directory, `${this.id}.json`);
  }

  dispose(): void {
    removeFile(this.infoFile);
    this.server.close();
    if (process.platform !== 'win32') {
      removeFile(this.socket);
    }
  }
}

/**
 * A named pipe on Windows; elsewhere a Unix socket beside the endpoint file. A Unix socket's path
 * is limited (104 bytes on macOS, 108 on Linux, counting the terminating NUL), so when the
 * endpoints folder is too deep the socket goes in a shorter per-user folder instead. The endpoint
 * file records where it is.
 */
export function socketPath(
  directory: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  temporary: string = os.tmpdir(),
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\vscode-conan-${id}`;
  }

  const beside = path.posix.join(directory, `${id}.sock`);
  const limit = platform === 'linux' ? 107 : 103;
  if (Buffer.byteLength(beside) <= limit) {
    return beside;
  }

  // XDG_RUNTIME_DIR is the user's own; macOS's os.tmpdir() is per user too. Elsewhere the socket
  // is made private once it exists, and a request needs the token from the endpoint file anyway.
  const short = (platform === 'linux' && env.XDG_RUNTIME_DIR) || temporary;
  return path.posix.join(short, `vscode-conan-${id}.sock`);
}

function serve(connection: net.Socket, token: string, handler: EndpointHandler, describeError: DescribeError): void {
  let received = '';
  let answered = false;
  const reply = (payload: unknown) => {
    if (!answered) {
      answered = true;
      connection.end(JSON.stringify(payload) + '\n');
    }
  };

  connection.setEncoding('utf8');
  connection.on('error', () => { /* The client went away; an install it started carries on. */ });
  connection.on('data', (chunk: string) => {
    if (answered) {
      return;
    }

    received += chunk;
    if (received.length > MAX_REQUEST_BYTES) {
      reply({ error: 'Request too large.' });
      return;
    }

    const newline = received.indexOf('\n');
    if (newline < 0) {
      return;
    }

    let request: { version?: unknown; token?: unknown; operation?: unknown; arguments?: unknown };
    try {
      request = JSON.parse(received.slice(0, newline));
    } catch {
      reply({ error: 'The request must be one line of JSON.' });
      return;
    }

    if (typeof request.token !== 'string' || !sameToken(request.token, token)) {
      reply({ error: "Wrong token: read it from the endpoint file." });
      return;
    }
    if (request.version !== PROTOCOL_VERSION) {
      reply({ error: `Unsupported protocol version ${String(request.version)}; this extension speaks version ${PROTOCOL_VERSION}. Update the script from the extension's skill.` });
      return;
    }
    if (typeof request.operation !== 'string') {
      reply({ error: 'The request has no operation.' });
      return;
    }

    const args = typeof request.arguments === 'object' && request.arguments !== null ? request.arguments as Record<string, unknown> : {};
    handler({ operation: request.operation, arguments: args }).then(
      result => reply({ result }),
      error => reply({ error: describeError(error) }));
  });
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Removes endpoint files (and sockets) left by extension hosts that have exited without cleaning up. */
function removeStaleEndpoints(directory: string): void {
  for (const name of safeReadDirectory(directory)) {
    if (!name.endsWith('.json')) {
      continue;
    }

    const file = path.join(directory, name);
    let info: Partial<EndpointInfo>;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // Being written, or not ours: leave it.
    }

    if (typeof info.pid === 'number' && !isRunning(info.pid)) {
      removeFile(file);
      if (typeof info.socket === 'string' && !info.socket.startsWith('\\\\.\\pipe\\')) {
        removeFile(info.socket);
      }
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeReadDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: a stale file is skipped by clients and removed by the next extension host.
  }
}
