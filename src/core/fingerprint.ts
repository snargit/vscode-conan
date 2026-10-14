import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConanProject } from './conanProject';

// Bump when the install arguments change, to force a reinstall.
const FORMAT_VERSION = '1';

/**
 * A hash of everything that decides what `conan install` produces, so opening a folder can skip
 * the install when nothing has changed. Edits to the Conan profiles themselves aren't covered;
 * run Install Dependencies after changing one.
 */
export function computeInstallFingerprint(project: ConanProject, hostProfiles: readonly string[], buildProfile: string): string {
  const hash = createHash('sha256');
  const add = (text: string) => hash.update(text + '\n');
  const addFile = (filePath: string) => {
    add(path.basename(filePath));
    if (fs.existsSync(filePath)) {
      hash.update(fs.readFileSync(filePath));
    }
    add('');
  };

  add(FORMAT_VERSION);
  addFile(project.conanfilePath);
  addFile(path.join(project.rootDirectory, 'conan.lock'));
  add(`build:${buildProfile}`);
  for (const profile of hostProfiles) {
    add(`host:${profile}`);
  }

  return hash.digest('hex');
}
