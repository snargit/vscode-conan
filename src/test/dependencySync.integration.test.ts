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

      const result = await syncDependencies(project, store, new ConanCli('conan', dir.path), {
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
      assert.ok(await isUpToDate(project, store, new ConanCli('conan', dir.path)));

      const again = await syncDependencies(project, store, new ConanCli('conan', dir.path), { force: false, onLine: () => {} });
      assert.equal(again.outcome, 'upToDate');
      assert.deepEqual(again.configurePresetNames, ['conan-default-release']);
    } finally {
      dir.dispose();
    }
  });

  it("uses the project's .conanrc Conan home and notices a profile edit", async () => {
    const dir = new TempDirectory();
    try {
      const project = createProject(dir);
      // A Conan home of the project's own, so the user's real profiles are never touched.
      dir.write('.conanrc', 'conan_home=./conan-home\n');
      const cli = new ConanCli('conan', dir.path);
      assert.ok((await cli.configHome()).endsWith('conan-home'), 'conan config home ignored the .conanrc');
      assert.equal(spawnSync('conan', ['profile', 'detect'], { cwd: dir.path, shell: false }).status, 0);
      const profile = path.join(dir.path, 'conan-home', 'profiles', 'default');
      assert.ok(fs.existsSync(profile));

      const store = new MemoryFolderStateStore();
      await store.save(dir.path, { ...store.load(dir.path), hostProfiles: ['default'] });
      const result = await syncDependencies(project, store, cli, { force: false, onLine: () => {} });
      assert.equal(result.outcome, 'installed');
      assert.ok(await isUpToDate(project, store, cli));

      // Saving the profile unchanged isn't a change; editing what it resolves to is.
      fs.writeFileSync(profile, fs.readFileSync(profile));
      assert.ok(await isUpToDate(project, store, cli));
      fs.appendFileSync(profile, '\n[conf]\ntools.build:jobs=3\n');
      assert.equal(await isUpToDate(project, store, cli), false);
    } finally {
      dir.dispose();
    }
  });

  it("reports Conan's error for a failed profile", async () => {
    const dir = new TempDirectory();
    try {
      dir.write('conanfile.txt', '[layout]\ncmake_layout\n[nosuchsection]\n');
      dir.write('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.23)\nproject(app CXX)\n');
      const project = findConanProject(dir.path)!;
      const store = new MemoryFolderStateStore();
      await store.save(dir.path, { ...store.load(dir.path), hostProfiles: ['default'] });

      const result = await syncDependencies(project, store, new ConanCli('conan', dir.path), { force: false, onLine: () => {} });

      assert.equal(result.outcome, 'partiallyFailed');
      assert.equal(result.profiles.length, 1);
      assert.match(result.profiles[0].errorOutput ?? '', /ERROR/);
      assert.match(result.profiles[0].errorOutput ?? '', /nosuchsection/);
    } finally {
      dir.dispose();
    }
  });

  it('remembers the find_package names and targets of the direct dependencies', async () => {
    // A header-only package (nothing to compile), whose CMake names differ from its package name.
    const dir = new TempDirectory();
    dir.write(path.join('dep', 'conanfile.py'), [
      'from conan import ConanFile',
      '',
      'class Dep(ConanFile):',
      '    name = "vscode-conan-testdep"',
      '    version = "0.1"',
      '    package_type = "header-library"',
      '',
      '    def package_info(self):',
      '        self.cpp_info.bindirs = []',
      '        self.cpp_info.libdirs = []',
      '        self.cpp_info.set_property("cmake_file_name", "VsCodeConanTestDep")',
      '        self.cpp_info.set_property("cmake_target_name", "VsCodeConanTestDep::headers")',
      '',
    ].join('\n'));
    dir.write(path.join('app', 'conanfile.txt'), '[requires]\nvscode-conan-testdep/0.1\n[generators]\nCMakeToolchain\nCMakeDeps\n[layout]\ncmake_layout\n');
    dir.write(path.join('app', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.23)\nproject(app CXX)\n');
    const app = path.join(dir.path, 'app');
    assert.equal(spawnSync('conan', ['export', path.join(dir.path, 'dep')], { cwd: dir.path, shell: false }).status, 0);
    try {
      const project = findConanProject(app)!;
      const store = new MemoryFolderStateStore();
      await store.save(app, { ...store.load(app), hostProfiles: ['default'] });
      const cli = new ConanCli('conan', app);
      const expected = { default: { findPackages: ['VsCodeConanTestDep'], targets: ['VsCodeConanTestDep::headers'] } };

      const result = await syncDependencies(project, store, cli, { force: false, onLine: () => {} });
      assert.equal(result.outcome, 'installed');
      assert.deepEqual(result.profiles[0].cmakeUsage, expected.default);
      assert.deepEqual(store.load(app).cmakeUsage, expected);

      // Kept through an up-to-date install.
      assert.equal((await syncDependencies(project, store, cli, { force: false, onLine: () => {} })).outcome, 'upToDate');
      assert.deepEqual(store.load(app).cmakeUsage, expected);
    } finally {
      spawnSync('conan', ['remove', 'vscode-conan-testdep/*', '-c'], { cwd: dir.path, shell: false });
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
