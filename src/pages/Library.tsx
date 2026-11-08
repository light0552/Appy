import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import PosterCard from "../components/PosterCard";
import Sheet from "../components/Sheet";
import {
  MAX_SCREEN_PASSWORD_LENGTH,
  MIN_SCREEN_PASSWORD_LENGTH,
} from "../lib/auth";
import { initials } from "../lib/profiles";
import { useSession } from "../lib/session";
import { liveHistory, liveWatchlist } from "../lib/store";
import type { HistoryItem } from "../types";
import "../styles/library.css";

const TAB_KEY = "lighthook.libraryTab";

type LibraryTab = "watchlist" | "history";

/** The self-service passcode action supplied by the parallel session work. */
interface ChangePasswordResult {
  ok: boolean;
  error?: "wrong_password" | "blocked" | "cooldown" | "unreachable" | string;
  retryAt?: number;
}

interface LibrarySessionExtras {
  changePassword: (
    profileId: string,
    currentPassword: string,
    newPassword: string,
  ) => Promise<ChangePasswordResult>;
  removeHistory: (ids: string[]) => void;
}

interface PasscodeSheet {
  current: string;
  next: string;
  confirm: string;
  reveal: boolean;
  error: string | null;
  pending: boolean;
}

const PASSCODE_HINT = "One passcode change per week. Contact admin for more.";
const PASSCODE_RULE = `${MIN_SCREEN_PASSWORD_LENGTH}–${MAX_SCREEN_PASSWORD_LENGTH} characters.`;
const UNREACHABLE_MESSAGE =
  "Couldn’t reach the house server. Check the connection and try again.";
const BLOCKED_MESSAGE =
  "This screen is blocked. Contact admin to unblock it.";

/** "Try again on Jan 5 (3 days left)." — retryAt is epoch ms. */
function cooldownMessage(retryAt?: number): string {
  const base = "You can change your passcode once a week.";
  if (typeof retryAt !== "number" || !Number.isFinite(retryAt)) {
    return `${base} Try again later.`;
  }

  const date = new Date(retryAt);
  if (Number.isNaN(date.getTime())) {
    return `${base} Try again later.`;
  }

  const formatted = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const days = Math.max(0, Math.ceil((retryAt - Date.now()) / 86_400_000));
  const left =
    days > 0 ? ` (${days} ${days === 1 ? "day" : "days"} left)` : "";
  return `${base} Try again on ${formatted}${left}.`;
}

function changeErrorMessage(error: string | undefined, retryAt?: number): string {
  switch (error) {
    case "wrong_password":
      return "That current passcode is incorrect.";
    case "blocked":
      return BLOCKED_MESSAGE;
    case "unreachable":
      return UNREACHABLE_MESSAGE;
    case "cooldown":
      return cooldownMessage(retryAt);
    case "same_password":
      return "Choose a passcode that’s different from your current one.";
    case "weak_password":
    case "invalid_password":
      return `Passcodes need ${MIN_SCREEN_PASSWORD_LENGTH} to ${MAX_SCREEN_PASSWORD_LENGTH} characters.`;
    default:
      return error && error.trim().length > 0
        ? error
        : "Couldn’t change the passcode. Try again.";
  }
}

function readTab(): LibraryTab {
  try {
    return localStorage.getItem(TAB_KEY) === "history" ? "history" : "watchlist";
  } catch {
    return "watchlist"; // private mode / storage disabled
  }
}

function writeTab(tab: LibraryTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* private mode — the in-memory tab state still works */
  }
}

/** "just now", "12m ago", "3h ago", "yesterday", "5d ago". */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 60_000) return "just now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days <= 1) return "yesterday";
  return `${days}d ago`;
}

function historyHref(item: HistoryItem): string {
  if (item.mediaType === "tv") {
    const season = typeof item.season === "number" ? item.season : 1;
    const episode = typeof item.episode === "number" ? item.episode : 1;
    return `/watch/tv/${item.tmdbId}?s=${season}&e=${episode}`;
  }
  return `/watch/movie/${item.tmdbId}`;
}

function historySubtitle(item: HistoryItem): string {
  const when = relativeTime(item.watchedAt);
  if (item.mediaType === "tv") {
    if (typeof item.season === "number" && typeof item.episode === "number") {
      return `S${item.season} · E${item.episode} · ${when}`;
    }
    return `Episode · ${when}`;
  }
  return `Movie · ${when}`;
}

function Glyph({
  children,
  size = 16,
  strokeWidth = 1.8,
}: {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const KeyGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="8" cy="15.5" r="3.5" />
    <path d="m10.6 13 8-8" />
    <path d="m15.2 8.4 2.1 2.1" />
    <path d="m17.7 5.9 2.1 2.1" />
  </Glyph>
);

const LockGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.6" />
    <path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9" />
  </Glyph>
);

