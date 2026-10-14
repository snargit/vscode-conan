import * as fs from 'node:fs';
import * as path from 'node:path';

// The only files 'conan install <folder>' accepts. Other Conan artifacts (conan.lock,
// conandata.yml) can't be installed on their own, so they don't make a folder a Conan project.
const CONANFILE_NAMES = ['conanfile.py', 'conanfile.txt'];

const CMAKELISTS_NAME = 'CMakeLists.txt';

/** A folder this extension manages: a CMake project whose dependencies come from Conan. */
export interface ConanProject {
  readonly rootDirectory: string;
  readonly conanfilePath: string;
  /**
   * True when the conanfile appears to use cmake_layout. Without it, Conan names presets by
   * build type only, so installing several profiles produces colliding preset names.
   */
  readonly usesCmakeLayout: boolean;
}

/**
 * Cheap check (file existence only) that `directory` has both a conanfile and a CMakeLists.txt
 * at its root.
 */
export function isConanCMakeProject(directory: string | undefined): boolean {
  return findConanfile(directory) !== undefined;
}

/**
 * Returns the Conan project rooted at `directory`, or undefined unless it has both a conanfile
 * and a CMakeLists.txt. conanfile.py takes precedence over conanfile.txt, as in Conan.
 */
export function findConanProject(directory: string | undefined): ConanProject | undefined {
  const conanfilePath = findConanfile(directory);
  if (conanfilePath === undefined) {
    return undefined;
  }

  const usesCmakeLayout = fs.readFileSync(conanfilePath, 'utf8').includes('cmake_layout');
  return { rootDirectory: directory!, conanfilePath, usesCmakeLayout };
}

function findConanfile(directory: string | undefined): string | undefined {
  if (!directory || !isFile(path.join(directory, CMAKELISTS_NAME))) {
    return undefined;
  }

  return CONANFILE_NAMES.map(name => path.join(directory, name)).find(isFile);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
