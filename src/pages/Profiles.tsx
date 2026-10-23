import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../lib/session";
import { MAX_PROFILES, PROFILE_COLORS, initials } from "../lib/profiles";
import type { ProfileMeta } from "../types";
import "../styles/profiles.css";

const DEFAULT_ADD_COLOR = PROFILE_COLORS[2];

type SheetState =
  | { mode: "menu"; profile: ProfileMeta }
  | { mode: "rename"; profile: ProfileMeta }
  | { mode: "colour"; profile: ProfileMeta }
  | { mode: "delete"; profile: ProfileMeta }
  | { mode: "add" };

function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Move focus into the sheet, trap Tab inside it, and restore focus on close.
  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const sheet = sheetRef.current;
    const focusables = () =>
      sheet
        ? Array.from(
            sheet.querySelectorAll<HTMLElement>("input, button, [tabindex]"),
          ).filter((el) => !el.hasAttribute("disabled"))
        : [];

    const firstFocusable = focusables()[0];
    if (firstFocusable) firstFocusable.focus();
    else sheet?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && sheet?.contains(active);
      if (event.shiftKey) {
        if (active === first || !inside) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !inside) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      if (restore && restore.isConnected) restore.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Swatches({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="swatch-grid">
      {PROFILE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`swatch${color === value ? " swatch--active" : ""}`}
          style={{ "--swatch-color": color, background: color } as CSSProperties}
          aria-pressed={color === value}
          aria-label={`Colour ${color}`}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

export default function Profiles() {
  const {
    ready,
    profiles,
    activeProfile,
    chooseProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    signOut,
    syncStatus,
  } = useSession();
  const navigate = useNavigate();

  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [addName, setAddName] = useState("");
  const [addColor, setAddColor] = useState(DEFAULT_ADD_COLOR);
  const [addError, setAddError] = useState<string | null>(null);

  // Lock the page behind an open sheet and let Escape dismiss it.
  useEffect(() => {
    if (!sheet) return;
    document.body.classList.add("no-scroll");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("no-scroll");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sheet]);

  const pick = async (id: string) => {
    await chooseProfile(id);
    navigate("/", { replace: true });
  };

  const openRename = (profile: ProfileMeta) => {
    setRenameValue(profile.name);
    setSheet({ mode: "rename", profile });
  };

  const saveRename = async () => {
    if (sheet?.mode !== "rename") return;
    const name = renameValue.trim();
    if (!name) return;
    await updateProfile(sheet.profile.id, { name });
    setSheet(null);
  };

  const pickColor = async (color: string) => {
    if (sheet?.mode !== "colour") return;
    await updateProfile(sheet.profile.id, { color });
    setSheet(null);
  };

  const confirmDelete = async () => {
    if (sheet?.mode !== "delete") return;
    const id = sheet.profile.id;
    setSheet(null);
    await deleteProfile(id);
  };

  const closeAdd = () => {
    setAddName("");
    setAddColor(DEFAULT_ADD_COLOR);
    setAddError(null);
    setSheet(null);
  };

  const submitAdd = async () => {
    const result = await addProfile(addName, addColor);
    if (!result.ok) {
      setAddError(result.error); // keep the sheet open so the message is readable
      return;
    }
    setAddName("");
    setAddColor(DEFAULT_ADD_COLOR);
    setAddError(null);
    setSheet(null);
  };

  function renderSheet() {
    if (!sheet) return null;

    switch (sheet.mode) {
      case "menu": {
        const { profile } = sheet;
        return (
          <SheetShell key="menu" title={`Options for ${profile.name}`} onClose={() => setSheet(null)}>
            <h2>{profile.name}</h2>
            <div className="sheet-stack">
              <button
                type="button"
                className="btn btn-block"
                onClick={() => openRename(profile)}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn btn-block"
                onClick={() => setSheet({ mode: "colour", profile })}
              >
                Colour
              </button>
              <button
                type="button"
                className="btn btn-danger btn-block"
                onClick={() => setSheet({ mode: "delete", profile })}
              >
                Delete profile
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => setSheet(null)}
              >
                Cancel
              </button>
            </div>
          </SheetShell>
        );
      }

      case "rename": {
        const { profile } = sheet;
        return (
          <SheetShell key="rename" title="Rename profile" onClose={() => setSheet(null)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveRename();
              }}
            >
              <h2>Rename profile</h2>
              <div className="field sheet-field">
                <input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  maxLength={24}
                  placeholder="Name"
                  autoFocus
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label="Profile name"
                />
              </div>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setSheet({ mode: "menu", profile })}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!renameValue.trim()}
                >
                  Save
                </button>
              </div>
            </form>
          </SheetShell>
        );
      }

      case "colour": {
        const { profile } = sheet;
        return (
          <SheetShell key="colour" title={`Colour for ${profile.name}`} onClose={() => setSheet(null)}>
            <h2>Colour</h2>
            <p className="tiny muted sheet-note">{profile.name}</p>
            <Swatches value={profile.color} onPick={(color) => void pickColor(color)} />
            <div className="sheet-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSheet({ mode: "menu", profile })}
              >
                Back
              </button>
            </div>
          </SheetShell>
        );
      }

      case "delete": {
        const { profile } = sheet;
        return (
          <SheetShell key="delete" title={`Delete ${profile.name}?`} onClose={() => setSheet(null)}>
            <h2>Delete {profile.name}?</h2>
            <p className="muted sheet-note">
              Their watchlist and history are removed from this device and every device that
              syncs.
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSheet({ mode: "menu", profile })}
              >
                Keep profile
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void confirmDelete()}
              >
                Delete
              </button>
            </div>
          </SheetShell>
        );
      }

      case "add":
        return (
          <SheetShell key="add" title="Add profile" onClose={closeAdd}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitAdd();
              }}
            >
              <h2>Add profile</h2>
              <div className="field sheet-field">
                <input
                  value={addName}
                  onChange={(event) => {
                    setAddName(event.target.value);
                    setAddError(null);
                  }}
                  maxLength={24}
                  placeholder="Name"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label="New profile name"
                />
              </div>
              <p className="eyebrow sheet-swatch-label">Colour</p>
              <Swatches
                value={addColor}
                onPick={(color) => {
                  setAddColor(color);
                  setAddError(null);
                }}
              />
              {addError && (
                <p className="sheet-error" role="alert">
                  {addError}
                </p>
              )}
              <div className="sheet-actions">
                <button type="button" className="btn btn-ghost" onClick={closeAdd}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!addName.trim()}>
                  Create
                </button>
              </div>
            </form>
          </SheetShell>
        );
    }
  }

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark" aria-label="Loading profiles">
          L
        </div>
      </div>
    );
  }

  return (
    <div className="page profiles-page">
      <h1 className="display profiles-title">Who&apos;s watching?</h1>
      <p className="muted profiles-sub">
        Profiles keep each shelf separate. Everything syncs across your devices.
      </p>
      <p className="tiny muted profiles-meta">
        {profiles.length} / {MAX_PROFILES} profiles
      </p>
      {syncStatus.error && (
        <p className="tiny muted profiles-sync-error" role="status">
          {syncStatus.error}
        </p>
      )}

      {profiles.length === 0 && (
        <div className="empty-state profiles-empty">
          <h3>No profiles yet</h3>
          <p>Add the first profile to give this device its own shelf.</p>
        </div>
      )}

      <div className="profile-grid">
        {profiles.map((profile) => {
          const active = activeProfile?.id === profile.id;
          return (
            <div
              key={profile.id}
              className={`profile-tile${active ? " profile-tile--active" : ""}`}
            >
              <button
                type="button"
                className="profile-tile__select"
                onClick={() => void pick(profile.id)}
                aria-label={`Switch to ${profile.name}`}
              >
                <span className="profile-avatar-wrap">
                  <span
                    className="avatar profile-avatar"
                    style={{ "--profile-color": profile.color } as CSSProperties}
                  >
                    {initials(profile.name)}
                  </span>
                  {active && (
                    <span className="profile-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </span>
                <span className="profile-name truncate">{profile.name}</span>
              </button>
              <button
                type="button"
                className="icon-btn profile-menu-btn"
                aria-label={`Options for ${profile.name}`}
                onClick={() => setSheet({ mode: "menu", profile })}
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </div>
          );
        })}

        {profiles.length < MAX_PROFILES && (
          <div className="profile-tile">
            <button
              type="button"
              className="profile-tile__select profile-add"
              onClick={() => setSheet({ mode: "add" })}
              aria-label="Add profile"
            >
              <span className="profile-add__box" aria-hidden="true">
                <span className="profile-add__glyph">+</span>
              </span>
              <span className="profile-name">Add profile</span>
            </button>
          </div>
        )}
      </div>

      {activeProfile && (
        <button
          type="button"
          className="btn btn-ghost btn-block profiles-signout"
          onClick={signOut}
        >
          Sign out of {activeProfile.name}
        </button>
      )}

      {renderSheet()}
    </div>
  );
}
