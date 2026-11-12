import type { ProfileAvatarId, ProfileMeta } from "../types";
import { KEY_PROFILES, kvGet, kvSet } from "./store";

export const MAX_PROFILES = 50;

export const AVATAR_SRC: Record<ProfileAvatarId, string> = {
  ginger: "/brand/avatar-ginger.webp",
  black: "/brand/avatar-black.webp",
};

export const PROFILE_AVATARS: ReadonlyArray<{
  id: ProfileAvatarId;
  label: string;
  note: string;
}> = [
  { id: "ginger", label: "Ginger cat", note: "The house ginger" },
  { id: "black", label: "Black cat", note: "The midnight one" },
];

export const PROFILE_COLORS = [
  "#e9a05a",
  "#d97b66",
  "#c95d7a",
  "#9b7bb8",
  "#7d9b8a",
  "#6f8fb8",
  "#c9a227",
  "#a8794f",
  "#d98e3f",
  "#5f9ea0",
];

const SEEDS: ReadonlyArray<Pick<ProfileMeta, "id" | "name" | "color">> = [
  { id: "sam", name: "Sam", color: "#5f9ea0" },
  { id: "mellu", name: "Mellu", color: "#c95d7a" },
];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function colorForIndex(index: number): string {
  return PROFILE_COLORS[index % PROFILE_COLORS.length];
}

export function makeLocalProfile(
  name: string,
  color?: string,
  avatar?: ProfileAvatarId,
  avatarRing?: boolean,
): ProfileMeta {
  const now = Date.now();
  return {
    id: `${slugify(name) || "profile"}-${now.toString(36)}`,
    name: name.trim().slice(0, 24),
    color: color ?? colorForIndex(now % PROFILE_COLORS.length),
    ...(avatar ? { avatar } : {}),
    ...(avatarRing === false ? { avatarRing: false } : {}),
    createdAt: now,
  };
}

/** Reads the local index, seeding Sam + Mellu the first time the app ever runs. */
export async function loadProfiles(): Promise<ProfileMeta[]> {
  const stored = await kvGet<ProfileMeta[]>(KEY_PROFILES);
  if (Array.isArray(stored)) return stored;

  const now = Date.now();
  const seeded: ProfileMeta[] = SEEDS.map((seed) => ({ ...seed, createdAt: now }));
  await kvSet(KEY_PROFILES, seeded);
  return seeded;
}

export async function saveProfiles(profiles: ProfileMeta[]): Promise<void> {
  await kvSet(KEY_PROFILES, profiles);
}

export async function updateLocalProfile(
  id: string,
  patch: {
    name?: string;
    color?: string;
    avatar?: ProfileAvatarId | null;
    avatarRing?: boolean;
  },
): Promise<ProfileMeta[]> {
  const profiles = await loadProfiles();
  const next = profiles.map((profile) => {
    if (profile.id !== id) return profile;
    const updated: ProfileMeta = {
      ...profile,
      name: patch.name?.trim() ? patch.name.trim().slice(0, 24) : profile.name,
      color: patch.color ?? profile.color,
    };
    if (patch.avatar !== undefined) {
      if (patch.avatar === null) delete updated.avatar;
      else updated.avatar = patch.avatar;
    }
    if (patch.avatarRing !== undefined) {
      if (patch.avatarRing) delete updated.avatarRing;
      else updated.avatarRing = false;
    }
    return updated;
  });
  await saveProfiles(next);
  return next;
}

export async function removeLocalProfile(id: string): Promise<ProfileMeta[]> {
  const profiles = await loadProfiles();
  const next = profiles.filter((profile) => profile.id !== id);
  await saveProfiles(next);
  return next;
}