const EyeGlyph = ({ off, size = 16 }: { off: boolean; size?: number }) => (
  <Glyph size={size}>
    <path d="M2.7 12S6.1 5.9 12 5.9 21.3 12 21.3 12 17.9 18.1 12 18.1 2.7 12 2.7 12Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="m4 4 16 16" />}
  </Glyph>
);

const CheckGlyph = ({ size = 13 }: { size?: number }) => (
  <Glyph size={size} strokeWidth={2.8}>
    <path d="m4.8 12.4 4.3 4.3L19.2 6.8" />
  </Glyph>
);

const AlertGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.6v5" />
    <path d="M12 16.2h.01" />
  </Glyph>
);

export default function Library() {
  const session = useSession();
  const { activeProfile, state } = session;
  // Supplied by the parallel session work; the cast keeps this page compiling
  // until it lands, then resolves to the identical signatures.
  const { changePassword, removeHistory } = session as typeof session &
    LibrarySessionExtras;

  const [tab, setTab] = useState<LibraryTab>(readTab);
  const [passcodeSheet, setPasscodeSheet] = useState<PasscodeSheet | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Lock the page behind the passcode sheet.
  useEffect(() => {
    if (!passcodeSheet) return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [passcodeSheet]);

  if (!activeProfile) return null; // App's <Guard> redirects before this renders

  const watchlist = liveWatchlist(state);
  const history = liveHistory(state);

  const select = (next: LibraryTab) => {
    setTab(next);
    writeTab(next);
    if (next !== "history") {
      setSelectMode(false);
      setSelected(new Set());
      setConfirmingRemove(false);
    }
  };

  const isWatchlist = tab === "watchlist";
  const count = isWatchlist ? watchlist.length : history.length;

  /* -------------------------- history selection -------------------------- */

  const enterSelectMode = () => {
    setSelectMode(true);
    setSelected(new Set());
    setConfirmingRemove(false);
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmingRemove(false);
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmingRemove(false);
  };

  const selectAll = () => {
    setSelected(new Set(history.map((item) => item.id)));
    setConfirmingRemove(false);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setConfirmingRemove(false);
  };

  const removeSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    removeHistory(ids);
    setConfirmingRemove(false);
    setSelected(new Set());
    setSelectMode(false);
  };

  /* -------------------------- change passcode ---------------------------- */

  const openPasscodeSheet = () => {
    setPasscodeSheet({
      current: "",
      next: "",
      confirm: "",
      reveal: false,
      error: null,
      pending: false,
    });
  };

  const closePasscodeSheet = () => setPasscodeSheet(null);

  const setPasscodeField = (
    field: "current" | "next" | "confirm",
    value: string,
  ) => {
    setPasscodeSheet((current) =>
      current ? { ...current, [field]: value, error: null } : current,
    );
  };

  const submitPasscode = async () => {
    if (!passcodeSheet || passcodeSheet.pending) return;
    const { current, next, confirm } = passcodeSheet;

    if (!current) {
      setPasscodeSheet((sheet) =>
        sheet ? { ...sheet, error: "Enter your current passcode first." } : sheet,
      );
      return;
    }

    if (
      next.length < MIN_SCREEN_PASSWORD_LENGTH ||
      next.length > MAX_SCREEN_PASSWORD_LENGTH
    ) {
      setPasscodeSheet((sheet) =>
        sheet
          ? {
              ...sheet,
              error: `Passcodes need ${MIN_SCREEN_PASSWORD_LENGTH} to ${MAX_SCREEN_PASSWORD_LENGTH} characters.`,
            }
          : sheet,
      );
      return;
    }

    if (next !== confirm) {
      setPasscodeSheet((sheet) =>
        sheet ? { ...sheet, error: "Those passcodes don’t match." } : sheet,
      );
      return;
    }

    setPasscodeSheet((sheet) =>
      sheet ? { ...sheet, pending: true, error: null } : sheet,
    );

    try {
      const result = await changePassword(activeProfile.id, current, next);
      if (result.ok) {
        setPasscodeSheet(null);
        return;
      }

      setPasscodeSheet((sheet) =>
        sheet
          ? {
              ...sheet,
              pending: false,
              error: changeErrorMessage(result.error, result.retryAt),
            }
          : sheet,
      );
    } catch {
      setPasscodeSheet((sheet) =>
        sheet
          ? { ...sheet, pending: false, error: UNREACHABLE_MESSAGE }
          : sheet,
      );
    }
  };

  return (
    <div
      className="page library-page"
      style={{ "--library-color": activeProfile.color } as CSSProperties}
    >
      <header className="library-head">
        <span className="avatar library-avatar" aria-hidden="true">
          {initials(activeProfile.name)}
        </span>
        <div className="library-head-text">
          <p className="eyebrow library-eyebrow">
            <span className="library-eyebrow-dot" aria-hidden="true" />
            Library
          </p>
          <h1 className="display library-title">{activeProfile.name}</h1>
          <p className="tiny muted library-count">
            {isWatchlist
              ? `${count} saved ${count === 1 ? "title" : "titles"}`
              : `${count} ${count === 1 ? "entry" : "entries"}`}
          </p>
        </div>
        <button
          type="button"
          className="library-passcode-btn"
          onClick={openPasscodeSheet}
          aria-label={`Change passcode for ${activeProfile.name}`}
          title={PASSCODE_HINT}
        >
          <KeyGlyph />
          Change passcode
        </button>
      </header>

      <div className="segmented library-tabs">
        <button
          type="button"
          aria-pressed={isWatchlist}
          onClick={() => select("watchlist")}
        >
          Watchlist
          <span className="library-tab-count">{watchlist.length}</span>
        </button>
        <button type="button" aria-pressed={!isWatchlist} onClick={() => select("history")}>
          History
          <span className="library-tab-count">{history.length}</span>
        </button>
      </div>

      <section className="library-shelf">
        <div className="library-shelf-head">
          <h2>{isWatchlist ? "Your saved titles" : "Recently watched"}</h2>
          {!isWatchlist && history.length > 0 && (
            <div className="library-shelf-actions">
              {selectMode ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={exitSelectMode}
                >
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={enterSelectMode}
                >
                  Select
                </button>
              )}
            </div>
          )}
        </div>

        {selectMode && !isWatchlist && history.length > 0 && (
          <div className="library-select-bar" role="toolbar" aria-label="History selection">
            {confirmingRemove ? (
              <div
                className="library-select-confirm"
                role="group"
                aria-label="Confirm removal"
              >
                <p>
                  Remove {selected.size}{" "}
                  {selected.size === 1 ? "entry" : "entries"} from history? This also
                  clears {selected.size === 1 ? "it" : "them"} from Continue watching.
                </p>
                <div className="library-select-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setConfirmingRemove(false)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={removeSelected}
                    autoFocus
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <div className="library-select-row">
                <span className="library-select-count" aria-live="polite">
                  {selected.size} selected
                </span>
                <div className="library-select-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={selectAll}
                    disabled={selected.size === history.length}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={clearSelection}
                    disabled={selected.size === 0}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => setConfirmingRemove(true)}
                    disabled={selected.size === 0}
                  >
                    Remove selected ({selected.size})
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {isWatchlist ? (
          watchlist.length === 0 ? (
            <div className="empty-state library-empty">
              <span className="library-empty__icon" aria-hidden="true">
                <svg
                  width="30"
                  height="30"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" />
                </svg>
              </span>
              <h3>Nothing saved yet</h3>
              <p>Titles you save from a title page land here, on this profile only.</p>
              <Link className="btn btn-primary" to="/search">
                Find something
              </Link>
            </div>
          ) : (
            <div className="poster-grid library-grid">
              {watchlist.map((item) => (
                <PosterCard
                  key={item.id}
                  type={item.mediaType}
                  tmdbId={item.tmdbId}
                  title={item.title}
                  posterPath={item.posterPath}
                  subtitle={relativeTime(item.addedAt)}
                  to={`/title/${item.mediaType}/${item.tmdbId}`}
                />
              ))}
            </div>
          )
        ) : (
          <>
            {history.length === 0 ? (
              <div className="empty-state library-empty">
                <span className="library-empty__icon" aria-hidden="true">
                  <svg
                    width="30"
                    height="30"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M12 7.5V12l3 2" />
                  </svg>
                </span>
                <h3>No history yet</h3>
                <p>
                  Open an episode or a movie and it is saved here automatically — this is where
                  you pick it back up.
                </p>
                <Link className="btn btn-primary" to="/search">
                  Find something
                </Link>
              </div>
            ) : (
              <div className="poster-grid library-grid">
                {history.map((item) => {
                  const isSelected = selected.has(item.id);
                  return (
                    <div
                      key={item.id}
                      className={`library-select-item${
                        isSelected ? " is-selected" : ""
                      }`}
                    >
                      <PosterCard
                        type={item.mediaType}
                        tmdbId={item.tmdbId}
                        title={item.title}
                        posterPath={item.posterPath}
                        subtitle={historySubtitle(item)}
                        to={historyHref(item)}
                        onClick={
                          selectMode ? () => toggleSelected(item.id) : undefined
                        }
                      />
                      {selectMode && (
                        <label className="library-select-toggle">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelected(item.id)}
                            aria-label={`Select ${item.title}`}
                          />
                          <span className="library-select-box" aria-hidden="true">
                            {isSelected && <CheckGlyph />}
                          </span>
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {history.length > 0 && (
              <p className="tiny muted library-note">
                Picks up at the episode you opened, not at a timestamp.
              </p>
            )}
          </>
        )}
      </section>

      {passcodeSheet && (
        <Sheet
          title="Change passcode"
          onClose={closePasscodeSheet}
          className="library-sheet"
        >
          <div className="library-sheet-head">
            <span className="library-sheet-icon" aria-hidden="true">
              <KeyGlyph size={19} />
            </span>
            <div className="library-sheet-heading">
              <p className="eyebrow library-sheet-eyebrow">Screen security</p>
              <h2>Change passcode</h2>
            </div>
          </div>

          <p className="library-sheet-sub">
            Enter your current passcode, then choose a new one for{" "}
            {activeProfile.name}.
          </p>

          <form
            className="library-passcode-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPasscode();
            }}
          >
            <label className="library-field-label" htmlFor="passcode-current">
              Current passcode
            </label>
            <div
              className={`field library-field${
                passcodeSheet.error ? " library-field--error" : ""
              }`}
            >
              <span className="library-field-icon" aria-hidden="true">
                <LockGlyph size={16} />
              </span>
              <input
                id="passcode-current"
                type={passcodeSheet.reveal ? "text" : "password"}
                value={passcodeSheet.current}
                onChange={(event) => setPasscodeField("current", event.target.value)}
                autoFocus
                autoComplete="current-password"
                enterKeyHint="next"
                placeholder="Current passcode"
                aria-label={`Current passcode for ${activeProfile.name}`}
                aria-invalid={passcodeSheet.error ? true : undefined}
                spellCheck={false}
              />
            </div>

            <label className="library-field-label" htmlFor="passcode-next">
              New passcode
            </label>
            <div
              className={`field library-field${
                passcodeSheet.error ? " library-field--error" : ""
              }`}
            >
              <span className="library-field-icon" aria-hidden="true">
                <LockGlyph size={16} />
              </span>
              <input
                id="passcode-next"
                type={passcodeSheet.reveal ? "text" : "password"}
                value={passcodeSheet.next}
                onChange={(event) => setPasscodeField("next", event.target.value)}
                autoComplete="new-password"
                enterKeyHint="next"
                placeholder="New passcode"
                aria-label={`New passcode for ${activeProfile.name}`}
                aria-invalid={passcodeSheet.error ? true : undefined}
                spellCheck={false}
              />
            </div>

            <label className="library-field-label" htmlFor="passcode-confirm">
              Confirm new passcode
            </label>
            <div
              className={`field library-field${
                passcodeSheet.error ? " library-field--error" : ""
              }`}
            >
              <span className="library-field-icon" aria-hidden="true">
                <LockGlyph size={16} />
              </span>
              <input
                id="passcode-confirm"
                type={passcodeSheet.reveal ? "text" : "password"}
                value={passcodeSheet.confirm}
                onChange={(event) => setPasscodeField("confirm", event.target.value)}
                autoComplete="new-password"
                enterKeyHint="done"
                placeholder="Confirm new passcode"
                aria-label={`Confirm new passcode for ${activeProfile.name}`}
                aria-invalid={passcodeSheet.error ? true : undefined}
                spellCheck={false}
              />
            </div>

            <div className="library-passcode-tools">
              <span className="library-passcode-rule">{PASSCODE_RULE}</span>
              <button
                type="button"
                className="library-reveal-toggle"
                onClick={() =>
                  setPasscodeSheet((sheet) =>
                    sheet ? { ...sheet, reveal: !sheet.reveal } : sheet,
                  )
                }
                aria-label={passcodeSheet.reveal ? "Hide passcodes" : "Show passcodes"}
                aria-pressed={passcodeSheet.reveal}
              >
                <EyeGlyph off={passcodeSheet.reveal} />
                {passcodeSheet.reveal ? "Hide" : "Show"}
              </button>
            </div>

            <p className="library-passcode-hint">{PASSCODE_HINT}</p>

            {passcodeSheet.error && (
              <p className="sheet-error library-sheet-error" role="alert">
                <AlertGlyph />
                <span>{passcodeSheet.error}</span>
              </p>
            )}

            <div className="sheet-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closePasscodeSheet}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  passcodeSheet.pending ||
                  !passcodeSheet.current ||
                  !passcodeSheet.next ||
                  !passcodeSheet.confirm
                }
                aria-busy={passcodeSheet.pending}
              >
                {passcodeSheet.pending ? "Saving…" : "Save passcode"}
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </div>
  );
}
