import * as vscode from 'vscode';
import { FolderState } from './core/settings';

export interface ProfileChoice {
  readonly hostProfiles: string[];
  readonly buildProfile: string;
}

/**
 * Two-step picker: the host profiles to install (several allowed), then the build profile.
 * Returns undefined if the user cancels either step.
 */
export async function pickProfiles(profiles: readonly string[], current: FolderState, folderName: string): Promise<ProfileChoice | undefined> {
  const title = `Conan profiles for ${folderName}`;

  const hostItems = profiles.map(profile => ({ label: profile, picked: current.hostProfiles.includes(profile) }));
  const hosts = await vscode.window.showQuickPick(hostItems, {
    title: `${title} (1/2)`,
    placeHolder: 'Install dependencies for these host profiles (-pr:h)',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!hosts || hosts.length === 0) {
    return undefined;
  }

  const buildOrder = profiles.includes(current.buildProfile)
    ? [current.buildProfile, ...profiles.filter(profile => profile !== current.buildProfile)]
    : [...profiles];
  const build = await vscode.window.showQuickPick(
    buildOrder.map(profile => ({ label: profile, description: profile === current.buildProfile ? 'current' : undefined })),
    {
      title: `${title} (2/2)`,
      placeHolder: 'Build profile (-pr:b)',
      ignoreFocusOut: true,
    });
  if (!build) {
    return undefined;
  }

  return { hostProfiles: hosts.map(item => item.label), buildProfile: build.label };
}
