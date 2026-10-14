# Samples

A minimal setup for trying the extension by hand. It's fully local and needs no Conan remote.

| Folder | Role |
| --- | --- |
| `greeting/` | Upstream dependency: a small static library packaged as a Conan recipe (`greeting/0.1`). |
| `hello-app/` | The folder to open: `conanfile.txt` (requires `greeting/0.1`, uses `cmake_layout`) and a `CMakeLists.txt`. |

## Try it

1. Put the `greeting` recipe in your local Conan cache. This only exports the recipe; nothing is
   built yet:

   ```sh
   conan export samples/greeting
   ```

2. Open this repo in VS Code and press F5 to start an Extension Development Host. In that
   window, open `samples/hello-app` (**File > Open Folder...**).
3. A notification offers to install the Conan dependencies. Click **Choose Profiles...**, pick one
   or more host profiles, then the build profile.
4. The extension runs `conan install` for each profile. `--build=missing` builds `greeting` from
   source for each profile. The extension then writes `CMakeUserPresets.json`, selects a
   `conan-<profile>-<build type>` preset in CMake Tools, and configures.
5. Build and run `hello-app` with CMake Tools. The extension stops after configuring; building
   is CMake Tools' job:
   - **Build:** press **F7**, run **CMake: Build**, or click **Build** in the CMake Tools status
     bar or sidebar.
   - **Run:** use **CMake: Run Without Debugging** (Ctrl+Shift+F5). **CMake: Debug** (Shift+F5)
     runs it under the debugger. Both build first.
   - **F5:** this uses `hello-app/.vscode/launch.json`, which builds the CMake Tools launch
     target and then debugs it. Pick **Debug (MSVC)** on Windows, or **Debug (GDB/LLDB)** on
     Linux and macOS.

   It prints the build type of the `greeting` it linked against, e.g.
   `Hello, VsConan! (greeting Debug build)`.

## Things to check

- `hello-app/.vscode/settings.json` should now contain `"cmake.configureOnOpen": false` and
  `"cmake.useCMakePresets": "always"`.
- Reload the window. Nothing has changed, so the extension should skip the install and configure
  straight away.
- Edit `conanfile.txt` (e.g. add a blank line), then reload. The extension should reinstall
  before configuring.
- Open `samples` itself to check that the extension does nothing there: the folder has neither
  file at its root.

## Resetting

To start over, delete `hello-app/build/`, `hello-app/CMakeUserPresets.json` and
`hello-app/.vscode/`. The extension's per-folder state lives in VS Code's workspace storage; to
see the first-run notification again, open the folder via a different path (e.g. a copy) or
clear the workspace storage. To remove the package from the cache, run
`conan remove "greeting/*" -c`.
