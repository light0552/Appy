import type { ProfileMeta } from "../types";
import { KEY_PROFILES, kvGet, kvSet } from "./store";

export const MAX_PROFILES = 10;

export const PROFILE_COLORS = [
  "#00acc1",
  "#ff6b9d",
  "#8b5cf6",
  "#f59e0b",
  "#22c55e",
  "#ef4444",
  "#3b82f6",
  "#14b8a6",
  "#d946ef",
  "#eab308",
];

const SEEDS: ReadonlyArray<Pick<ProfileMeta, "id" | "name" | "color">> = [
  { id: "sam", name: "Sam", color: "#00acc1" },
  { id: "mellu", name: "Mellu", color: "#ff6b9d" },
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

export function makeLocalProfile(name: string, color?: string): ProfileMeta {
  const now = Date.now();
  return {
    id: `${slugify(name) || "profile"}-${now.toString(36)}`,
    name: name.trim().slice(0, 24),
    color: color ?? colorForIndex(now % PROFILE_COLORS.length),
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

export async function addLocalProfile(
  name: string,
  color?: string,
): Promise<{ ok: true; profile: ProfileMeta } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Enter a name first." };

  const profiles = await loadProfiles();
  if (profiles.length >= MAX_PROFILES) {
    return { ok: false, error: `Profile limit reached (${MAX_PROFILES}).` };
  }

  const profile = makeLocalProfile(trimmed, color);
  await saveProfiles([...profiles, profile]);
  return { ok: true, profile };
}

export async function updateLocalProfile(
  id: string,
  patch: { name?: string; color?: string },
): Promise<ProfileMeta[]> {
  const profiles = await loadProfiles();
  const next = profiles.map((profile) =>
    profile.id === id
      ? {
          ...profile,
          name: patch.name?.trim() ? patch.name.trim().slice(0, 24) : profile.name,
          color: patch.color ?? profile.color,
        }
      : profile,
  );
  await saveProfiles(next);
  return next;
}

export async function removeLocalProfile(id: string): Promise<ProfileMeta[]> {
  const profiles = await loadProfiles();
  const next = profiles.filter((profile) => profile.id !== id);
  await saveProfiles(next);
  return next;
}
