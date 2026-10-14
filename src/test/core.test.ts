import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildInstallArguments, parseGeneratorsFolder, parseProfileList } from '../core/conanCli';
import { findConanProject, isConanCMakeProject } from '../core/conanProject';
import { computeInstallFingerprint } from '../core/fingerprint';
import { validateProfileChoice } from '../core/profileChoice';
import { MemoryFolderStateStore } from '../core/settings';
import {
  canWriteUserPresets,
  readConfigurePresetNames,
  readUserPresetsIncludes,
  userPresetsPath,
  writeUserPresets,
} from '../core/userPresetsFile';
import { withTempDirectory } from './helpers';

describe('buildInstallArguments', () => {
  it('names presets after the profile and leaves CMakeUserPresets.json to the extension', () => {
    assert.deepEqual(buildInstallArguments({ projectDirectory: '/src/app', hostProfile: 'gcc-debug', buildProfile: 'default' }), [
      'install', '/src/app',
      '-pr:h', 'gcc-debug',
      '-pr:b', 'default',
      '-c', "tools.cmake.cmake_layout:build_folder_vars=['const.gcc-debug']",
      '-c', 'tools.cmake.cmaketoolchain:generator=Ninja',
      '-c', 'tools.cmake.cmaketoolchain:user_presets=',
      '--format=json',
      '--build=missing',
    ]);
  });

  it('omits --build=missing when disabled', () => {
    const args = buildInstallArguments({ projectDirectory: 'dir', hostProfile: 'p', buildProfile: 'default', buildMissing: false });
    assert.ok(!args.includes('--build=missing'));
  });
});

describe('Conan output parsing', () => {
  it('reads the profile list', () => {
    assert.deepEqual(parseProfileList('[\n    "debug",\n    "default"\n]\n'), ['debug', 'default']);
  });

  it("reads the consumer node's generators folder", () => {
    const json = JSON.stringify({ graph: { nodes: {
      '0': { ref: 'conanfile', generators_folder: '/src/app/build/debug/Debug/generators' },
      '1': { ref: 'zlib/1.3', generators_folder: null },
    } } });
    assert.equal(parseGeneratorsFolder(json), '/src/app/build/debug/Debug/generators');
  });

  for (const json of ['', 'not json', '{ "graph": {} }']) {
    it(`returns undefined for unexpected output ${JSON.stringify(json)}`, () => {
      assert.equal(parseGeneratorsFolder(json), undefined);
    });
  }
});

describe('findConanProject', () => {
  const notProjects: string[][] = [
    [],                                         // empty folder
    ['CMakeLists.txt'],                         // plain CMake project
    ['conanfile.py'],                           // Conan, but not CMake
    ['conanfile.txt'],
    ['CMakeLists.txt', 'conan.lock'],           // Conan artifacts that can't be installed
    ['CMakeLists.txt', 'conandata.yml'],
    ['CMakeLists.txt', 'src/conanfile.py'],     // conanfile not at the root
    ['conanfile.py', 'src/CMakeLists.txt'],     // CMakeLists.txt not at the root
  ];

  for (const files of notProjects) {
    it(`ignores a folder containing [${files.join(', ')}]`, () => withTempDirectory(dir => {
      files.forEach(file => dir.write(file));
      assert.equal(findConanProject(dir.path), undefined);
      assert.equal(isConanCMakeProject(dir.path), false);
    }));
  }

  for (const directory of [undefined, '', path.join('does', 'not', 'exist')]) {
    it(`ignores missing folder ${JSON.stringify(directory)}`, () => {
      assert.equal(findConanProject(directory), undefined);
      assert.equal(isConanCMakeProject(directory), false);
    });
  }

  for (const conanfile of ['conanfile.py', 'conanfile.txt']) {
    it(`accepts ${conanfile} with CMakeLists.txt`, () => withTempDirectory(dir => {
      dir.write('CMakeLists.txt');
      dir.write(conanfile);
      assert.ok(isConanCMakeProject(dir.path));
      assert.equal(path.basename(findConanProject(dir.path)!.conanfilePath), conanfile);
    }));
  }

  it('prefers conanfile.py and detects cmake_layout', () => withTempDirectory(dir => {
    dir.write('CMakeLists.txt');
    dir.write('conanfile.txt', '[layout]\ncmake_layout\n');
    dir.write('conanfile.py', 'class App(ConanFile): pass\n');
    const project = findConanProject(dir.path)!;
    assert.equal(path.basename(project.conanfilePath), 'conanfile.py');
    assert.equal(project.usesCmakeLayout, false);

    fs.rmSync(project.conanfilePath);
    assert.equal(findConanProject(dir.path)!.usesCmakeLayout, true);
  }));
});

