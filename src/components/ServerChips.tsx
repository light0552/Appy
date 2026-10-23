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
  activeId: string | undefined;
  onSelect: (id: string) => void;
}

/**
 * One chip per provider that can address the current media. VidFast/Vidsrc
 * vanish automatically when imdbId is missing — no special-casing needed here.
 */
export default function ServerChips({ mediaRef, ref, activeId, onSelect }: ServerChipsProps) {
  const media = mediaRef ?? ref;
  if (!media) return null;

  const options = availableProviders(media);
  if (options.length === 0) return null;

  return (
    <div className="chip-row server-chips" role="group" aria-label="Servers">
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
