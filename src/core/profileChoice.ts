export interface ProfileChoice {
  readonly hostProfiles: string[];
  readonly buildProfile: string;
}

/**
 * Checks a profile choice made without the picker (by a command argument or an agent tool)
 * against the profiles Conan knows about.
 *
 * @returns the choice with duplicate host profiles removed, or an error message.
 */
export function validateProfileChoice(
  available: readonly string[],
  hostProfiles: readonly string[],
  buildProfile: string,
): { choice: ProfileChoice } | { error: string } {
  const hosts = [...new Set(hostProfiles.map(profile => profile.trim()).filter(profile => profile.length > 0))];
  if (hosts.length === 0) {
    return { error: 'Choose at least one host profile.' };
  }

  const unknown = [...hosts, buildProfile].filter(profile => !available.includes(profile));
  if (unknown.length > 0) {
    return {
      error: `Unknown Conan profile(s): ${[...new Set(unknown)].join(', ')}. `
        + `Available profiles: ${available.length > 0 ? available.join(', ') : '(none; create one with conan profile detect)'}.`,
    };
  }

  return { choice: { hostProfiles: hosts, buildProfile } };
}
