import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import ProfileAvatar from "../components/ProfileAvatar";
import {
  DEFAULT_SCREEN_PASSWORD,
  MAX_FAILED_ATTEMPTS,
  MAX_SCREEN_PASSWORD_LENGTH,
  MIN_SCREEN_PASSWORD_LENGTH,
  credentialsFrom,
  type AdminCredential,
} from "../lib/auth";
import {
  MAX_PROFILES,
  PROFILE_AVATARS,
  PROFILE_COLORS,
} from "../lib/profiles";
import { useSession } from "../lib/session";
import type { ProfileAvatarId } from "../types";
import "../styles/admin.css";
import "../styles/admin-look.css";

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
  const safeValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#e9a05a";
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
      <label
        className="swatch swatch--custom"
        style={{ "--swatch-color": safeValue, background: safeValue } as CSSProperties}
        title="Custom colour"
      >
        <input
          type="color"
          value={safeValue}
          onChange={(event) => onPick(event.target.value)}
          aria-label="Custom colour"
        />
        <span aria-hidden="true">+</span>
      </label>
    </div>
  );
}

function LookPicker({
  name,
  color,
  avatar,
  ring,
  onPick,
  onColor,
  onRing,
}: {
  name: string;
  color: string;
  avatar: ProfileAvatarId | null;
  ring: boolean;
  onPick: (avatar: ProfileAvatarId | null) => void;
  onColor: (color: string) => void;
  onRing: (ring: boolean) => void;
}) {
  const options: ReadonlyArray<{
    id: ProfileAvatarId | null;
    label: string;
    note: string;
  }> = [
    { id: null, label: "Colour", note: "Initials" },
    ...PROFILE_AVATARS,
  ];

  return (
    <div className="admin-look">
      <p className="eyebrow admin-swatch-label">Screen look</p>
      <div className="admin-look-grid" role="group" aria-label="Screen look">
        {options.map((option) => {
          const active = avatar === option.id;
          return (
            <button
              key={option.id ?? "colour"}
              type="button"
              className={`admin-look-option${active ? " is-active" : ""}`}
              aria-pressed={active}
              aria-label={`${option.label} look`}
              onClick={() => onPick(option.id)}
            >
              <ProfileAvatar
                name={name || "?"}
                color={color}
                avatar={option.id ?? undefined}
                ring={ring}
                className="admin-look-avatar"
              />
              <span className="admin-look-copy">
                <strong>{option.label}</strong>
                <small>{option.note}</small>
              </span>
            </button>
          );
        })}
      </div>
      {avatar === null ? (
        <div className="admin-look-colour">
          <Swatches value={color} onPick={onColor} />
          <p className="tiny muted admin-look-hint">
            Any colour works — pick a swatch or open the custom wheel.
          </p>
        </div>
      ) : (
        <p className="tiny muted admin-look-hint">
          The screen colour can rim the photo, or stay off completely.
        </p>
      )}
      {avatar !== null && (
        <label className="admin-ring-check">
          <input
            type="checkbox"
            checked={ring}
            onChange={(event) => onRing(event.target.checked)}
            aria-label="Show colour ring and glow"
          />
          <span>
            <strong>Colour ring &amp; glow</strong>
            <small>Turn off for a completely clean photo.</small>
          </span>
        </label>
      )}
    </div>
  );
}

function statusLabel(credential: AdminCredential): string {
  if (credential.blocked) return "Blocked";
  if (credential.expired) return "Expired";
  if (credential.failedAttempts > 0) {
    return `${credential.failedAttempts} / ${MAX_FAILED_ATTEMPTS} attempts`;
  }
  return "Active";
}

/** Access-duration presets for the add form and row editor. */
type AccessPreset = "none" | "1d" | "1w" | "1m" | "custom";

const ACCESS_PRESETS: ReadonlyArray<{ id: AccessPreset; label: string; days: number | null }> = [
  { id: "none", label: "No expiry", days: null },
  { id: "1d", label: "1 day", days: 1 },
  { id: "1w", label: "1 week", days: 7 },
  { id: "1m", label: "1 month", days: 30 },
  { id: "custom", label: "Custom days", days: null },
];

const MAX_ACCESS_DAYS = 3650;

