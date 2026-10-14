import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ConanCli } from '../core/conanCli';
import { findConanProject } from '../core/conanProject';
import { isUpToDate, syncDependencies } from '../core/dependencySync';
import { MemoryFolderStateStore } from '../core/settings';
import { readUserPresetsIncludes, userPresetsPath } from '../core/userPresetsFile';
import { TempDirectory } from './helpers';

// Runs real 'conan install's: needs Conan 2 on PATH with a 'default' profile. Uses no remote packages.
const hasConan = spawnSync('conan', ['--version'], { shell: false }).status === 0;

function createProject(dir: TempDirectory) {
  dir.write('conanfile.txt', '[generators]\nCMakeToolchain\nCMakeDeps\n[layout]\ncmake_layout\n');
  dir.write('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.23)\nproject(app CXX)\n');
  return findConanProject(dir.path)!;
}

describe('syncDependencies (integration)', { skip: hasConan ? false : 'Conan 2 is not on PATH' }, () => {
  it('writes CMakeUserPresets.json once, after the installs', async () => {
    const dir = new TempDirectory();
    try {
      const project = createProject(dir);
      const store = new MemoryFolderStateStore();
      await store.save(dir.path, { ...store.load(dir.path), hostProfiles: ['default'] });
      const output: string[] = [];

      const result = await syncDependencies(project, store, new ConanCli(), {
        force: false,
        onLine: line => {
          output.push(line);
          // Conan is running: the user presets must not have been written yet.
          if (line.startsWith('==========')) {
            assert.equal(fs.existsSync(userPresetsPath(dir.path)), false);
          }
        },
      });

      assert.equal(result.outcome, 'installed', output.join('\n'));
      assert.deepEqual(result.configurePresetNames, ['conan-default-release']);

      const includes = readUserPresetsIncludes(dir.path);
      assert.equal(includes.length, 1);
      assert.ok(includes[0].includes(path.join('build', 'default')), includes[0]);
      assert.ok(fs.existsSync(includes[0]));
      assert.ok(isUpToDate(project, store));

      const again = await syncDependencies(project, store, new ConanCli(), { force: false, onLine: () => {} });
      assert.equal(again.outcome, 'upToDate');
      assert.deepEqual(again.configurePresetNames, ['conan-default-release']);
    } finally {
      dir.dispose();
    }
  });

  it('refuses to overwrite a hand-written CMakeUserPresets.json', async () => {
    const dir = new TempDirectory();
    try {
      const project = createProject(dir);
      const handWritten = '{ "version": 4, "configurePresets": [] }';
      dir.write('CMakeUserPresets.json', handWritten);
      const store = new MemoryFolderStateStore();
      await store.save(dir.path, { ...store.load(dir.path), hostProfiles: ['default'] });

      const result = await syncDependencies(project, store, new ConanCli(), { force: true, onLine: () => {} });

      assert.equal(result.outcome, 'userPresetsNotOwned');
      assert.equal(fs.readFileSync(userPresetsPath(dir.path), 'utf8'), handWritten);
    } finally {
      dir.dispose();
    }
  });
});
