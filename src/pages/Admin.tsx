import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  DEFAULT_SCREEN_PASSWORD,
  MAX_FAILED_ATTEMPTS,
  credentialsFrom,
  type AdminCredential,
} from "../lib/auth";
import { MAX_PROFILES, PROFILE_COLORS, initials } from "../lib/profiles";
import { useSession } from "../lib/session";
import "../styles/admin.css";

const DEFAULT_ADD_COLOR = PROFILE_COLORS[2];

/* Inline system glyphs — no external assets, no emoji. */
const EyeIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M2.5 12s3.6-6.5 9.5-6.5S21.5 12 21.5 12s-3.6 6.5-9.5 6.5S2.5 12 2.5 12Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const EyeOffIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 4l16 16M9.9 5.7A10.8 10.8 0 0 1 12 5.5c5.9 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.1 3.8M6.2 7.3A17.4 17 0 0 0 2.5 12S6.1 18.5 12 18.5c1.1 0 2.1-.2 3-.6"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CopyIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const CheckIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ShieldIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3 5 6v5.5c0 4.4 2.9 8.1 7 9.5 4.1-1.4 7-5.1 7-9.5V6l-7-3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9.5 12.2 11.2 14l3.6-3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LockIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
  </svg>
);

const KeyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.9" />
    <path d="M10.6 10.6 20 20m-3.2-3.2 2-2m-4.8 1.8 1.7-1.7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowLeftIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PlusIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const SearchIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.9" />
    <path d="m15 15 4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

