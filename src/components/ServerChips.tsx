import { availableProviders } from "../lib/providers";
import type { MediaRef } from "../types";
import "../styles/player.css";

export interface ServerChipsProps {
  /**
   * The media to build provider URLs for. Passed as `mediaRef` because React 18
   * reserves `ref` on JSX elements and strips it from function-component props.
   */
  mediaRef?: MediaRef;
  /** Alias for the spec'd `ref` shape — only reachable when invoked as a plain function. */
  ref?: MediaRef;
  /**
   * 2026-10-24 — the Watch page's playback mode: "ripping" (sidecar resolving),
   * "owned" (ad-free Lighthook stream playing) or "embed" (iframe providers).
   * Drives the Lighthook chip's hint; provider chips are unaffected.
   */
  mode: "ripping" | "owned" | "embed";
  activeId: string | undefined;
  onSelect: (id: string) => void;
}

/**
 * One chip per provider that can address the current media, plus the
 * first-class Lighthook chip (2026-10-24) which always renders — it launches
 * the ad-free sidecar playback and needs no provider URL to exist.
 * VidFast/Vidsrc vanish automatically when imdbId is missing — no
 * special-casing needed here.
 */
export default function ServerChips({ mediaRef, ref, mode, activeId, onSelect }: ServerChipsProps) {
  const media = mediaRef ?? ref;
  if (!media) return null;

  const options = availableProviders(media);

  const lighthookActive = activeId === "lighthook";
  const lighthookHint =
    mode === "ripping" ? "Resolving…" : mode === "owned" ? "Ad-free · playing" : "Ad-free";

  return (
    <div className="chip-row server-chips" role="group" aria-label="Servers">
      <button
        type="button"
        className={`chip chip--lighthook${lighthookActive ? " chip--active" : ""}`}
        aria-pressed={lighthookActive}
        onClick={() => onSelect("lighthook")}
      >
        Lighthook
        {lighthookActive && <span className="server-chip-hint">{lighthookHint}</span>}
      </button>
      {options.map(({ provider }) => {
        const active = provider.id === activeId;
        return (
          <button
            key={provider.id}
            type="button"
            className={`chip${active ? " chip--active" : ""}`}
            aria-pressed={active}
            onClick={() => onSelect(provider.id)}
          >
            {provider.name}
            {active && <span className="server-chip-hint">{provider.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
