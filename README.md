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

On later opens, the extension compares a fingerprint of the Conan inputs (below) with the last
successful install. It runs Conan only if they differ, then configures.

### Keeping dependencies up to date

The install is out of date when any of these changes:

- `conanfile.py` or `conanfile.txt`, `conan.lock`, or `conandata.yml` in the project folder;
- the Conan home in use, from `CONAN_HOME` or a `.conanrc`;
- a selected profile, **as Conan resolves it**. The fingerprint uses `conan profile show` output,
  so editing a profile, or a profile it `include()`s, counts. Editing an unrelated profile, or
  re-saving one unchanged, doesn't.

These are checked whenever the folder opens. While it's open, the extension also watches them:
those project files, the project's `.conanrc`, and the `profiles` folder of the folder's Conan
home. A burst of changes is treated as one, about two seconds after the last. Only a real
difference counts.

When the install is out of date, a notification offers **Install Now**, or
**Always Install Automatically**, which turns on `conan.autoInstallOnChange` in your user
settings. With that setting on, the extension reinstalls straight away without asking. If files
change during an install, they're checked again once it finishes.

Conan picks its home from a `.conanrc` (`conan_home=…`) in the working directory or any parent,
before `CONAN_HOME` and `~/.conan2`. So every `conan` command runs in the project folder, and a
project-specific Conan home is honoured throughout: profile list, profile show and install.
Only a `.conanrc` in the project folder itself is watched. If one in a parent folder changes,
the next check (on reopen, or the next watched change) picks it up.

### Requirements for the consuming project

- The conanfile must use `cmake_layout` (in `[layout]` or `layout()`). The profile name is added
  to the build folder and preset names through `build_folder_vars`. Without `cmake_layout`,
  presets from different profiles would have the same name.
- The conanfile must use the `CMakeToolchain` and `CMakeDeps` generators.
- A hand-written `CMakeUserPresets.json` (one without a `vendor.conan` key) is never overwritten.

## Agents and automation

Everything the commands do can also be done without any UI, by agents and by other extensions.
There are four operations, reached three ways:

| Operation | Agent tool | Command | Skill script |
| --- | --- | --- | --- |
| Status | `conan_getStatus` | `conan.getStatus` | `getStatus` |
| List profiles | `conan_listProfiles` | `conan.listProfiles` | `listProfiles` |
| Select profiles | `conan_selectProfiles` | `conan.selectProfiles` | `selectProfiles` |
| Install | `conan_installDependencies` | `conan.installDependencies` | `installDependencies` |

### Agent skill