function Swatches({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="swatch-grid admin-swatches">
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

function statusLabel(credential: AdminCredential): string {
  if (credential.blocked) return "Blocked";
  if (credential.failedAttempts > 0) {
    return `${credential.failedAttempts} / ${MAX_FAILED_ATTEMPTS} attempts`;
  }
  return "Active";
}

function ScreenRow({
  credential,
  index,
  onSetPassword,
  onUnblock,
  onRemove,
  onRename,
}: {
  credential: AdminCredential;
  index: number;
  onSetPassword: (id: string, password: string) => Promise<void>;
  onUnblock: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRename: (
    id: string,
    patch: { name?: string; color?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [password, setPassword] = useState(credential.password);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(credential.name);
  const [draftColor, setDraftColor] = useState(credential.color);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    setPassword(credential.password);
  }, [credential.password]);

  useEffect(() => {
    setDraftName(credential.name);
    setDraftColor(credential.color);
  }, [credential.name, credential.color]);

  const saveRename = async () => {
    if (pending) return;
    const nextName = draftName.trim();
    if (!nextName) {
      setRenameError("A screen needs a name.");
      return;
    }
    setPending(true);
    setRenameError(null);
    try {
      const result = await onRename(credential.profileId, {
        name: nextName,
        color: draftColor,
      });
      if (!result.ok) {
        setRenameError(result.error);
        return;
      }
      setEditing(false);
    } finally {
      setPending(false);
    }
  };

  const cancelRename = () => {
    setEditing(false);
    setDraftName(credential.name);
    setDraftColor(credential.color);
    setRenameError(null);
  };

  const savePassword = async () => {
    if (!password.trim() || pending) return;
    setPending(true);
    setSaved(false);
    try {
      await onSetPassword(credential.profileId, password);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } finally {
      setPending(false);
    }
  };

  const unblock = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onUnblock(credential.profileId);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onRemove(credential.profileId);
    } finally {
      setPending(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(credential.password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard can be unavailable in private windows; the value stays visible. */
    }
  };

  const blocked = credential.blocked;
  const warning = !blocked && credential.failedAttempts > 0;

  return (
    <li className={`admin-screen${blocked ? " admin-screen--blocked" : ""}`}>
      <div className="admin-screen-identity">
        <span className="admin-screen-index" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          className="avatar admin-avatar"
          style={{ "--profile-color": credential.color } as CSSProperties}
          aria-hidden="true"
        >
          {initials(credential.name)}
        </span>
        <div className="admin-screen-id">
          <div className="admin-screen-name-row">
            <p className="admin-screen-name truncate">{credential.name}</p>
            <span
              className={`admin-status${
                blocked
                  ? " admin-status--blocked admin-blocked-badge"
                  : warning
                    ? " admin-status--warn"
                    : " admin-status--active"
              }`}
            >
              {statusLabel(credential)}
            </span>
            {!editing && (
              <button
                type="button"
                className="admin-inline-link"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${credential.name}`}
              >
                Edit
              </button>
            )}
          </div>

          {editing ? (
            <div className="admin-rename">
              <input
                className="admin-rename-input"
                value={draftName}
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveRename();
                  }
                  if (event.key === "Escape") cancelRename();
                }}
                maxLength={24}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Name for ${credential.name}`}
              />
              <Swatches value={draftColor} onPick={setDraftColor} />
              {renameError && (
                <p className="sheet-error" role="alert">
                  {renameError}
                </p>
              )}
              <div className="admin-rename-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void saveRename()}
                  disabled={pending || !draftName.trim()}
                >
                  Save details
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={cancelRename}
                  disabled={pending}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="tiny muted admin-screen-hint">
                {blocked
                  ? `Locked after ${MAX_FAILED_ATTEMPTS} failed attempts — unblock to restore access`
                  : warning
                    ? "Wrong passcodes are counting toward the auto-lock"
                    : "Ready to unlock with the passcode below"}
              </p>
              <div className="admin-strikes" aria-label={`${credential.failedAttempts} of ${MAX_FAILED_ATTEMPTS} failed attempts`}>
                {Array.from({ length: MAX_FAILED_ATTEMPTS }, (_, i) => {
                  const filled = blocked || i < credential.failedAttempts;
                  return (
                    <span
                      key={i}
                      className={`admin-strike${filled ? (blocked ? " is-blocked" : " is-on") : ""}`}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="admin-screen-password">
        <span className="admin-label">
          <span className="admin-label-glyph" aria-hidden="true">{KeyIcon}</span>
          Passcode
        </span>
        <div className="admin-password-line">
          <code className="admin-password-value">{credential.password}</code>
          <button
            type="button"
            className={`admin-copy-btn${copied ? " is-copied" : ""}`}
            aria-label={`Copy password for ${credential.name}`}
            onClick={() => void copyPassword()}
          >
            {copied ? CheckIcon : CopyIcon}
          </button>
        </div>
      </div>

      <div className="admin-screen-actions">
        <div className="admin-set-password">
          <label className="admin-label" htmlFor={`pw-${credential.profileId}`}>
            Set new passcode
          </label>
          <div className="admin-password-row">
            <input
              id={`pw-${credential.profileId}`}
              type="text"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setSaved(false);
              }}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              aria-label={`New password for ${credential.name}`}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary admin-save-btn"
              onClick={() => void savePassword()}
              disabled={pending || !password.trim()}
            >
              {pending ? "Saving…" : saved ? "Saved" : "Save"}
            </button>
          </div>
        </div>

        <div className="admin-row-buttons">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void unblock()}
            disabled={pending || !blocked}
          >
            {blocked ? "Unblock screen" : "Not blocked"}
          </button>
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void remove()}
                disabled={pending}
              >
                Confirm remove
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setConfirmRemove(false)}
                disabled={pending}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost admin-remove"
              onClick={() => setConfirmRemove(true)}
              disabled={pending}
            >
              Remove screen
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export default function Admin() {
  const {
    ready,
    profiles,
    authMap,
    adminAuthed,
    loginAdmin,
    logoutAdmin,
    adminSetProfilePassword,
    adminUnblockProfile,
    adminRenameProfile,
    adminAddProfile,
    adminDeleteProfile,
    syncStatus,
  } = useSession();
  const navigate = useNavigate();

  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [password, setPassword] = useState(DEFAULT_SCREEN_PASSWORD);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [color, setColor] = useState(DEFAULT_ADD_COLOR);
  const [addError, setAddError] = useState<string | null>(null);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);

  const [query, setQuery] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark" aria-label="Loading admin">
          L
        </div>
      </div>
    );
  }

  if (!adminAuthed) {
    return (
      <div className="page admin-page admin-page--login">
        <div className="admin-vault" aria-hidden="true">
          <span className="admin-vault__grid" />
          <span className="admin-vault__glow" />
          <span className="admin-vault__scan" />
          <span className="admin-vault__horizon" />
        </div>

        <div className="admin-console">
          <div className="admin-console-top">
            <span className="admin-console-brand">
              <span className="admin-brand-mark admin-brand-mark--console" aria-hidden="true">L</span>
              <span className="admin-console-brand-text">
                <strong>LIGHTHOOK</strong>
                <small>HOUSE ADMIN</small>
              </span>
            </span>
            <span className="admin-lock-flag">
              <span className="admin-status-dot admin-status-dot--locked" />
              LOCKED
            </span>
          </div>

          <div className="admin-vault-seal" aria-hidden="true">
            <span className="admin-seal-ring admin-seal-ring--outer" />
            <span className="admin-seal-ring admin-seal-ring--dash" />
            <span className="admin-seal-ring admin-seal-ring--inner" />
            <span className="admin-seal-core">{LockIcon}</span>
          </div>

          <div className="admin-console-intro">
            <p className="eyebrow">Secure access · authorization required</p>
            <h1 className="display admin-login-title">Control room</h1>
            <p className="muted admin-login-sub">
              Sign in to provision screens, manage passcodes, and release a locked screen.
            </p>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              const ok = loginAdmin(adminPassword);
              if (!ok) {
                setLoginError("Incorrect admin password.");
                setAdminPassword("");
                return;
              }
              setLoginError(null);
              setAdminPassword("");
            }}
          >
            <label className="admin-field-label" htmlFor="admin-password">
              Admin passcode
            </label>
            <div className="admin-input-wrap admin-login-field">
              <span className="admin-prompt" aria-hidden="true">›</span>
              <input
                id="admin-password"
                type={showAdminPassword ? "text" : "password"}
                value={adminPassword}
                onChange={(event) => {
                  setAdminPassword(event.target.value);
                  setLoginError(null);
                }}
                autoFocus
                autoComplete="current-password"
                enterKeyHint="done"
                placeholder="Enter admin passcode"
                aria-label="Admin password"
              />
              <button
                type="button"
                className="admin-input-action"
                aria-label={showAdminPassword ? "Hide admin password" : "Show admin password"}
                onClick={() => setShowAdminPassword((value) => !value)}
              >
                {showAdminPassword ? EyeOffIcon : EyeIcon}
              </button>
            </div>
            {loginError && (
              <p className="sheet-error" role="alert">
                {loginError}
              </p>
            )}
            <div className="sheet-actions admin-login-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => navigate("/profiles", { replace: true })}
              >
                {ArrowLeftIcon}
                Back to screens
              </button>
              <button type="submit" className="btn btn-primary" disabled={!adminPassword}>
                {ShieldIcon}
                Authenticate
              </button>
            </div>
          </form>

          <div className="admin-console-foot">
            <span>LH·CTRL / V1</span>
            <span>LOCAL DEVICE · ENCRYPTED SESSION</span>
          </div>
        </div>
      </div>
    );
  }

  const credentials = credentialsFrom(profiles, authMap);
  const blockedCount = credentials.filter((credential) => credential.blocked).length;
  const activeCount = credentials.length - blockedCount;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCredentials = credentials.filter((credential) => {
    if (blockedOnly && !credential.blocked) return false;
    if (!normalizedQuery) return true;
    return credential.name.toLowerCase().includes(normalizedQuery);
  });
  const filterActive = normalizedQuery.length > 0 || blockedOnly;
  const capacityPercent = Math.min(100, (credentials.length / MAX_PROFILES) * 100);

  const system = syncStatus.error
    ? { key: "fault", label: "SYNC FAULT" }
    : syncStatus.syncing
      ? { key: "syncing", label: "SYNCING" }
      : !syncStatus.online
        ? { key: "offline", label: "OFFLINE" }
        : { key: "online", label: "SYSTEM ONLINE" };

  /** Copies every screen's name and password as plain text for the family. */
  const copyAllPasswords = async () => {
    const text = credentials
      .map((credential) => `${credential.name}: ${credential.password}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1800);
    } catch {
      /* Clipboard can be unavailable in private windows. */
    }
  };

  const submitAdd = async () => {
    if (addPending) return;
    setAddError(null);
    setAddNotice(null);
    setAddPending(true);
    try {
      const result = await adminAddProfile(name, color, password);
      if (!result.ok) {
        setAddError(result.error);
        return;
      }
      setName("");
      setPassword(DEFAULT_SCREEN_PASSWORD);
      setColor(DEFAULT_ADD_COLOR);
      setAddNotice(`Added ${result.profile.name}.`);
    } finally {
      setAddPending(false);
    }
  };

  return (
    <div className="page admin-page admin-page--dash">
      <div className="admin-dash-bg" aria-hidden="true" />

      <header className="admin-masthead">
        <div className="admin-masthead-id">
          <span className="admin-brand-mark admin-brand-mark--sm" aria-hidden="true">L</span>
          <div className="admin-masthead-titles">
            <p className="eyebrow">Lighthook · house admin</p>
            <h1 className="display admin-title">Control room</h1>
            <p className="muted admin-sub">
              Only you can add or remove a screen, set a passcode, or release a lock.
            </p>
          </div>
        </div>
        <div className="admin-masthead-right">
          <span className={`admin-system-status is-${system.key}`}>
            <span className="admin-status-dot" />
            {system.label}
          </span>
          <div className="admin-head-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate("/profiles", { replace: true })}
            >
              {ArrowLeftIcon}
              Back to screens
            </button>
            <button type="button" className="btn btn-ghost" onClick={logoutAdmin}>
              {LockIcon}
              Lock admin
            </button>
          </div>
        </div>
      </header>

      {/* The global offline banner already reports sync state; the admin
          masthead carries the SYNC FAULT pill, so no duplicate inline line. */}

      <section className="admin-telemetry" aria-label="Household summary">
        <div className="admin-telemetry-head">
          <span className="eyebrow">Live telemetry</span>
          <span className="admin-mono admin-telemetry-code">
            REGISTRY / {String(credentials.length).padStart(2, "0")} UNITS
          </span>
        </div>
        <div className="admin-gauges">
          <div className="admin-gauge">
            <span className="admin-gauge-kicker">Screens</span>
            <span className="admin-gauge-value">{credentials.length}</span>
            <span className="admin-gauge-meta">registered</span>
          </div>
          <div className="admin-gauge admin-gauge--active">
            <span className="admin-gauge-kicker">Active</span>
            <span className="admin-gauge-value">{activeCount}</span>
            <span className="admin-gauge-meta">ready to watch</span>
          </div>
          <div className={`admin-gauge${blockedCount ? " admin-gauge--blocked" : ""}`}>
            <span className="admin-gauge-kicker">Blocked</span>
            <span className="admin-gauge-value">{blockedCount}</span>
            <span className="admin-gauge-meta">{blockedCount ? "need your help" : "all clear"}</span>
          </div>
        </div>
        <div className="admin-capacity">
          <span className="admin-capacity-label">CAPACITY</span>
          <div className="admin-capacity-track">
            <div className="admin-capacity-fill" style={{ width: `${capacityPercent}%` }} />
          </div>
          <span className="admin-mono admin-capacity-num">
            {credentials.length} / {MAX_PROFILES}
          </span>
        </div>
        <p className="admin-posture">
          {ShieldIcon}
          {MAX_FAILED_ATTEMPTS}-STRIKE AUTO-LOCK ENABLED · PASSCODES STORED ON THIS DEVICE
        </p>
      </section>

      <section className="admin-card admin-add-card" aria-labelledby="admin-add-title">
        <div className="admin-card-head">
          <div className="admin-card-title-wrap">
            <span className="admin-module-tag">01 / PROVISION</span>
            <h2 id="admin-add-title" className="admin-card-title">Add a screen</h2>
            <p className="tiny muted admin-card-sub">Give every person their own passcode and colour.</p>
          </div>
          <span className="admin-capacity-pill">
            <span className="admin-mono">{profiles.length} / {MAX_PROFILES}</span>
            <small>SLOTS</small>
          </span>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitAdd();
          }}
        >
          <div className="admin-add-grid">
            <label className="admin-field">
              <span className="admin-field-label">Screen name</span>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setAddError(null);
                  setAddNotice(null);
                }}
                maxLength={24}
                placeholder="e.g. Sam"
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                aria-label="New screen name"
              />
            </label>
            <label className="admin-field">
              <span className="admin-field-label">Passcode</span>
              <div className="admin-input-wrap">
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setAddError(null);
                    setAddNotice(null);
                  }}
                  maxLength={64}
                  placeholder="Screen passcode"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="New screen password"
                />
                <button
                  type="button"
                  className="admin-input-action"
                  aria-label={showNewPassword ? "Hide new password" : "Show new password"}
                  onClick={() => setShowNewPassword((value) => !value)}
                >
                  {showNewPassword ? EyeOffIcon : EyeIcon}
                </button>
              </div>
            </label>
          </div>
          <p className="eyebrow admin-swatch-label">Colour ID</p>
          <Swatches value={color} onPick={setColor} />
          {addError && (
            <p className="sheet-error" role="alert">
              {addError}
            </p>
          )}
          {addNotice && (
            <p className="tiny admin-success" role="status">
              {addNotice}
            </p>
          )}
          <div className="admin-form-foot">
            <p className="tiny muted">Only this console can change access.</p>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={addPending || !name.trim() || !password.trim()}
            >
              {PlusIcon}
              {addPending ? "Adding…" : "Add screen"}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-card admin-screens-card" aria-labelledby="admin-screens-title">
        <div className="admin-card-head">
          <div className="admin-card-title-wrap">
            <span className="admin-module-tag">02 / REGISTRY</span>
            <h2 id="admin-screens-title" className="admin-card-title">Screens</h2>
            <p className="tiny muted admin-card-sub">Passcodes are visible only in this console.</p>
          </div>
          <div className="admin-list-tools">
            <button
              type="button"
              className={`btn btn-sm btn-secondary admin-copy-all${copiedAll ? " is-copied" : ""}`}
              onClick={() => void copyAllPasswords()}
              disabled={credentials.length === 0}
            >
              {copiedAll ? CheckIcon : CopyIcon}
              {copiedAll ? "Copied" : "Copy all"}
            </button>
            <div className="admin-filter-wrap">
              <span className="admin-filter-icon" aria-hidden="true">{SearchIcon}</span>
              <input
                type="search"
                className="admin-filter"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter screens"
                aria-label="Filter screens"
                spellCheck={false}
              />
            </div>
            <button
              type="button"
              className={`chip admin-filter-chip${blockedOnly ? " chip--active" : ""}`}
              aria-pressed={blockedOnly}
              onClick={() => setBlockedOnly((value) => !value)}
            >
              Blocked only
            </button>
          </div>
        </div>

        <div className="admin-registry-meta">
          <span className="admin-mono">
            SHOWING {String(visibleCredentials.length).padStart(2, "0")} / {String(credentials.length).padStart(2, "0")}
          </span>
          <span className={`admin-mono admin-filter-flag${filterActive ? " is-active" : ""}`}>
            {filterActive ? "FILTER ACTIVE" : "ALL UNITS"}
          </span>
        </div>

        {credentials.length === 0 ? (
          <div className="empty-state admin-empty">
            <span className="admin-empty-radar" aria-hidden="true"><span /><span /><span /></span>
            <h3>No screens registered</h3>
            <p>Provision the first screen above to bring a unit online.</p>
          </div>
        ) : visibleCredentials.length === 0 ? (
          <div className="empty-state admin-empty">
            <span className="admin-empty-radar" aria-hidden="true"><span /><span /><span /></span>
            <h3>No screens match</h3>
            <p>Try a different name or clear the blocked-only filter.</p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setQuery("");
                setBlockedOnly(false);
              }}
            >
              Clear filter
            </button>
          </div>
        ) : (
          <ul className="admin-screen-list">
            {visibleCredentials.map((credential, index) => (
              <ScreenRow
                key={credential.profileId}
                credential={credential}
                index={index}
                onSetPassword={adminSetProfilePassword}
                onUnblock={adminUnblockProfile}
                onRemove={adminDeleteProfile}
                onRename={adminRenameProfile}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
