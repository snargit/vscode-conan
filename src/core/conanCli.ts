import * as path from 'node:path';
import { runProcess } from './process';

/** Arguments for a single `conan install` of one host profile. */
export interface ConanInstallRequest {
  readonly projectDirectory: string;
  readonly hostProfile: string;
  readonly buildProfile: string;
  /** CMake generator written into the presets. */
  readonly generator?: string;
  readonly buildMissing?: boolean;
}

export interface ProfileInstallResult {
  readonly profile: string;
  readonly exitCode: number;
  /** The CMakePresets.json Conan generated for this profile, if the install succeeded. */
  readonly presetsFile?: string;
}

export function buildInstallArguments(request: ConanInstallRequest): string[] {
  const args = [
    'install', request.projectDirectory,
    '-pr:h', request.hostProfile,
    '-pr:b', request.buildProfile,
    // Put the profile name into cmake_layout's build folder and preset names
    // (e.g. build/<profile>/Release, conan-<profile>-release) so profiles don't collide.
    '-c', `tools.cmake.cmake_layout:build_folder_vars=['const.${request.hostProfile}']`,
    '-c', `tools.cmake.cmaketoolchain:generator=${request.generator ?? 'Ninja'}`,
    // CMakeUserPresets.json is written once after all profiles, so CMake Tools reloads once.
    '-c', 'tools.cmake.cmaketoolchain:user_presets=',
    // The JSON graph on stdout reports where the presets were generated.
    '--format=json',
  ];

  if (request.buildMissing ?? true) {
    args.push('--build=missing');
  }

  return args;
}

/**
 * Thin wrapper over the Conan 2 command line. Commands run in `workingDirectory` (the project
 * folder): Conan picks its home, and so its profiles, from a .conanrc in the working directory or
 * any parent before CONAN_HOME and the default ~/.conan2, so the project's own setup applies.
 */
export class ConanCli {
  constructor(readonly executable: string = 'conan', readonly workingDirectory?: string) {}

  async listProfiles(signal?: AbortSignal): Promise<string[]> {
    const result = await runProcess(this.executable, ['profile', 'list', '--format=json'], { cwd: this.workingDirectory, signal });
    if (result.exitCode !== 0) {
      throw new Error(`'conan profile list' failed with exit code ${result.exitCode}.`);
    }

    return parseProfileList(result.stdout);
  }

  /**
   * The profiles as Conan resolves them for an install (includes, templates and defaults applied),
   * as JSON text. Rejects if a profile doesn't exist or can't be parsed.
   */
  async showProfiles(hostProfile: string, buildProfile: string, signal?: AbortSignal): Promise<string> {
    const result = await runProcess(this.executable, ['profile', 'show', '-pr:h', hostProfile, '-pr:b', buildProfile, '--format=json'], { cwd: this.workingDirectory, signal });
    if (result.exitCode !== 0) {
      throw new Error(`'conan profile show' failed for profile '${hostProfile}' (exit code ${result.exitCode}).`);
    }

    return result.stdout.trim();
  }

  /** Conan's home folder (`conan config home`), which holds the profiles, as seen from `workingDirectory`. */
  async configHome(signal?: AbortSignal): Promise<string> {
    const result = await runProcess(this.executable, ['config', 'home'], { cwd: this.workingDirectory, signal });
    if (result.exitCode !== 0) {
      throw new Error(`'conan config home' failed with exit code ${result.exitCode}.`);
    }

    return result.stdout.trim();
  }

  /** Runs the install. Conan's log goes to `onLine`; the JSON graph on stdout is parsed. */
  async install(request: ConanInstallRequest, onLine: (line: string) => void, signal?: AbortSignal): Promise<ProfileInstallResult> {
    const result = await runProcess(this.executable, buildInstallArguments(request), {
      cwd: request.projectDirectory,
      onLine,
      streamStdout: false,
      signal,
    });

    const generatorsFolder = result.exitCode === 0 ? parseGeneratorsFolder(result.stdout) : undefined;
    return {
      profile: request.hostProfile,
      exitCode: result.exitCode,
      presetsFile: generatorsFolder ? path.join(generatorsFolder, 'CMakePresets.json') : undefined,
    };
  }
}

export function parseProfileList(json: string): string[] {
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Reads the consumer's (node "0") generators folder from `conan install --format=json`. */
export function parseGeneratorsFolder(json: string): string | undefined {
  try {
    const folder = JSON.parse(json)?.graph?.nodes?.['0']?.generators_folder;
    return typeof folder === 'string' ? folder : undefined;
  } catch {
    return undefined;
  }
}