/** Whole days for a preset ("invalid" when the custom field is not usable). */
function daysFromPreset(
  preset: AccessPreset,
  custom: string,
): number | null | "invalid" {
  if (preset === "custom") {
    const days = Number(custom);
    if (!Number.isInteger(days) || days < 1 || days > MAX_ACCESS_DAYS) return "invalid";
    return days;
  }
  return ACCESS_PRESETS.find((entry) => entry.id === preset)?.days ?? null;
}

function formatExpiryDate(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Local-date wording plus a days-remaining line for the registry row. */
function expiryView(credential: AdminCredential): {
  tone: "none" | "active" | "expired";
  date: string;
  detail: string;
  headline: string;
} {
  if (credential.expiresAt === undefined) {
    return {
      tone: "none",
      date: "",
      headline: "No expiry",
      detail: "Access stays open until an admin sets a window.",
    };
  }
  const date = formatExpiryDate(credential.expiresAt);
  if (credential.expired) {
    return {
      tone: "expired",
      date,
      headline: `Expired ${date}`,
      detail: "Extend the window to restore this screen's access.",
    };
  }
  const days = Math.max(
    1,
    Math.ceil((credential.expiresAt - Date.now()) / 86_400_000),
  );
  return {
    tone: "active",
    date,
    headline: `Until ${date}`,
    detail: `Expires in ${days} ${days === 1 ? "day" : "days"}.`,
  };
}

/**
 * Turns a thrown admin action into a short line the console can show.
 * Transport failures get a plain-language message; anything else keeps its
 * own text when it looks presentable, and otherwise falls back.
 */
function failureText(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      switch (code) {
        case "invalid_password":
          return `Passcodes need ${MIN_SCREEN_PASSWORD_LENGTH} to ${MAX_SCREEN_PASSWORD_LENGTH} characters.`;
        case "invalid_expiry":
          return "Access must be a whole number of days greater than zero.";
        case "admin_required":
          return "Admin sign-in expired. Lock admin and sign in again.";
        case "not_found":
          return "That screen is no longer on the server.";
        case "profile_limit":
          return "The screen limit is already reached.";
        case "forbidden":
          return "The household key was rejected.";
        default:
          break;
      }
    }
    const message = error.message.trim();
    if (/fetch|network|unreachable|offline|timeout/i.test(message)) {
      return "Can't reach the server. Try again.";
    }
    if (message && message.length <= 140) return message;
  }
  return fallback;
}

