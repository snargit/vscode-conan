# Conan for CMake Tools

A VS Code extension that installs [Conan 2](https://conan.io) dependencies for a C++ CMake project,
once per Conan profile. It then hands the result to Microsoft's
[CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools)
extension to configure and build. It's the VS Code counterpart of
[VsConan](https://github.com/snargit/vsconan) for Visual Studio.

## Which folders it manages

The extension only acts on a workspace folder whose root contains both:

- a `conanfile.py` or `conanfile.txt` (the only files `conan install` accepts), and
- a `CMakeLists.txt`.

Any other folder is left alone. The **Conan** commands are hidden from the Command Palette unless
a managed folder is open.

## How it works

1. The first time a managed folder opens, a notification offers to install its Conan dependencies.
   - **Choose Profiles...** opens a picker for the host profiles to install (from
     `conan profile list`; several allowed), then one for the build profile (`-pr:b`).
   - **Not now** leaves the folder to CMake Tools as usual.

   Either way, the notification isn't shown again for that folder. To change the profiles later,
   run **Conan: Select Profiles...** from the Command Palette. The choice is stored per user in
   VS Code's workspace storage, not in the project.
2. For each selected profile, the extension runs:

   ```
   conan install <folder> -pr:h <profile> -pr:b <build profile> --build=missing --format=json
         -c tools.cmake.cmake_layout:build_folder_vars=['const.<profile>']
         -c tools.cmake.cmaketoolchain:generator=Ninja
         -c tools.cmake.cmaketoolchain:user_presets=
   ```

   Output goes to the **Conan** output channel. **Conan: Install Dependencies** runs the
   installs again on demand.
3. Each install writes that profile's `CMakePresets.json`. When all profiles are done, the
   extension writes a single `CMakeUserPresets.json` that includes them, so each profile appears
   in CMake Tools as a `conan-<profile>-<build type>` configure preset.
4. If no Conan preset is selected yet, the extension selects one in CMake Tools, then runs
   **CMake: Configure**. The extension stops there.

### Building, running and debugging

These are CMake Tools' job, as in any CMake Tools project:

- **Build:** press **F7**, run **CMake: Build**, or click **Build** in the CMake Tools status bar
  or sidebar.
- **Run or debug:** use **CMake: Run Without Debugging** (Ctrl+Shift+F5) or **CMake: Debug**
  (Shift+F5). Both build first.
- **F5:** in VS Code this always runs a `launch.json` configuration, so it does nothing for a
  project without one. To make F5 build and debug, set `"program"` to
  `"${command:cmake.launchTargetPath}"`. CMake Tools builds the target when that path is resolved
  (`cmake.buildBeforeRun`, on by default). `samples/hello-app/.vscode/launch.json` is an
  example.

### Ordering: Conan runs before CMake configures

CMake Tools configures a folder as soon as it opens, and before Conan has run that configure
would have no toolchain or dependencies. So the first time you choose profiles for a folder, the
extension sets two CMake Tools settings in that folder's `.vscode/settings.json`:

| Setting | Value | Why |
| --- | --- | --- |
| `cmake.configureOnOpen` | `false` | CMake Tools doesn't configure on open; the extension configures once Conan has run. |
| `cmake.useCMakePresets` | `"always"` | With the default `"auto"`, CMake Tools decides at open time, before `CMakeUserPresets.json` exists, and falls back to kits. |

These are ordinary workspace settings, so they take effect from the very start of every later
open. The Conan output channel notes when they're written. If `.vscode/settings.json` is
committed to your repo, decide whether to commit them too.

On later opens, the extension compares a fingerprint of the conanfile, `conan.lock` and the
selected profiles with the last successful install. It runs Conan only if they differ, then
configures. Changes to the contents of Conan profiles aren't detected; run
**Conan: Install Dependencies** after editing one.

### Requirements for the consuming project

- The conanfile must use `cmake_layout` (in `[layout]` or `layout()`). The profile name is added
  to the build folder and preset names through `build_folder_vars`. Without `cmake_layout`,
  presets from different profiles would have the same name.
- The conanfile must use the `CMakeToolchain` and `CMakeDeps` generators.
- A hand-written `CMakeUserPresets.json` (one without a `vendor.conan` key) is never overwritten.

## Agents and automation

Everything the commands do can also be done without any UI, by agents and by other extensions.

### Agent tools

The extension contributes these language model tools, so agents such as Copilot agent mode can
drive it. Each returns JSON. When the call fails, the JSON is `{ "error": "<message>" }`, worded
so the agent can correct the call and retry.

| Tool | Reference | Input | Effect |
| --- | --- | --- | --- |
| `conan_getStatus` | `#conanStatus` | `folder?` | Read-only. Returns the selected host and build profiles, whether the last install is up to date, and the available `conan-*` configure presets. |
| `conan_listProfiles` | `#conanProfiles` | none | Read-only. Returns the output of `conan profile list`. |
| `conan_selectProfiles` | `#conanSelectProfiles` | `folder?`, `hostProfiles`, `buildProfile?` | Saves the profiles to install, checked against `conan profile list`. The first time, it also sets the CMake Tools settings described above. It doesn't install anything. **Asks the user to confirm.** |
| `conan_installDependencies` | `#conanInstall` | `folder?`, `force?` | Runs the installs, writes `CMakeUserPresets.json`, then selects a `conan-*` preset in CMake Tools and configures. Returns per-profile results and the configured preset. **Asks the user to confirm.** |

`folder` is a workspace folder's path or name. It can be left out when only one Conan CMake
project is open.

A typical agent sequence is `conan_getStatus`, then `conan_listProfiles`, then
`conan_selectProfiles`, then `conan_installDependencies`. Building is left to CMake Tools.

### Commands with arguments

Called without an argument, the commands are the interactive Command Palette versions. When
called with an argument object, they skip all UI and return a result. On failure they reject with
an `Error` whose message explains what to fix.

```ts
await vscode.commands.executeCommand('conan.listProfiles');                            // string[]
await vscode.commands.executeCommand('conan.getStatus', { folder: 'hello-app' });       // status
await vscode.commands.executeCommand('conan.selectProfiles', { hostProfiles: ['default', 'debug'], buildProfile: 'default' });
await vscode.commands.executeCommand('conan.installDependencies', { force: false });    // install report
```

`conan.getStatus` and `conan.listProfiles` exist only for callers that pass arguments, so they're
hidden from the Command Palette.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `conan.executable` | `conan` | The Conan 2 executable. Use a full path if Conan isn't on PATH. |

## Development

```sh
npm install
npm test          # compile, then run all tests (the integration tests need conan on PATH)
npm run package   # build the .vsix
```

- **Lockfile:** `package-lock.json` must resolve packages from `https://registry.npmjs.org/`,
  because CI can't reach private npm mirrors. CI checks this before installing. If your npm uses a
  mirror, `npm install` records the mirror's URLs. If the mirror uses the same package paths as
  npm (Artifactory npm remotes do), rewrite the prefix back to `https://registry.npmjs.org/`
  before committing. npm still installs from your mirror locally, because it maps
  `registry.npmjs.org` URLs in the lockfile to your configured registry.
- **Layout:** `src/core` is plain Node code with no `vscode` dependency: project detection, the
  Conan command line, `CMakeUserPresets.json` handling and the fingerprint. It's unit-tested
  with Node's built-in test runner. `src/extension.ts`, `src/cmakeTools.ts` and
  `src/profilePicker.ts` are the VS Code layer.
- **Extension-host test:** `npm run test:host` runs `src/hostTest` inside your installed VS Code.
  It uses a throwaway profile and a scratch copy of `samples/hello-app`, and exercises the tools
  and the commands' argument forms end to end. It needs CMake Tools installed, a `default`
  Conan profile, and `greeting/0.1` exported to the Conan cache. It opens a VS Code window while
  it runs, so CI doesn't run it.
- **Debugging:** open the repo in VS Code and press F5. The `compile` task runs the TypeScript
  compiler with `node` directly, not through a shell, so terminal and PowerShell policies don't
  affect it. VS Code then launches an Extension Development Host. Open `samples/hello-app` in it
  (see `samples/README.md`).

## Continuous integration and releases

- **`ci.yml`** builds and tests on Windows, Linux and macOS, on every push to `main` and on pull
  requests. Conan is installed so the integration tests run. The packaged `.vsix` is uploaded as
  a build artifact.
- **`release.yml`** runs when a `vMAJOR.MINOR.PATCH` tag is pushed. It sets that version in
  `package.json`, tests, packages, and creates a GitHub release with the `.vsix` attached.

```sh
git tag v0.1.0
git push origin v0.1.0
```
