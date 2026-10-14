import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A temporary directory, removed by `dispose`. */
export class TempDirectory {
  readonly path = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-conan-'));

  /** Creates a file relative to the directory and returns its full path. */
  write(name: string, content = ''): string {
    const filePath = path.join(this.path, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  dispose(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}

export function withTempDirectory<T>(body: (dir: TempDirectory) => T): T {
  const dir = new TempDirectory();
  try {
    const result = body(dir);
    if (result instanceof Promise) {
      return result.finally(() => dir.dispose()) as T;
    }
    dir.dispose();
    return result;
  } catch (error) {
    dir.dispose();
    throw error;
  }
}
