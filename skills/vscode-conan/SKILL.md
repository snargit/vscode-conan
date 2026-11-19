---
name: vscode-conan
description: >-
  Use when working on a C++ CMake project open in VS Code with the "Conan for CMake Tools"
  extension, in a workspace folder whose root has a conanfile.py or conanfile.txt and a
  CMakeLists.txt: adding, removing or upgrading Conan dependencies, changing conanfile options,
  conan.lock or conandata.yml, choosing Conan profiles, installing dependencies, or when CMake Tools
  has no conan-* configure presets or configures without the Conan toolchain. Installs go through
  the extension (its conan_* tools, or this skill's script) instead of running conan install in a
  terminal.
license: MIT
---

# Conan for CMake Tools: Conan dependencies for a CMake project in VS Code

The extension installs a folder's Conan 2 dependencies once per selected Conan profile, then hands
the result to Microsoft's CMake Tools extension. It writes the `CMakeUserPresets.json` that CMake
Tools configures from, so each host profile gives `conan-<profile>-<build type>` configure presets,
such as `conan-default-release`. After an install it selects one of those presets in CMake Tools
and configures.

A `conan install` run in a terminal skips all of that. It has none of the extension's settings,
so it installs into a different build folder and adds presets CMake Tools shouldn't use, and the
extension doesn't know it happened. So **install through the extension, never with
`conan install`.**

The extension only manages a workspace folder whose root has both a conanfile and a
`CMakeLists.txt`. For anything else (a conanfile in a subfolder, say) it does nothing, and this
skill doesn't apply.

## How to run the extension's operations

| Operation | Arguments | Does |
| --- | --- | --- |
| `getStatus` | | Reports the selected profiles, the available ones, whether the install is up to date or running, the `conan-*` presets, `cmakeUsage` and `hints`. Read-only. |
| `listProfiles` | | The output of `conan profile list`. Read-only. |
| `selectProfiles` | host profiles, build profile (optional) | Saves the profiles to install for, checked against `conan profile list`. Doesn't install. |
| `installDependencies` | `force` (optional) | Installs for the selected profiles, waiting for any install already running, then has CMake Tools configure. Skips the install when nothing has changed, unless forced. |

Pick the first of these ways to run them that you have:

1. **The extension's tools**, `conan_getStatus`, `conan_listProfiles`, `conan_selectProfiles` and
   `conan_installDependencies`. Agents in VS Code's chat, such as Copilot agent mode, have them.
   VS Code may ask the user to confirm `conan_selectProfiles` and `conan_installDependencies`.
2. **This skill's script**, from a terminal on the machine VS Code's extensions run on (for a
   remote window, that's the remote machine). It needs Node.js 18 or later. Run
   `scripts/vscode-conan.mjs` in this skill's folder:

   ```sh
   node scripts/vscode-conan.mjs getStatus --folder <project folder>
   node scripts/vscode-conan.mjs selectProfiles --host default --host debug --build default --folder <project folder>
   node scripts/vscode-conan.mjs installDependencies [--force] --folder <project folder>
   ```

   `--folder` defaults to the current directory, and can be anywhere inside the workspace folder.
   The script finds the VS Code window that has the folder open, runs the operation there and
   prints the result as JSON. It exits with 0 if the operation succeeded, 1 if it failed (see
   `error`, or an install `outcome` of `partiallyFailed` or `userPresetsNotOwned`), and 2 if it
   couldn't reach VS Code: the folder isn't open in VS Code, the extension isn't installed, or the
   user turned off its `conan.allowExternalCallers` setting.
3. **Neither.** Ask the user to run **Conan: Install Dependencies** (or **Conan: Select
   Profiles...**) from VS Code's Command Palette. The outcome is in the **Conan** output channel.

## Reading results

A failed call returns `{ "error": "<message>" }`, worded so you can correct the call. Otherwise:

- **Status** (`getStatus`, `selectProfiles`): `hostProfiles`, `buildProfile`,
  `availableProfiles`, `upToDate`, `installing`, `usesCmakeLayout` and `configurePresets`.
- **Install report** (`installDependencies`): `outcome` is `installed`, `upToDate`,
  `partiallyFailed` or `userPresetsNotOwned`. It also has `profiles` (the ones Conan ran for),
  `configurePresets`, and `configuredPreset` (the preset CMake Tools configured). Each profile has
  `succeeded`, plus `errorOutput` (the end of Conan's output) when it failed.
- **`cmakeUsage`**, in either: for each selected host profile, the `findPackages` names and link
  `targets` of its direct dependencies, from its last successful install.
- **`hints`**, in either: what to do next. They name the operations the way you reach them. Follow
  them. When a hint says to ask the user, ask before doing it, because it's about the user's own
  files or settings.

## Adding or changing a dependency

1. **Find the reference.** For example, `conan search "fmt/*" -r conancenter` lists the versions.
   Searching like this, and other Conan commands that don't install into this folder, are fine to
   run in a terminal.
2. **Edit the conanfile.**
   - In `conanfile.txt`, add a line under `[requires]` (`fmt/11.0.2`), or under
     `[tool_requires]` for build tools. Set package options under `[options]`
     (`fmt/*:header_only=True`).
   - In `conanfile.py`, call `self.requires("fmt/11.0.2")` in `requirements()`, or set
     `requires`.
   - If there's a `conan.lock`, update it too: run `conan lock add --requires=fmt/11.0.2`, or
     recreate it with `conan lock create .`, both in the project folder. Otherwise the install
     fails with *Requirement ... not in lockfile*, and version ranges keep resolving to the locked
     versions.
3. **Install with `installDependencies`.** The extension notices the edit by itself. If the user
   turned on `conan.autoInstallOnChange`, it may already be installing; otherwise it asks the user
   whether to install. `installDependencies` waits for a running install, then reports.
4. **Use the dependency in `CMakeLists.txt`.** Call `find_package(<name> REQUIRED CONFIG)` and
   `target_link_libraries(<your target> PRIVATE <target>)`. Take the names from `cmakeUsage` in
   the install report or the status (`findPackages` and `targets`, per profile), not from the
   package name, because recipes often define different ones (for example, `ZLIB` and
   `ZLIB::ZLIB` for the `zlib` package). If a profile has no `cmakeUsage` entry (for example, it
   was last installed by an older version of the extension), look in its generators folder,
   `build/<profile>/<build type>/generators`:
   - every `<name>-config.cmake` or `<Name>Config.cmake` file there is a `find_package` name;
   - `conandeps_legacy.cmake` lists the targets of all direct dependencies.
5. **Build.** The install has CMake Tools configure. Build with CMake Tools (its tools, if you have
   them, or **CMake: Build**), or from a terminal with
   `cmake --build --preset <configure preset>`: Conan writes a build preset with the same name as
   each configure preset. A terminal may lack the compiler's environment (on Windows with MSVC, it
   does unless it's a developer prompt). Load the environment Conan generated first:
   `build\<profile>\<build type>\generators\conanbuild.bat` in `cmd`, or
   `source build/<profile>/<build type>/generators/conanbuild.sh` elsewhere.

To remove a dependency, delete it from both the conanfile and `CMakeLists.txt`, then install.

## Rules for the conanfile

The extension needs these. If any are missing, the hints say so. Keep them when you edit the
conanfile:

- **`cmake_layout`**: `cmake_layout(self)` in `layout()`, or `cmake_layout` under `[layout]`.
  The extension names each profile's build folder and presets through it.
- **The `CMakeToolchain` and `CMakeDeps` generators**, under `[generators]` or in `generators`
  (or `generate()`). Without CMakeToolchain there are no presets for CMake Tools.
- The presets use the Ninja generator, so Ninja must be on the PATH CMake Tools uses.

## Profiles

- Profiles live in the Conan home's `profiles` folder. To find the home, run `conan config home`
  **in the project folder**, because a `.conanrc` there can point to a project-specific home.
  `conan profile list` and `conan profile show -pr <name>` are safe to run.
- To add a profile, create a file in that folder, or run `conan profile detect --name <name>`.
  Then select it with `selectProfiles`, and install.
- Editing a selected profile (or a profile it includes) makes the install out of date, so install
  again afterwards.
- Changing which profiles are selected changes which `conan-*` presets CMake Tools offers. Ask the
  user before dropping a profile they selected.
- The selection is kept per user in VS Code's workspace storage, not in the project.

## Files that belong to the extension and Conan

Don't edit these by hand. The extension rewrites them or relies on them:

- `CMakeUserPresets.json`, when it has a `vendor.conan` key. A hand-written one is never
  overwritten, and the hints say so. It may be the user's: ask before removing it.
- The `build/<profile>/...` folders Conan generates.
- `cmake.configureOnOpen: false` and `cmake.useCMakePresets: "always"` in the folder's
  `.vscode/settings.json`. The extension sets them the first time profiles are selected, so CMake
  Tools waits for Conan instead of configuring on open. Don't revert them.

## When something's wrong

| Symptom | What to do |
| --- | --- |
| No `conan_*` tools, and the script exits with 2 | The folder isn't open in VS Code, the extension isn't installed, or `conan.allowExternalCallers` is off. Ask the user. Don't fall back to `conan install` while the extension manages the folder. |
| No profiles selected | Select profiles from `availableProfiles`, then install. |
| A profile failed (`partiallyFailed`) | Read its `errorOutput`, fix the cause in the conanfile or profile, and install again. |
| `Invalid setting` / `compiler.version` errors | The profile doesn't match an installed compiler or a valid setting. Fix the profile (ask the user if it's theirs), then install. |
| `Couldn't run Conan` | Conan 2 isn't on the PATH VS Code started with, and `conan.executable` doesn't point to it. Tell the user. |
| No `conan-*` presets after a successful install | Check the hints: usually the conanfile is missing `cmake_layout` or `CMakeToolchain`. |

For more, see the extension's README: https://github.com/snargit/vscode-conan#agents-and-automation
