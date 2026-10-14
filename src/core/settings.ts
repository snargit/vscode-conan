/** What the user chose for a folder, plus the bookkeeping the extension keeps for it. */
export interface FolderState {
  /** Host profiles to install (`-pr:h`), one install each. Empty until the user has chosen. */
  hostProfiles: string[];
  /** Build profile (`-pr:b`). */
  buildProfile: string;
  /**
   * True once the first-run prompt has been shown for this folder, whatever the user chose.
   * After that, profile changes go through the Conan commands.
   */
  firstRunPromptShown: boolean;
  /** Fingerprint of the last fully successful install. */
  installFingerprint?: string;
}

export function defaultFolderState(): FolderState {
  return { hostProfiles: [], buildProfile: 'default', firstRunPromptShown: false };
}

/** Per-folder persistence. The extension backs this with VS Code's workspaceState. */
export interface FolderStateStore {
  load(folder: string): FolderState;
  save(folder: string, state: FolderState): Promise<void>;
}

/** In-memory store, for tests. */
export class MemoryFolderStateStore implements FolderStateStore {
  private readonly states = new Map<string, FolderState>();

  load(folder: string): FolderState {
    const state = this.states.get(folder);
    return state ? structuredClone(state) : defaultFolderState();
  }

  async save(folder: string, state: FolderState): Promise<void> {
    this.states.set(folder, structuredClone(state));
  }
}
