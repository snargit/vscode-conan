import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConanProject } from './conanProject';

// Bump when the install arguments or the fingerprint's inputs change, to force a reinstall.
const FORMAT_VERSION = '2';

/** Files in the project root that decide what `conan install` produces. */
export const CONAN_INPUT_FILES = ['conanfile.py', 'conanfile.txt', 'conan.lock', 'conandata.yml'] as const;

/** What Conan reports for the project folder, for the fingerprint. */
export interface ResolvedConanInputs {
  /** `conan config home` (CONAN_HOME, or a .conanrc in the project folder or a parent). */
  readonly home: string;
  /** `conan profile show` output for each host profile, in order. */
  readonly profiles: readonly string[];
}

/**
 * A hash of everything that decides what `conan install` produces, so the install can be skipped
 * when nothing has changed:
 * - the conanfile, conan.lock and conandata.yml;
 * - the Conan home in use, so switching it (CONAN_HOME, .conanrc) counts;
 * - the selected profiles as Conan resolves them (`conan profile show`), so edits to a profile or
 *   to a profile it includes count, and edits to unrelated profiles don't.
 */
export function computeInstallFingerprint(
  project: ConanProject,
  hostProfiles: readonly string[],
  buildProfile: string,
  resolved: ResolvedConanInputs,
): string {
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
  for (const name of CONAN_INPUT_FILES.filter(name => !name.startsWith('conanfile.'))) {
    addFile(path.join(project.rootDirectory, name));
  }

  add(`home:${resolved.home}`);
  add(`build:${buildProfile}`);
  hostProfiles.forEach((profile, index) => {
    add(`host:${profile}`);
    add(resolved.profiles[index] ?? '');
  });

  return hash.digest('hex');
}