describe('CMakeUserPresets.json', () => {
  it('writes relative includes and reads them back', () => withTempDirectory(dir => {
    const presets = path.join(dir.path, 'build', 'debug', 'Debug', 'generators', 'CMakePresets.json');
    assert.ok(writeUserPresets(dir.path, [presets]));
    assert.match(fs.readFileSync(userPresetsPath(dir.path), 'utf8'), /"build\/debug\/Debug\/generators\/CMakePresets\.json"/);
    assert.deepEqual(readUserPresetsIncludes(dir.path), [presets]);
    assert.ok(canWriteUserPresets(dir.path));
  }));

  it('skips identical content', () => withTempDirectory(dir => {
    const presets = [path.join(dir.path, 'a', 'CMakePresets.json')];
    writeUserPresets(dir.path, presets);
    assert.equal(writeUserPresets(dir.path, presets), false);
  }));

  it('never overwrites a hand-written file', () => withTempDirectory(dir => {
    dir.write('CMakeUserPresets.json', '{ "version": 4, "configurePresets": [] }');
    assert.equal(canWriteUserPresets(dir.path), false);
  }));

  it('reads configure preset names', () => withTempDirectory(dir => {
    const file = dir.write('CMakePresets.json', JSON.stringify({ configurePresets: [{ name: 'conan-default-release' }] }));
    assert.deepEqual(readConfigurePresetNames(file), ['conan-default-release']);
    assert.deepEqual(readConfigurePresetNames(path.join(dir.path, 'missing.json')), []);
  }));
});

describe('computeInstallFingerprint', () => {
  it('changes with the conanfile and the profiles', () => withTempDirectory(dir => {
    dir.write('CMakeLists.txt');
    const conanfile = dir.write('conanfile.txt', '[requires]\nzlib/1.3\n');
    const project = () => findConanProject(dir.path)!;

    const original = computeInstallFingerprint(project(), ['default'], 'default');
    assert.equal(computeInstallFingerprint(project(), ['default'], 'default'), original);
    assert.notEqual(computeInstallFingerprint(project(), ['default', 'debug'], 'default'), original);
    assert.notEqual(computeInstallFingerprint(project(), ['default'], 'debug'), original);

    fs.writeFileSync(conanfile, '[requires]\nzlib/1.3.1\n');
    assert.notEqual(computeInstallFingerprint(project(), ['default'], 'default'), original);
  }));
});

describe('MemoryFolderStateStore', () => {
  it('returns defaults, then round-trips copies', async () => {
    const store = new MemoryFolderStateStore();
    assert.deepEqual(store.load('/a'), { hostProfiles: [], buildProfile: 'default', firstRunPromptShown: false });

    const state = store.load('/a');
    state.hostProfiles.push('default');
    state.firstRunPromptShown = true;
    await store.save('/a', state);
    state.hostProfiles.push('mutated after save');

    assert.deepEqual(store.load('/a').hostProfiles, ['default']);
    assert.equal(store.load('/a').firstRunPromptShown, true);
  });
});

describe('validateProfileChoice', () => {
  const available = ['default', 'debug', 'gcc-13'];

  it('accepts known profiles and removes duplicate hosts', () => {
    assert.deepEqual(validateProfileChoice(available, ['debug', ' debug ', 'default'], 'default'),
      { choice: { hostProfiles: ['debug', 'default'], buildProfile: 'default' } });
  });

  it('rejects an empty host list', () => {
    assert.deepEqual(validateProfileChoice(available, ['', '  '], 'default'), { error: 'Choose at least one host profile.' });
  });

  it('names unknown host and build profiles, and lists the available ones', () => {
    const result = validateProfileChoice(available, ['debug', 'clang'], 'msvc');
    assert.ok('error' in result);
    assert.match(result.error, /Unknown Conan profile\(s\): clang, msvc\./);
    assert.match(result.error, /Available profiles: default, debug, gcc-13\./);
  });

  it('suggests creating a profile when there are none', () => {
    const result = validateProfileChoice([], ['default'], 'default');
    assert.ok('error' in result && result.error.includes('conan profile detect'));
  });
});