[`skills/vscode-conan`](skills/vscode-conan/SKILL.md) is an [Agent Skill](https://agentskills.io)
that teaches a coding agent to work with the extension. It covers adding a dependency end to end,
the rules a conanfile must follow, profiles, which files not to edit, and reading results and
hints. It tells the agent to install through the extension rather than running `conan install`
in a terminal.

- **Copilot in VS Code** gets it with the extension (through `chatSkills`, VS Code 1.109 or later),
  with no setup.
- **Claude Code** (its VS Code extension or CLI), as a plugin from this repository:

  ```
  claude plugin marketplace add snargit/vscode-conan
  claude plugin install vscode-conan@vscode-conan
  ```

  Or, in a session, `/plugin install vscode-conan --marketplace snargit/vscode-conan`.
- **Other agents**: copy `skills/vscode-conan` into the folder where the agent looks for skills.
  That is `~/.agents/skills` or a project's `.agents/skills` for Codex, and `~/.claude/skills` or
  `.claude/skills` for Claude Code without the plugin.

### Agent tools

The extension contributes these language model tools, so agents in VS Code's chat, such as
Copilot agent mode, can drive it. Each returns JSON. When the call fails, the JSON is
`{ "error": "<message>" }`, worded so the agent can correct the call and retry.

| Tool | Reference | Input | Effect |
| --- | --- | --- | --- |
| `conan_getStatus` | `#conanStatus` | `folder?` | Read-only. Returns the [status](#results). |
| `conan_listProfiles` | `#conanProfiles` | none | Read-only. Returns the output of `conan profile list`. |
| `conan_selectProfiles` | `#conanSelectProfiles` | `folder?`, `hostProfiles`, `buildProfile?` | Saves the profiles to install, checked against `conan profile list`. The first time, it also sets the CMake Tools settings described above. It doesn't install anything. Returns the status. **Asks the user to confirm.** |
| `conan_installDependencies` | `#conanInstall` | `folder?`, `force?` | Runs the installs (after any install already running for the folder), writes `CMakeUserPresets.json`, then selects a `conan-*` preset in CMake Tools and configures. Returns the [install report](#results). **Asks the user to confirm.** |

`folder` is a workspace folder's path or name. It can be left out when only one Conan CMake
project is open.

A typical agent sequence is `conan_getStatus`, then `conan_selectProfiles`, then
`conan_installDependencies`. Building is left to CMake Tools.

### Agents outside VS Code's chat

Agents that run in a terminal, such as Claude Code or Codex, can't call VS Code's tools or
commands. They use the skill's script, [`scripts/vscode-conan.mjs`](skills/vscode-conan/scripts/vscode-conan.mjs),
which needs Node.js 18 or later:

```sh
node vscode-conan.mjs getStatus [--folder <path>]
node vscode-conan.mjs listProfiles [--folder <path>]
node vscode-conan.mjs selectProfiles --host <profile> [--host <profile>...] [--build <profile>] [--folder <path>]
node vscode-conan.mjs installDependencies [--force] [--folder <path>] [--timeout <seconds>]
```

The script finds the VS Code window whose workspace folder holds `--folder` (by default the
current directory), runs the operation there, waits, and prints the result as JSON. It exits with
0 if the operation succeeded, 1 if it failed (an `error`, or an install `outcome` of
`partiallyFailed` or `userPresetsNotOwned`), and 2 if no VS Code window could be reached for the
folder. It doesn't ask the user to confirm, because the agent's own permission for running it
already covers that. The Conan output channel logs each request.

How it reaches VS Code: while `conan.allowExternalCallers` is on (the default), each window with
a Conan CMake project listens on a named pipe (Windows) or Unix socket. It describes the endpoint
in a file in a per-user folder:

| Platform | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\vscode-conan\endpoints` |
| macOS | `~/Library/Caches/vscode-conan/endpoints` |
| Linux | `$XDG_CACHE_HOME/vscode-conan/endpoints` (by default `~/.cache/...`) |

The file lists the window's Conan folders and a random token. A request must carry the token, so
only processes that can read the user's own files can use the endpoint. Those processes can
already run `conan install` themselves. The file is removed when the window closes. The next
window to start removes any file whose process has gone.

### Results

The status (`getStatus`, `selectProfiles`) has:

| Field | Meaning |
| --- | --- |
| `folder`, `folderName`, `conanfile`, `usesCmakeLayout` | The project. |
| `hostProfiles`, `buildProfile` | The selected profiles; `hostProfiles` is empty until profiles are chosen. |
| `upToDate` | The last install still matches the conanfile, `conan.lock`, `conandata.yml`, Conan home and selected profiles. |
| `installing` | An install is running for the folder. |
| `configurePresets` | The `conan-*` configure presets available to CMake Tools. |
| `availableProfiles` | The output of `conan profile list`. Missing if Conan couldn't be run; a hint says why. |
| `cmakeUsage` | See below. |
| `hints` | See below. |

The install report (`installDependencies`) has `folder`; `outcome` (`installed`, `upToDate`,
`partiallyFailed` or `userPresetsNotOwned`); `profiles`, the ones Conan ran for, each with
`profile`, `succeeded`, `exitCode` and, when it failed, `errorOutput` (the last 20 lines of
Conan's output, where it reports the error); `configurePresets`; `configuredPreset`, the preset
CMake Tools was configured with; `cmakeUsage`; and `hints`.

- **`cmakeUsage`**: for each selected host profile, the `findPackages` names and the link
  `targets` of its direct dependencies, which a `CMakeLists.txt` needs to use them. They come from
  the summary CMakeDeps prints during the install, so they're the names the recipes define. Each
  profile's are remembered from its last successful install, so an up-to-date install and the
  status have them too.

  ```json
  "cmakeUsage": { "default": { "findPackages": ["greeting"], "targets": ["greeting::greeting"] } }
  ```

- **`hints`**: what to do next, worded for the caller, and missing when there's nothing to do.
  They name the operations the way the caller reached them: `conan_installDependencies` for a
  tool, the `conan.installDependencies` command, or the script's `installDependencies`. A hint
  about the user's own files says to ask the user first.

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
| `conan.autoInstallOnChange` | `false` | Reinstall automatically when the Conan inputs change, instead of asking first. |
| `conan.allowExternalCallers` | `true` | Let agents outside VS Code's chat run the extension's operations through the skill's script (see [Agents outside VS Code's chat](#agents-outside-vs-codes-chat)). |

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
  Conan command line, `CMakeUserPresets.json` handling, the fingerprint, hints and the endpoint
  for agents outside VS Code. It's unit-tested with Node's built-in test runner.
  `src/extension.ts`, `src/controller.ts`, `src/tools.ts`, `src/externalCallers.ts`,
  `src/cmakeTools.ts` and `src/profilePicker.ts` are the VS Code layer. `skills/vscode-conan` is
  the agent skill, shipped in the `.vsix`, and `.claude-plugin` makes the repository a Claude Code
  plugin marketplace for it. The skill's script is plain JavaScript with no dependencies. It must
  stay in step with `src/core/externalEndpoint.ts`, and the unit tests run it against the
  endpoint.
- **Extension-host test:** `npm run test:host` runs `src/hostTest` inside your installed VS Code.
  It uses a throwaway profile and a scratch copy of `samples/hello-app`, and exercises the tools,
  the commands' argument forms and the skill's script end to end. It needs CMake Tools installed, a `default`
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
