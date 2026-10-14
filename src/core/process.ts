import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface RunOptions {
  readonly cwd?: string;
  /** Receives stderr lines, and stdout lines unless `streamStdout` is false. */
  readonly onLine?: (line: string) => void;
  readonly streamStdout?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Runs a process to completion without a shell, so arguments reach it verbatim. stdout is also
 * collected and returned so callers can parse it. Rejects if the process can't be started (e.g.
 * the executable isn't on PATH) or `signal` aborts it.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      signal: options.signal,
      env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    const streamStdout = options.streamStdout ?? true;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    forEachLine(child.stdout, line => streamStdout && options.onLine?.(line));
    forEachLine(child.stderr, line => options.onLine?.(line));

    child.on('error', reject);
    child.on('close', code => resolve({ exitCode: code ?? -1, stdout }));
  });
}

function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = '';
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  stream.on('end', () => {
    if (pending.length > 0) {
      onLine(pending);
    }
  });
}
