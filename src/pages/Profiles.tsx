import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import Sheet from "../components/Sheet";
import { KICKED_NOTICE_KEY } from "../components/SessionGuard";
import { useSession } from "../lib/session";
import {
  MAX_SCREEN_PASSWORD_LENGTH,
  MIN_SCREEN_PASSWORD_LENGTH,
  isRemembered,
  revokeDeviceToken,
} from "../lib/auth";
import type { ProfileAuthError, ProfileAuthResult } from "../lib/auth";
import { initials } from "../lib/profiles";
import type { ProfileMeta } from "../types";
import "../styles/profiles.css";

/**
 * The unlock result gains these two fields when the screen still holds a
 * one-time pass. Declared locally so this page compiles against both the old
 * and the updated session layer while the auth work lands in parallel.
 */
type ForcedChangeResult = ProfileAuthResult & {
  mustChange?: boolean;
  changeToken?: string;
};

/** The forced first-login completion action supplied by the session layer. */
interface ForcedChangeApi {
  completePasswordChange: (
    profileId: string,
    newPassword: string,
    changeToken: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

interface UnlockSheet {
  profile: ProfileMeta;
  /** "unlock" asks for the pass; "choose" is the forced first-login change. */
  step: "unlock" | "choose";
  password: string;
  error: string | null;
  pending: boolean;
  reveal: boolean;
  /** One-time token from unlockProfile; set only in the "choose" step. */
  changeToken: string | null;
  newPassword: string;
  confirmPassword: string;
  revealPasscode: boolean;
}

/** Server-side lockout threshold; only used to word the copy. */
const MAX_ATTEMPTS = 3;

const UNREACHABLE_MESSAGE =
  "Couldn’t reach the house server. Check the connection and try again.";
const MISSING_MESSAGE =
  "This screen has no passcode yet. Ask the admin to set one.";
const BLOCKED_MESSAGE =
  "This screen is blocked. Contact admin (the person who gave you access) to unblock it.";

/**
 * Maps an unlock failure to user-facing copy. The attempts-left sentence is
 * exact on purpose: tests assert the "2 attempts left" / "1 attempt left"
 * wording, so it must not be reworded.
 */
function unlockErrorMessage(
  error: ProfileAuthError | undefined,
  attemptsLeft: number,
): string {
  switch (error) {
    case "unreachable":
      return UNREACHABLE_MESSAGE;
    case "missing":
      return MISSING_MESSAGE;
    case "blocked":
      return BLOCKED_MESSAGE;
    case "wrong_password":
    default: {
      const left = Math.max(0, Math.min(MAX_ATTEMPTS, Math.floor(attemptsLeft)));
      return `Incorrect password. ${left} ${
        left === 1 ? "attempt" : "attempts"
      } left before this screen is blocked.`;
    }
  }
}

/** Maps a failed forced passcode change to user-facing copy. */
function forcedChangeErrorMessage(error: string | undefined): string {
  switch (error) {
    case "unreachable":
      return UNREACHABLE_MESSAGE;
    case "blocked":
      return BLOCKED_MESSAGE;
    case "wrong_password":
    case "expired":
    case "invalid_token":
      return "That one-time pass is no longer valid. Go back and try again.";
    case "same_password":
      return "Choose a passcode that’s different from the one-time pass.";
    case "weak_password":
    case "invalid_password":
      return `Passcodes need ${MIN_SCREEN_PASSWORD_LENGTH} to ${MAX_SCREEN_PASSWORD_LENGTH} characters.`;
    case "cooldown":
      return "Too many attempts. Wait a moment, then try again.";
    default:
      return error && error.trim().length > 0
        ? error
        : "Couldn’t save the new passcode. Try again.";
  }
}

const PASSCODE_RULE = `${MIN_SCREEN_PASSWORD_LENGTH}–${MAX_SCREEN_PASSWORD_LENGTH} characters.`;

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

const LockGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.6" />
    <path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9" />
  </Glyph>
);

const CheckGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size} strokeWidth={2.6}>
    <path d="m5.2 12.4 4.1 4.1L18.8 7" />
  </Glyph>
);

const ShieldGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M12 3 5 6v5.4c0 4.3 2.9 8 7 9.6 4.1-1.6 7-5.3 7-9.6V6l-7-3Z" />
    <path d="m9.5 12.1 1.7 1.7 3.5-3.6" />
  </Glyph>
);

const EyeGlyph = ({ off, size = 18 }: { off: boolean; size?: number }) => (
  <Glyph size={size}>
    <path d="M2.7 12S6.1 5.9 12 5.9 21.3 12 21.3 12 17.9 18.1 12 18.1 2.7 12 2.7 12Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="m4 4 16 16" />}
  </Glyph>
);

const ArrowGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size} strokeWidth={2.2}>
    <path d="M5 12h13" />
    <path d="m13 7 5 5-5 5" />
  </Glyph>
);

const SignOutGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5" />
    <path d="m9 8-4 4 4 4" />
    <path d="M5 12h10" />
  </Glyph>
);

const AlertGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.6v5" />
    <path d="M12 16.2h.01" />
  </Glyph>
);

const SearchGlyph = ({ size = 17 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.6 15.6 4 4" />
  </Glyph>
);

const CloseGlyph = ({ size = 15 }: { size?: number }) => (
  <Glyph size={size} strokeWidth={2.2}>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </Glyph>
);

const BeaconGlyph = ({ size = 30 }: { size?: number }) => (
  <Glyph size={size} strokeWidth={1.5}>
    <path d="M12 3v2.4" />
    <path d="m5.6 6.1 1.6 1.6" />
    <path d="m18.4 6.1-1.6 1.6" />
    <path d="M9.4 9.4h5.2l1.5 4.2H7.9l1.5-4.2Z" />
    <path d="M8.6 16.2h6.8L16.8 21H7.2l1.4-4.8Z" />
    <path d="M10.1 18.6h3.8" />
  </Glyph>
);

export default function Profiles() {
  const session = useSession();
  const {
    ready,
    profiles,
    activeProfile,
    authMap,
    unlockProfile,
    resumeProfile,
    signOut,
    syncStatus,
  } = session;
  // Supplied by the parallel session work; the cast keeps this page compiling
  // until it lands, then resolves to the identical signature.
  const { completePasswordChange } = session as typeof session & ForcedChangeApi;
  const navigate = useNavigate();

  const [sheet, setSheet] = useState<UnlockSheet | null>(null);
  const [query, setQuery] = useState("");
  const [kicked, setKicked] = useState(false);

  // SessionGuard leaves this flag before bouncing here after an admin kick.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(KICKED_NOTICE_KEY) === "1") {
        sessionStorage.removeItem(KICKED_NOTICE_KEY);
        setKicked(true);
      }
    } catch {
      /* storage disabled — no notice, but the picker still works */
    }
  }, []);

  const filteredProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter((profile) =>
      profile.name.toLowerCase().includes(needle),
    );
  }, [profiles, query]);

  const showFilter = profiles.length > 6 || query.trim().length > 0;

  /**
   * Closing the forced-change step abandons the one-time pass and returns to
   * the picker. If the session layer already made this screen active, drop it
   * so a one-time pass can never carry anyone into Home. The Sheet handles
   * Escape/backdrop dismissal, so this is the single close path.
   */
  const closeSheet = () => {
    const current = sheet;
    // A request is in flight: let it settle rather than arriving at Home
    // after an apparent cancel.
    if (current?.pending) return;
    setSheet(null);
    if (current?.step !== "choose") return;

    if (activeProfile?.id === current.profile.id) {
      // Make sure abandoning the step cannot leave this screen active.
      signOut();
    } else {
      // Also drop any device session the one-time unlock may have opened, so
      // the picker cannot silently resume past the forced change.
      void revokeDeviceToken(current.profile.id);
    }
  };

  // Lock the page behind an open sheet.
  useEffect(() => {
    if (!sheet) return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [sheet]);

  const pick = async (profile: ProfileMeta) => {
    if (activeProfile?.id === profile.id) {
      navigate("/", { replace: true });
      return;
    }
    // A remembered device skips the passcode. No token = instant false.
    if (await resumeProfile(profile.id)) {
      navigate("/", { replace: true });
      return;
    }
    setSheet({
      profile,
      step: "unlock",
      password: "",
      error: null,
      pending: false,
      reveal: false,
      changeToken: null,
      newPassword: "",
      confirmPassword: "",
      revealPasscode: false,
    });
  };

  const submitPassword = async () => {
    if (!sheet || sheet.pending) return;
    const { profile } = sheet;
    const password = sheet.password;
    if (!password) {
      setSheet((current) =>
        current ? { ...current, error: "Enter the screen password first." } : current,
      );
      return;
    }

    setSheet((current) => (current ? { ...current, pending: true, error: null } : current));

    try {
      const result = (await unlockProfile(profile.id, password)) as ForcedChangeResult;

      if (result.ok && result.mustChange) {
        // A one-time pass never enters the app: swap the sheet to the forced
        // first-login step and let the user choose their own passcode.
        if (!result.changeToken) {
          setSheet((current) =>
            current
              ? {
                  ...current,
                  pending: false,
                  password: "",
                  reveal: false,
                  error:
                    "This screen still uses a one-time pass, but no change token was issued. Ask the admin to reset it.",
                }
              : current,
          );
          return;
        }
        const changeToken = result.changeToken;
        setSheet((current) =>
          current
            ? {
                ...current,
                step: "choose",
                password: "",
                reveal: false,
                pending: false,
                error: null,
                changeToken,
                newPassword: "",
                confirmPassword: "",
                revealPasscode: false,
              }
            : current,
        );
        return;
      }

      if (result.ok) {
        setSheet(null);
        navigate("/", { replace: true });
        return;
      }

      // Never clear what the user typed when the failure is reachability.
      const keepPassword = result.error === "unreachable";
      const message = unlockErrorMessage(result.error, result.attemptsLeft);

      setSheet((current) =>
        current
          ? {
              ...current,
              password: keepPassword ? current.password : "",
              pending: false,
              reveal: keepPassword ? current.reveal : false,
              error: message,
            }
          : current,
      );
    } catch {
      // A thrown request (offline, DNS failure, timeout) is a reachability
      // problem, not a bad password: never clear what the user typed.
      setSheet((current) =>
        current ? { ...current, pending: false, error: UNREACHABLE_MESSAGE } : current,
      );
    }
  };

  /** Completes the forced first-login change, then enters Home. */
  const submitPasscode = async () => {
    if (!sheet || sheet.step !== "choose" || sheet.pending) return;
    const { profile, changeToken, newPassword, confirmPassword } = sheet;

    if (!changeToken) {
      setSheet((current) =>
        current
          ? {
              ...current,
              error: "That one-time pass can’t be completed. Go back and try again.",
            }
          : current,
      );
      return;
    }

    if (
      newPassword.length < MIN_SCREEN_PASSWORD_LENGTH ||
      newPassword.length > MAX_SCREEN_PASSWORD_LENGTH
    ) {
      setSheet((current) =>
        current
          ? {
              ...current,
              error: `Passcodes need ${MIN_SCREEN_PASSWORD_LENGTH} to ${MAX_SCREEN_PASSWORD_LENGTH} characters.`,
            }
          : current,
      );
      return;
    }

    if (newPassword !== confirmPassword) {
      setSheet((current) =>
        current ? { ...current, error: "Those passcodes don’t match." } : current,
      );
      return;
    }

    setSheet((current) =>
      current ? { ...current, pending: true, error: null } : current,
    );

    try {
      const result = await completePasswordChange(
        profile.id,
        newPassword,
        changeToken,
      );

      if (result.ok) {
        setSheet(null);
        navigate("/", { replace: true });
        return;
      }

      setSheet((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: forcedChangeErrorMessage(result.error),
            }
          : current,
      );
    } catch {
      setSheet((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: UNREACHABLE_MESSAGE,
            }
          : current,
      );
    }
  };

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark" aria-label="Loading profiles">
          L
        </div>
      </div>
    );
  }

  const blocked = sheet ? authMap[sheet.profile.id]?.blocked === true : false;
  const failedAttempts = sheet ? authMap[sheet.profile.id]?.failedAttempts ?? 0 : 0;

  return (
    <div className="page profiles-page">
      <div className="profiles-ambient" aria-hidden="true">
        <span className="profiles-ambient__glow" />
        <span className="profiles-ambient__beam" />
        <span className="profiles-ambient__horizon" />
        <span className="profiles-ambient__vignette" />
      </div>

      <header className="profiles-masthead">
        <div className="profiles-brand">
          <span className="profiles-brand-mark" aria-hidden="true">
            L
          </span>
          <span className="profiles-brand-copy">
            <span className="profiles-brand-name">LIGHTH00K</span>
            <span className="profiles-brand-kicker">Private shelf</span>
          </span>
        </div>
        <button
          type="button"
          className="profiles-admin-btn"
          onClick={() => navigate("/admin")}
        >
          <ShieldGlyph />
          Admin
        </button>
      </header>

      {kicked && (
        <div className="profiles-kicked" role="status">
          <span className="profiles-kicked__mark" aria-hidden="true">
            !
          </span>
          <p>
            Your screen was signed out by the admin. Enter your passcode to
            continue.
          </p>
          <button
            type="button"
            className="profiles-kicked__dismiss"
            aria-label="Dismiss sign-out notice"
            onClick={() => setKicked(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="profiles-hero" aria-labelledby="profiles-title">
        <p className="profiles-eyebrow">
          <span className="profiles-beacon" aria-hidden="true" />
          <span>
            {profiles.length} {profiles.length === 1 ? "screen" : "screens"}
          </span>
          <span className="profiles-eyebrow-sep" aria-hidden="true" />
          <span className="profiles-eyebrow-soft">A private shelf</span>
        </p>
        <h1 id="profiles-title" className="display profiles-title">
          Who&apos;s watching?
        </h1>
        <p className="profiles-sub">
          Every screen is here. Choose yours and enter its password.
        </p>
      </section>

      <section className="profiles-shelf" aria-label="Choose a screen">
        {profiles.length === 0 ? (
          <div className="profiles-empty">
            <span className="profiles-empty__beacon" aria-hidden="true">
              <BeaconGlyph />
            </span>
            <p className="eyebrow">The shelf is empty</p>
            <h2>No screens yet</h2>
            <p>
              This shelf is waiting for its first screen. Open admin to add one and set
              its password.
            </p>
            <button
              type="button"
              className="btn btn-primary profiles-empty__cta"
              onClick={() => navigate("/admin")}
            >
              <ShieldGlyph />
              Open admin
            </button>
          </div>
        ) : (
          <>
            {showFilter && (
              <div className="profiles-filter">
                <div className="profiles-filter__field">
                  <SearchGlyph />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a screen"
                    aria-label="Filter screens by name"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {query && (
                    <button
                      type="button"
                      className="profiles-filter__clear"
                      onClick={() => setQuery("")}
                      aria-label="Clear screen filter"
                    >
                      <CloseGlyph />
                    </button>
                  )}
                </div>
                {query.trim() && (
                  <span className="profiles-filter__count">
                    {filteredProfiles.length} of {profiles.length}
                  </span>
                )}
              </div>
            )}

            {/* Persistent live region so filtering is announced reliably;
                the visible count pill is purely decorative. */}
            <p className="sr-only" aria-live="polite">
              {query.trim()
                ? `${filteredProfiles.length} of ${profiles.length} screens match`
                : ""}
            </p>

            {filteredProfiles.length === 0 ? (
              <div className="profiles-no-match" role="status">
                <span className="profiles-no-match__icon" aria-hidden="true">
                  <SearchGlyph size={22} />
                </span>
                <p>
                  No screens match <strong>“{query.trim()}”</strong>.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setQuery("")}
                >
                  Clear filter
                </button>
              </div>
            ) : (
              <div className="profile-grid">
                {filteredProfiles.map((profile, index) => {
                  const active = activeProfile?.id === profile.id;
                  const isBlocked = authMap[profile.id]?.blocked === true;
                  return (
                    <div
                      key={profile.id}
                      className={`profile-tile${active ? " profile-tile--active" : ""}${
                        isBlocked ? " profile-tile--blocked" : ""
                      }`}
                      style={{ "--tile-index": index } as CSSProperties}
                    >
                      <button
                        type="button"
                        className="profile-tile__select"
                        onClick={() => void pick(profile)}
                        aria-label={
                          active
                            ? `Continue as ${profile.name}`
                            : isBlocked
                              ? `${profile.name} is blocked. Open for details on contacting admin.`
                              : `Unlock ${profile.name} with a password`
                        }
                      >
                        <span
                          className="profile-avatar-wrap"
                          style={{ "--profile-color": profile.color } as CSSProperties}
                        >
                          <span className="profile-halo" aria-hidden="true" />
                          <span className="avatar profile-avatar">
                            {initials(profile.name)}
                          </span>
                          <span
                            className={`profile-badge${
                              active
                                ? " profile-badge--active"
                                : isBlocked
                                  ? " profile-badge--blocked"
                                  : ""
                            }`}
                            aria-hidden="true"
                          >
                            {active ? <CheckGlyph /> : <LockGlyph />}
                          </span>
                        </span>
                        <span className="profile-tile__meta">
                          <span className="profile-name truncate" title={profile.name}>
                            {profile.name}
                          </span>
                          <span className="profile-status">
                            {active ? (
                              <>
                                Continue
                                <ArrowGlyph />
                              </>
                            ) : isBlocked ? (
                              "Blocked"
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      <footer className="profiles-foot">
        {syncStatus.error && (
          <p className="tiny profiles-sync-error" role="status">
            {syncStatus.error}
          </p>
        )}
        <p className="profiles-foot-note">
          <LockGlyph size={12} />
          Three incorrect attempts lock a screen until admin unblocks it.
        </p>
        {activeProfile && isRemembered(activeProfile.id) && (
          <p className="profiles-remembered">
            <span className="profiles-remembered-dot" aria-hidden="true" />
            This device stays signed in until you sign out.
          </p>
        )}
        <p className="profiles-build" title="Running app build">
          build {__BUILD_ID__}
        </p>
        {activeProfile && (
          <button
            type="button"
            className="btn btn-ghost profiles-signout"
            onClick={signOut}
          >
            <SignOutGlyph />
            Sign out of {activeProfile.name}
          </button>
        )}
      </footer>

      {sheet && (
        <Sheet
          key={`${sheet.profile.id}:${sheet.step}`}
          title={
            sheet.step === "choose"
              ? "Choose your passcode"
              : blocked
                ? `${sheet.profile.name} is blocked`
                : `Unlock ${sheet.profile.name}`
          }
          onClose={closeSheet}
          className="profiles-unlock-sheet"
        >
          <div
            className={`unlock-head${
              blocked && sheet.step === "unlock" ? " unlock-head--blocked" : ""
            }`}
          >
            <span
              className="unlock-avatar-wrap"
              style={{ "--profile-color": sheet.profile.color } as CSSProperties}
            >
              <span className="unlock-halo" aria-hidden="true" />
              <span className="avatar unlock-avatar">
                {initials(sheet.profile.name)}
              </span>
              {blocked && sheet.step === "unlock" && (
                <span className="unlock-avatar-badge" aria-hidden="true">
                  <LockGlyph size={13} />
                </span>
              )}
              {sheet.step === "choose" && (
                <span className="unlock-avatar-badge unlock-avatar-badge--key" aria-hidden="true">
                  <LockGlyph size={13} />
                </span>
              )}
            </span>
            <p className="eyebrow unlock-eyebrow">
              {sheet.step === "choose"
                ? "One-time pass"
                : blocked
                  ? "Screen blocked"
                  : "Password required"}
            </p>
            <h2 className="unlock-name">
              {sheet.step === "choose" ? "Choose your passcode" : sheet.profile.name}
            </h2>
            {sheet.step === "choose" ? (
              <p className="unlock-sub">
                Set a passcode you&apos;ll remember. It replaces the one-time pass
                and unlocks {sheet.profile.name} from now on.
              </p>
            ) : (
              !blocked && (
                <p className="unlock-sub">
                  Enter this screen&apos;s password to continue watching.
                </p>
              )
            )}
          </div>

          {sheet.step === "choose" ? (
            <form
              className="unlock-form unlock-passcode-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPasscode();
              }}
            >
              <label className="unlock-label" htmlFor="passcode-new">
                New passcode
              </label>
              <div
                className={`field unlock-field${
                  sheet.error ? " unlock-field--error" : ""
                }`}
              >
                <span className="unlock-field-icon" aria-hidden="true">
                  <LockGlyph size={16} />
                </span>
                <input
                  id="passcode-new"
                  type={sheet.revealPasscode ? "text" : "password"}
                  value={sheet.newPassword}
                  onChange={(event) =>
                    setSheet((current) =>
                      current
                        ? {
                            ...current,
                            newPassword: event.target.value,
                            error: null,
                          }
                        : current,
                    )
                  }
                  autoFocus
                  autoComplete="new-password"
                  enterKeyHint="next"
                  placeholder="New passcode"
                  aria-label={`New passcode for ${sheet.profile.name}`}
                  aria-invalid={sheet.error ? true : undefined}
                  spellCheck={false}
                />
              </div>

              <label className="unlock-label" htmlFor="passcode-confirm">
                Confirm passcode
              </label>
              <div
                className={`field unlock-field${
                  sheet.error ? " unlock-field--error" : ""
                }`}
              >
                <span className="unlock-field-icon" aria-hidden="true">
                  <LockGlyph size={16} />
                </span>
                <input
                  id="passcode-confirm"
                  type={sheet.revealPasscode ? "text" : "password"}
                  value={sheet.confirmPassword}
                  onChange={(event) =>
                    setSheet((current) =>
                      current
                        ? {
                            ...current,
                            confirmPassword: event.target.value,
                            error: null,
                          }
                        : current,
                    )
                  }
                  autoComplete="new-password"
                  enterKeyHint="done"
                  placeholder="Confirm passcode"
                  aria-label={`Confirm passcode for ${sheet.profile.name}`}
                  aria-invalid={sheet.error ? true : undefined}
                  spellCheck={false}
                />
              </div>

              <div className="unlock-passcode-tools">
                <span className="unlock-passcode-rule">{PASSCODE_RULE}</span>
                <button
                  type="button"
                  className="unlock-reveal-toggle"
                  onClick={() =>
                    setSheet((current) =>
                      current
                        ? { ...current, revealPasscode: !current.revealPasscode }
                        : current,
                    )
                  }
                  aria-label={sheet.revealPasscode ? "Hide passcodes" : "Show passcodes"}
                  aria-pressed={sheet.revealPasscode}
                >
                  <EyeGlyph off={sheet.revealPasscode} size={16} />
                  {sheet.revealPasscode ? "Hide" : "Show"}
                </button>
              </div>

              {sheet.error && (
                <p id="passcode-error" className="sheet-error unlock-error" role="alert">
                  <AlertGlyph />
                  <span>{sheet.error}</span>
                </p>
              )}

              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeSheet}
                  disabled={sheet.pending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    sheet.pending || !sheet.newPassword || !sheet.confirmPassword
                  }
                  aria-busy={sheet.pending}
                >
                  {sheet.pending ? "Saving…" : "Save passcode"}
                </button>
              </div>
            </form>
          ) : blocked ? (
            <>
              <div className="unlock-blocked" role="status">
                <span className="unlock-blocked-icon" aria-hidden="true">
                  <ShieldGlyph size={20} />
                </span>
                <h3>Contact admin</h3>
                <p>
                  This screen is blocked after too many incorrect password attempts.
                  Contact admin (the person who gave you access) to unblock it.
                </p>
              </div>
              <div className="unlock-attempts unlock-attempts--warn">
                <span className="unlock-pips" aria-hidden="true">
                  {[0, 1, 2].map((pip) => (
                    <span
                      key={pip}
                      className="unlock-pip unlock-pip--used"
                    />
                  ))}
                </span>
                <span className="unlock-attempts-label">3 of 3 attempts used</span>
              </div>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeSheet}
                  autoFocus
                >
                  Back to screens
                </button>
              </div>
            </>
          ) : (
            <form
              className="unlock-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPassword();
              }}
            >
              <div
                className={`field unlock-field${
                  sheet.error ? " unlock-field--error" : ""
                }`}
              >
                <span className="unlock-field-icon" aria-hidden="true">
                  <LockGlyph size={16} />
                </span>
                <input
                  type={sheet.reveal ? "text" : "password"}
                  value={sheet.password}
                  onChange={(event) =>
                    setSheet((current) =>
                      current
                        ? { ...current, password: event.target.value, error: null }
                        : current,
                    )
                  }
                  autoFocus
                  autoComplete="current-password"
                  enterKeyHint="done"
                  placeholder="Screen password"
                  aria-label={`Password for ${sheet.profile.name}`}
                  aria-invalid={sheet.error ? true : undefined}
                  aria-describedby={
                    sheet.error ? "unlock-attempts unlock-error" : "unlock-attempts"
                  }
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="unlock-reveal"
                  onClick={() =>
                    setSheet((current) =>
                      current ? { ...current, reveal: !current.reveal } : current,
                    )
                  }
                  aria-label={sheet.reveal ? "Hide password" : "Show password"}
                  aria-pressed={sheet.reveal}
                >
                  <EyeGlyph off={sheet.reveal} />
                </button>
              </div>

              <div
                id="unlock-attempts"
                className={`unlock-attempts${
                  failedAttempts > 0 ? " unlock-attempts--warn" : ""
                }`}
              >
                <span className="unlock-pips" aria-hidden="true">
                  {[0, 1, 2].map((pip) => (
                    <span
                      key={pip}
                      className={`unlock-pip${
                        pip < failedAttempts ? " unlock-pip--used" : ""
                      }`}
                    />
                  ))}
                </span>
                <span className="unlock-attempts-label">
                  {failedAttempts > 0
                    ? `${failedAttempts} of 3 attempts used`
                    : "3 attempts before this screen locks"}
                </span>
              </div>

              {sheet.error && (
                <p id="unlock-error" className="sheet-error unlock-error" role="alert">
                  <AlertGlyph />
                  <span>{sheet.error}</span>
                </p>
              )}

              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeSheet}
                  disabled={sheet.pending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={sheet.pending || !sheet.password}
                  aria-busy={sheet.pending}
                >
                  {sheet.pending ? "Checking…" : "Unlock"}
                </button>
              </div>
            </form>
          )}
        </Sheet>
      )}
    </div>
  );
}
