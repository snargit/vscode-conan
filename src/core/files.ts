import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Writes `content` unless the file already holds exactly that text, replacing the file in a
 * single step. CMake Tools watches the files written here, so a partial write or an identical
 * rewrite would each trigger a pointless reload.
 *
 * @returns true if the file was written.
 */
export function writeFileIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.vscode-conan.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
  return true;
}