function ScreenRow({
  credential,
  index,
  selected,
  onToggleSelect,
  onSetPassword,
  onUnblock,
  onSetExpiry,
  onRemove,
  onKick,
  onRename,
}: {
  credential: AdminCredential;
  index: number;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onSetPassword: (id: string, password: string, temporary?: boolean) => Promise<void>;
  onUnblock: (id: string) => Promise<void>;
  onSetExpiry: (
    id: string,
    options: { days?: number; extend?: boolean; clear?: boolean },
  ) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onKick: (id: string) => Promise<void>;
  onRename: (
    id: string,
    patch: {
      name?: string;
      color?: string;
      avatar?: ProfileAvatarId | null;
      avatarRing?: boolean;
      adminName?: string;
    },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(credential.name);
  const [draftColor, setDraftColor] = useState(credential.color);
  const [draftAvatar, setDraftAvatar] = useState<ProfileAvatarId | null>(
    credential.avatar ?? null,
  );
  const [draftRing, setDraftRing] = useState(credential.avatarRing !== false);
  const [draftAdminName, setDraftAdminName] = useState(credential.adminName ?? "");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState("7");

  useEffect(() => {
    setDraftName(credential.name);
    setDraftColor(credential.color);
    setDraftAvatar(credential.avatar ?? null);
    setDraftRing(credential.avatarRing !== false);
    setDraftAdminName(credential.adminName ?? "");
  }, [
    credential.name,
    credential.color,
    credential.avatar,
    credential.avatarRing,
    credential.adminName,
  ]);

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
        avatar: draftAvatar,
        avatarRing: draftRing,
        adminName: draftAdminName.trim(),
      });
      if (!result.ok) {
        setRenameError(result.error);
        return;
      }
      setEditing(false);
    } catch (error) {
      setRenameError(failureText(error, "Couldn't rename that screen."));
    } finally {
      setPending(false);
    }
  };

  const cancelRename = () => {
    setEditing(false);
    setDraftName(credential.name);
    setDraftColor(credential.color);
    setDraftAvatar(credential.avatar ?? null);
    setDraftRing(credential.avatarRing !== false);
    setDraftAdminName(credential.adminName ?? "");
    setRenameError(null);
  };

  const savePassword = async () => {
    if (!password.trim() || pending) return;
    setPending(true);
    setSaved(false);
    setActionError(null);
    try {
      await onSetPassword(credential.profileId, password, temporary);
      setPassword("");
      setTemporary(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (error) {
      setActionError(failureText(error, "Couldn't save that passcode."));
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

  const unblock = async () => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onUnblock(credential.profileId);
    } catch (error) {
      setActionError(failureText(error, "Couldn't unblock that screen."));
    } finally {
      setPending(false);
    }
  };

  const updateExpiry = async (options: {
    days?: number;
    extend?: boolean;
    clear?: boolean;
  }) => {
    if (pending) return;
    if (
      options.days !== undefined &&
      (!Number.isInteger(options.days) || options.days < 1)
    ) {
      setActionError("Enter a whole number of days greater than zero.");
      return;
    }
    setPending(true);
    setActionError(null);
    try {
      await onSetExpiry(credential.profileId, options);
    } catch (error) {
      setActionError(failureText(error, "Couldn't update that access window."));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onRemove(credential.profileId);
    } catch (error) {
      setActionError(failureText(error, "Couldn't remove that screen."));
    } finally {
      setPending(false);
    }
  };

  const kick = async () => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onKick(credential.profileId);
      setConfirmKick(false);
    } catch (error) {
      setActionError(failureText(error, "Couldn't kick that session."));
    } finally {
      setPending(false);
    }
  };

  const blocked = credential.blocked;
  const warning = !blocked && credential.failedAttempts > 0;
  const expiry = expiryView(credential);
  const parsedExpiryDays = Number(expiryDays);
  const expiryDaysValid =
    Number.isInteger(parsedExpiryDays) &&
    parsedExpiryDays >= 1 &&
    parsedExpiryDays <= MAX_ACCESS_DAYS;

  return (
    <li
      className={`admin-screen${blocked ? " admin-screen--blocked" : ""}${
        selected ? " is-selected" : ""
      }`}
    >
      <div className="admin-screen-identity">
        <label className="admin-select-box">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(credential.profileId)}
            aria-label={`Select ${credential.name}`}
          />
        </label>
        <span className="admin-screen-index" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <ProfileAvatar
          name={editing ? draftName : credential.name}
          color={editing ? draftColor : credential.color}
          avatar={editing ? (draftAvatar ?? undefined) : credential.avatar}
          ring={editing ? draftRing : credential.avatarRing !== false}
          className="admin-avatar"
        />
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
            {credential.expired && (
              <span className="admin-onetime-badge admin-expired-badge">Access expired</span>
            )}
            {credential.mustChange && (
              <span className="admin-onetime-badge">One-time · change pending</span>
            )}
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
              <input
                className="admin-rename-input admin-rename-ref"
                value={draftAdminName}
                onChange={(event) => {
                  setDraftAdminName(event.target.value);
                  setRenameError(null);
                }}
                maxLength={24}
                placeholder="Admin ref (optional)"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Admin ref name for ${credential.name}`}
              />
              <LookPicker
                name={draftName}
                color={draftColor}
                avatar={draftAvatar}
                ring={draftRing}
                onPick={(next) => {
                  setDraftAvatar(next);
                  setRenameError(null);
                }}
                onColor={(next) => {
                  setDraftColor(next);
                  setRenameError(null);
                }}
                onRing={(next) => {
                  setDraftRing(next);
                  setRenameError(null);
                }}
              />
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
                  : credential.expired
                    ? "Access window ended — extend it to restore this screen"
                    : warning
                      ? "Wrong passcodes are counting toward the auto-lock"
                      : "Ready to unlock with its household passcode"}
              </p>
              {credential.adminName && (
                <p className="admin-ref">ref: {credential.adminName}</p>
              )}
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
          <code
            className={`admin-password-value${credential.password ? "" : " is-unset"}`}
            aria-label={
              credential.password
                ? `Passcode for ${credential.name}`
                : `No passcode could be read for ${credential.name}`
            }
          >
            {credential.password || "Unavailable"}
          </code>
          {credential.password && (
            <button
              type="button"
              className={`admin-copy-btn${copied ? " is-copied" : ""}`}
              aria-label={`Copy password for ${credential.name}`}
              onClick={() => void copyPassword()}
            >
              {copied ? CheckIcon : CopyIcon}
            </button>
          )}
        </div>
        <p className={`admin-password-note${credential.hasPassword ? "" : " is-unset"}`}>
          <span className="admin-password-note-dot" aria-hidden="true" />
          {credential.hasPassword ? "Stored on server" : "No passcode on server"}
        </p>
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
                setActionError(null);
              }}
              maxLength={64}
              placeholder="Enter a new passcode"
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
          <label className="admin-check admin-check--one-time">
            <input
              type="checkbox"
              checked={temporary}
              onChange={(event) => {
                setTemporary(event.target.checked);
                setSaved(false);
              }}
              aria-label={`One-time passcode for ${credential.name}`}
            />
            <span>One-time · require change on next unlock</span>
          </label>
        </div>

        <div className={`admin-expiry is-${expiry.tone}`}>
          <span className="admin-label">Access</span>
          <p className="admin-expiry-state">{expiry.headline}</p>
          <p className="admin-expiry-detail">{expiry.detail}</p>
          <div className="admin-expiry-row">
            <input
              type="number"
              min={1}
              max={MAX_ACCESS_DAYS}
              step={1}
              inputMode="numeric"
              className="admin-expiry-days"
              value={expiryDays}
              onChange={(event) => {
                setExpiryDays(event.target.value);
                setActionError(null);
              }}
              aria-label={`Access days for ${credential.name}`}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() =>
                void updateExpiry({ days: parsedExpiryDays, extend: true })
              }
              disabled={pending || !expiryDaysValid}
            >
              Extend
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void updateExpiry({ days: parsedExpiryDays })}
              disabled={pending || !expiryDaysValid}
            >
              Reset
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost admin-expiry-clear"
            onClick={() => void updateExpiry({ clear: true })}
            disabled={pending || expiry.tone === "none"}
          >
            No expiry
          </button>
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
          {confirmKick ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void kick()}
                disabled={pending}
              >
                Confirm kick
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setConfirmKick(false)}
                disabled={pending}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost admin-kick"
              onClick={() => setConfirmKick(true)}
              disabled={pending}
            >
              Kick session
            </button>
          )}
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
        {actionError && (
          <p className="sheet-error" role="alert">
            {actionError}
          </p>
        )}
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
    adminSetScreenExpiry,
    adminRenameProfile,
    adminAddProfile,
    adminDeleteProfile,
    adminKickProfiles,
    syncStatus,
  } = useSession();
  const navigate = useNavigate();

  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);

  const [name, setName] = useState("");
  const [password, setPassword] = useState(DEFAULT_SCREEN_PASSWORD);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [color, setColor] = useState(DEFAULT_ADD_COLOR);
  const [avatar, setAvatar] = useState<ProfileAvatarId | null>(null);
  const [avatarRing, setAvatarRing] = useState(true);
  const [adminName, setAdminName] = useState("");
  const [temporaryNew, setTemporaryNew] = useState(false);
  const [accessPreset, setAccessPreset] = useState<AccessPreset>("none");
  const [customDays, setCustomDays] = useState("14");
  const [addError, setAddError] = useState<string | null>(null);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);

  const [query, setQuery] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [copiedNames, setCopiedNames] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [kickPending, setKickPending] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark" aria-label="Loading admin">
          <img src="/brand/lighthook-cat.jpg" alt="" />
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
              <span className="admin-brand-mark admin-brand-mark--console" aria-hidden="true">
                <img src="/brand/lighthook-cat.jpg" alt="" />
              </span>
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
            <span className="admin-seal-cat">
              <img src="/brand/lighthook-cat.jpg" alt="" />
            </span>
          </div>

          <div className="admin-console-intro">
            <p className="eyebrow">Secure access · authorization required</p>
            <h1 className="display admin-login-title">Control room</h1>
            <p className="muted admin-login-sub">
              Sign in to provision screens, manage passcodes, and release a locked screen.
            </p>
          </div>

          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (loginPending || !adminPassword) return;
              setLoginPending(true);
              setLoginError(null);
              try {
                const ok = await loginAdmin(adminPassword);
                if (!ok) {
                  setLoginError(
                    navigator.onLine === false
                      ? "You're offline. Check the connection and try again."
                      : "Incorrect admin password.",
                  );
                  setAdminPassword("");
                  return;
                }
                setAdminPassword("");
              } catch (error) {
                setLoginError(failureText(error, "Couldn't sign in. Try again."));
              } finally {
                setLoginPending(false);
              }
            }}
          >
            <label className="admin-field-label" htmlFor="admin-password">
              Admin passcode
            </label>
            <div className="admin-input-wrap admin-login-field">
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
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!adminPassword || loginPending}
                aria-busy={loginPending}
              >
                {ShieldIcon}
                {loginPending ? "Authenticating…" : "Authenticate"}
              </button>
            </div>
          </form>

          <div className="admin-console-foot">
            <span>LH·CTRL / V1</span>
            <span>SERVER VERIFIED · HASHED PASSCODES</span>
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

  const visibleIds = visibleCredentials.map((credential) => credential.profileId);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelect = (id: string) => {
    setKickError(null);
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  };

  const selectAllVisible = () => {
    setKickError(null);
    setSelectedIds((previous) => Array.from(new Set([...previous, ...visibleIds])));
  };

  const clearSelection = () => {
    setKickError(null);
    setSelectedIds([]);
  };

  const kickSelected = async () => {
    if (kickPending || selectedIds.length === 0) return;
    const ids = [...selectedIds];
    setKickPending(true);
    setKickError(null);
    try {
      await adminKickProfiles(ids);
      setSelectedIds([]);
    } catch (error) {
      setKickError(failureText(error, "Couldn't kick those sessions."));
    } finally {
      setKickPending(false);
    }
  };

  const system = syncStatus.error
    ? { key: "fault", label: "SYNC FAULT" }
    : syncStatus.syncing
      ? { key: "syncing", label: "SYNCING" }
      : !syncStatus.online
        ? { key: "offline", label: "OFFLINE" }
        : { key: "online", label: "SYSTEM ONLINE" };

  /** Copies every registered screen name, one per line. */
  const copyAllPasscodes = async () => {
    const text = credentials
      .map((credential) => `${credential.name}: ${credential.password || "unavailable"}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedNames(true);
      window.setTimeout(() => setCopiedNames(false), 1800);
    } catch {
      /* Clipboard can be unavailable in private windows. */
    }
  };

  const submitAdd = async () => {
    if (addPending) return;
    setAddError(null);
    setAddNotice(null);
    const accessDays = daysFromPreset(accessPreset, customDays);
    if (accessDays === "invalid") {
      setAddError("Enter a whole number of days greater than zero.");
      return;
    }
    setAddPending(true);
    try {
      const result = await adminAddProfile(name, color, password, {
        adminName: adminName.trim() || undefined,
        temporary: temporaryNew,
        avatar: avatar ?? undefined,
        avatarRing,
        accessDays,
      });
      if (!result.ok) {
        setAddError(result.error);
        return;
      }
      setName("");
      setPassword(DEFAULT_SCREEN_PASSWORD);
      setColor(DEFAULT_ADD_COLOR);
      setAvatar(null);
      setAvatarRing(true);
      setAdminName("");
      setTemporaryNew(false);
      setAccessPreset("none");
      setCustomDays("14");
      setAddNotice(`Added ${result.profile.name}.`);
    } catch (error) {
      setAddError(failureText(error, "Couldn't add that screen. Try again."));
    } finally {
      setAddPending(false);
    }
  };

  const addAccessDays = daysFromPreset(accessPreset, customDays);
  const addAccessSummary =
    addAccessDays === "invalid"
      ? "Enter a whole number of days greater than zero."
      : addAccessDays === null
        ? "Access never expires."
        : `Access ends ${formatExpiryDate(Date.now() + addAccessDays * 86_400_000)}.`;

  return (
    <div className="page admin-page admin-page--dash">
      <div className="admin-dash-bg" aria-hidden="true" />

      <header className="admin-masthead">
        <div className="admin-masthead-id">
          <span className="admin-brand-mark admin-brand-mark--sm" aria-hidden="true">
            <img src="/brand/lighthook-cat.jpg" alt="" />
          </span>
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

      {/* Routine sync state lives in the masthead pill; an actual fault is
          surfaced here, inline, so a failed admin action has visible context. */}
      {syncStatus.error && (
        <p className="admin-sync-error tiny" role="status">
          {syncStatus.error}
        </p>
      )}

      <section className="admin-telemetry" aria-label="Household summary">
        <div className="admin-telemetry-head">
          <span className="eyebrow">The house at a glance</span>
          <span className="admin-mono admin-telemetry-code">
            REGISTRY / {String(credentials.length).padStart(2, "0")} SCREENS
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
          {MAX_FAILED_ATTEMPTS}-STRIKE AUTO-LOCK ENABLED · PASSCODES HASHED ON THE SERVER
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
            <label className="admin-field admin-field--ref">
              <span className="admin-field-label">Admin ref name</span>
              <input
                value={adminName}
                onChange={(event) => {
                  setAdminName(event.target.value);
                  setAddError(null);
                  setAddNotice(null);
                }}
                maxLength={24}
                placeholder="e.g. zyn (optional)"
                autoComplete="off"
                spellCheck={false}
                aria-label="Admin reference name"
              />
            </label>
          </div>
          <LookPicker
            name={name}
            color={color}
            avatar={avatar}
            ring={avatarRing}
            onPick={(next) => {
              setAvatar(next);
              setAddError(null);
              setAddNotice(null);
            }}
            onColor={(next) => {
              setColor(next);
              setAddError(null);
              setAddNotice(null);
            }}
            onRing={(next) => {
              setAvatarRing(next);
              setAddError(null);
              setAddNotice(null);
            }}
          />
          <label className="admin-check admin-check--add">
            <input
              type="checkbox"
              checked={temporaryNew}
              onChange={(event) => {
                setTemporaryNew(event.target.checked);
                setAddError(null);
                setAddNotice(null);
              }}
              aria-label="One-time passcode"
            />
            <span className="admin-check-text">
              <span className="admin-check-title">One-time passcode</span>
              <span className="tiny muted">
                They choose their own passcode on first unlock.
              </span>
            </span>
          </label>
          <div className="admin-access" role="group" aria-label="Screen access duration">
            <span className="admin-label">Access</span>
            <div className="admin-access-presets">
              {ACCESS_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`chip${accessPreset === preset.id ? " chip--active" : ""}`}
                  aria-pressed={accessPreset === preset.id}
                  onClick={() => {
                    setAccessPreset(preset.id);
                    setAddError(null);
                    setAddNotice(null);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {accessPreset === "custom" && (
              <label className="admin-access-custom">
                <span className="tiny muted">Days</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_ACCESS_DAYS}
                  step={1}
                  inputMode="numeric"
                  value={customDays}
                  onChange={(event) => {
                    setCustomDays(event.target.value);
                    setAddError(null);
                    setAddNotice(null);
                  }}
                  aria-label="Custom access duration in days"
                />
              </label>
            )}
            <p className="tiny muted admin-access-note">{addAccessSummary}</p>
          </div>
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
            <p className="tiny muted admin-card-sub">
              Passcodes are stored on the server. Only this console can read or
              reset them.
            </p>
          </div>
          <div className="admin-list-tools">
            <button
              type="button"
              className={`btn btn-sm btn-secondary admin-copy-names admin-copy-all${copiedNames ? " is-copied" : ""}`}
              onClick={() => void copyAllPasscodes()}
              disabled={credentials.length === 0}
            >
              {copiedNames ? CheckIcon : CopyIcon}
              {copiedNames ? "Copied" : "Copy all passcodes"}
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
            {filterActive ? "FILTER ACTIVE" : "ALL SCREENS"}
          </span>
        </div>

        {credentials.length > 0 && (
          <div className="admin-kick-bar">
            <p className="admin-kick-note tiny muted">
              A kick signs that device out — they&apos;ll need their passcode again.
            </p>
            <div className="admin-select-toolbar" role="group" aria-label="Session controls">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={selectAllVisible}
                disabled={visibleIds.length === 0 || allVisibleSelected}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={clearSelection}
                disabled={selectedIds.length === 0}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger admin-kick-selected"
                onClick={() => void kickSelected()}
                disabled={selectedIds.length === 0 || kickPending}
              >
                {kickPending ? "Kicking…" : `Kick selected (${selectedIds.length})`}
              </button>
            </div>
            {kickError && (
              <p className="sheet-error" role="alert">
                {kickError}
              </p>
            )}
          </div>
        )}

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
                selected={selectedIds.includes(credential.profileId)}
                onToggleSelect={toggleSelect}
                onSetPassword={adminSetProfilePassword}
                onUnblock={adminUnblockProfile}
                onSetExpiry={adminSetScreenExpiry}
                onRemove={async (id) => {
                  await adminDeleteProfile(id);
                  setSelectedIds((previous) => previous.filter((value) => value !== id));
                }}
                onKick={async (id) => {
                  await adminKickProfiles([id]);
                }}
                onRename={adminRenameProfile}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
