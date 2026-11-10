import { getStore } from "@netlify/blobs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

/**
 * Screen / admin authentication (Netlify Functions v2).
 *
 * Passwords live in Netlify Blobs as scrypt hashes — never plaintext. This is
 * what makes them survive clearing cache/cookies, and what stops the bundled
 * app from containing the admin password.
 *
 * Blob layout (store "lighthook", strong consistency):
 *   auth/index.json -> AuthIndex
 *
 * The x-family-key header is the same household gate used by /api/profiles.
 * The x-admin-key header carries the admin password for admin-only actions.
 */

interface ScreenRecord {
  salt: string;
  hash: string;
  /** AES-GCM copy for the admin view; encrypted with the server AUTH_SECRET. */
  enc?: string;
  /** True while the screen still uses the seeded 1234 (no admin-set password yet). */
  isDefault?: boolean;
  /** Changes only when the passcode changes; invalidates old device tokens. */
  passwordVersion?: string;
  /** Rotated by an admin kick; invalidates every device session for this screen. */
  sessionEpoch?: string;
  /** When sessionEpoch was last rotated; rejects pre-upgrade tokens after a kick. */
  sessionEpochAt?: number;
  /** One-time pass: the user must choose a new passcode before entering. */
  mustChange?: boolean;
  /** Last self-service passcode change (server-enforced once per 7 days). */
  lastSelfChangeAt?: number;
  /** Admin-only reference name; never shown on the picker. */
  adminName?: string;
  failedAttempts: number;
  blocked: boolean;
  updatedAt: number;
}

interface AdminRecord {
  salt: string;
  hash: string;
  updatedAt: number;
}

interface TokenRecord {
  profileId: string;
  /** Screen password version this token was issued against. */
  authVersion: string;
  /** Screen session epoch this token was issued against (admin kick rotates it). */
  sessionEpoch: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

/** Short-lived proof that a one-time pass was accepted; never a session. */
interface ChangeRecord {
  profileId: string;
  /** Password version the one-time pass belonged to. */
  authVersion: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthIndex {
  version: 1;
  admin: AdminRecord | null;
  screens: Record<string, ScreenRecord>;
  /** SHA-256(token) -> device session. Never stores the token itself. */
  tokens: Record<string, TokenRecord>;
  updatedAt: number;
}

const STORE_NAME = "lighthook";
const AUTH_KEY = "auth/index.json";
const TOKEN_PREFIX = "auth/tokens/";
const CHANGE_PREFIX = "auth/changes/";
const SESSION_COOKIE = "lighthook_session";
/**
 * Server-only admin password. There is deliberately no default: a missing
 * value leaves a fresh store with admin disabled, and leaves an existing
 * admin hash untouched (so a site that has not been configured yet keeps
 * working until the env is set). Both Netlify sites set this explicitly.
 */
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD ?? "").trim();
const DEFAULT_SCREEN_PASSWORD = "1234";
const MAX_FAILED_ATTEMPTS = 3;
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 64;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_BODY_BYTES = 16 * 1024;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 64;

/** Effectively "until sign-out / password change / block / site-data clear". */
const TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const CHANGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const SELF_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const WRONG_PASSWORD_DELAY_MS = 250;

/** Server-only secret for the admin-readable passcode copy. */
const AUTH_SECRET =
  (process.env.AUTH_SECRET ?? "").trim() ||
  `dev-${(process.env.FAMILY_KEY ?? "samandmellu").trim()}`;

const textEncoder = new TextEncoder();

type BlobStore = ReturnType<typeof getStore>;

type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "invalid_json" | "invalid_body" | "body_too_large" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function familyKeyOk(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = textEncoder.encode(provided);
  const b = textEncoder.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

function scryptHash(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      length,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
}

interface HashPair {
  salt: string;
  hash: string;
}

async function makeHash(password: string): Promise<HashPair> {
  const salt = randomBytes(16);
  const derived = await scryptHash(password, salt, SCRYPT_LENGTH);
  return { salt: salt.toString("base64"), hash: derived.toString("base64") };
}

async function verifyHash(password: string, pair: { salt: string; hash: string }): Promise<boolean> {
  const salt = Buffer.from(pair.salt, "base64");
  const expected = Buffer.from(pair.hash, "base64");
  if (expected.length === 0) return false;
  const actual = await scryptHash(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ */
/* Encrypted admin copy                                                */
/* ------------------------------------------------------------------ */

/**
 * The admin view needs the actual passcode, while verification must only ever
 * use the hash. The encrypted copy is keyed from AUTH_SECRET (server-only), so
 * a user can change their own passcode and the admin can still read it. Copies
 * from the previous release were keyed from the admin password; adminList
 * migrates them on read.
 */
const ENC_SALT = Buffer.from("lighthook-admin-enc-v1");
let cachedServerKey: Promise<Buffer> | null = null;

/** Key for the admin-readable passcode copy; server-only AUTH_SECRET. */
function deriveServerEncKey(): Promise<Buffer> {
  if (!cachedServerKey) cachedServerKey = scryptHash(AUTH_SECRET, ENC_SALT, 32);
  return cachedServerKey;
}

/** Previous release encrypted with the admin password; used only for migration. */
async function deriveLegacyEncKey(adminPassword: string): Promise<Buffer> {
  return scryptHash(adminPassword, ENC_SALT, 32);
}

function encryptPassword(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(".");
}

function decryptPassword(payload: string, key: Buffer): string | null {
  try {
    const [ivB64, tagB64, bodyB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !bodyB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const body = Buffer.concat([
      decipher.update(Buffer.from(bodyB64, "base64")),
      decipher.final(),
    ]);
    return body.toString("utf8");
  } catch {
    return null;
  }
}

function normalizePassword(value: unknown, fallback?: string): string | null {
  if (typeof value !== "string") return fallback ?? null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_PASSWORD_LENGTH || trimmed.length > MAX_PASSWORD_LENGTH) return null;
  return trimmed;
}

function normalizeProfileId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

/** Admin-only reference label; empty clears it. Never sent to non-admin callers. */
function normalizeAdminName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 48) : "";
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

async function readIndex(store: BlobStore): Promise<AuthIndex> {
  const stored = await store.get(AUTH_KEY, { type: "json" });
  if (
    isRecord(stored) &&
    isRecord((stored as unknown as AuthIndex).screens) &&
    ((stored as unknown as AuthIndex).admin === null ||
      isRecord((stored as unknown as AuthIndex).admin))
  ) {
    const index = stored as unknown as AuthIndex;
    // Older records predate device tokens.
    if (!isRecord(index.tokens)) index.tokens = {};
    return index;
  }

  // First run: seed the admin hash only when the server has been configured
  // with ADMIN_PASSWORD. Screen records are created lazily so the default 1234
  // is never written for a screen the household removed.
  const admin = ADMIN_PASSWORD ? await makeHash(ADMIN_PASSWORD) : null;
  const fresh: AuthIndex = {
    version: 1,
    admin: admin ? { ...admin, updatedAt: Date.now() } : null,
    screens: {},
    tokens: {},
    updatedAt: Date.now(),
  };
  await store.setJSON(AUTH_KEY, fresh);
  return fresh;
}

async function writeIndex(store: BlobStore, index: AuthIndex): Promise<void> {
  index.updatedAt = Date.now();
  await store.setJSON(AUTH_KEY, index);
}

let syncedAdminPassword = "";
let adminSyncPromise: Promise<void> | null = null;

/**
 * Keeps the Blobs admin hash aligned with the server-only ADMIN_PASSWORD env.
 *
 * - env set + existing hash does not match -> rehash (rotates on env change /
 *   first request after deploy)
 * - env set + no admin hash -> seed it
 * - env missing -> leave an existing hash alone, so a site awaiting its env
 *   configuration keeps working; a fresh store stays admin-disabled
 *
 * Runs once per cold start/value change; admin requests are rare, so the one
 * scrypt verification is acceptable.
 */
async function ensureAdminPassword(store: BlobStore, index: AuthIndex): Promise<void> {
  if (!ADMIN_PASSWORD || syncedAdminPassword === ADMIN_PASSWORD) return;
  if (!adminSyncPromise) {
    adminSyncPromise = (async () => {
      if (!index.admin || !(await verifyHash(ADMIN_PASSWORD, index.admin))) {
        const next = await makeHash(ADMIN_PASSWORD);
        index.admin = { ...next, updatedAt: Date.now() };
        await writeIndex(store, index);
      }
      syncedAdminPassword = ADMIN_PASSWORD;
    })().finally(() => {
      adminSyncPromise = null;
    });
  }
  await adminSyncPromise;
}

/**
 * Older records predate kicks (`sessionEpoch`) or password versions. Fill them
 * in without rotating anything, so existing sessions keep working once.
 */
function ensureScreenSecurity(record: ScreenRecord): boolean {
  let changed = false;
  if (!record.passwordVersion) {
    record.passwordVersion = randomBytes(8).toString("hex");
    changed = true;
  }
  if (!record.sessionEpoch) {
    record.sessionEpoch = randomBytes(8).toString("hex");
    changed = true;
  }
  if (record.sessionEpochAt === undefined) {
    record.sessionEpochAt = 0;
    changed = true;
  }
  return changed;
}

function rotateScreenSecurity(record: ScreenRecord): void {
  record.passwordVersion = randomBytes(8).toString("hex");
  record.sessionEpoch = randomBytes(8).toString("hex");
  record.sessionEpochAt = Date.now();
}

async function seedScreen(
  store: BlobStore,
  index: AuthIndex,
  profileId: string,
): Promise<ScreenRecord> {
  const existing = index.screens[profileId];
  if (existing) {
    if (ensureScreenSecurity(existing)) await writeIndex(store, index);
    return existing;
  }
  const hash = await makeHash(DEFAULT_SCREEN_PASSWORD);
  const record: ScreenRecord = {
    salt: hash.salt,
    hash: hash.hash,
    isDefault: true,
    passwordVersion: randomBytes(8).toString("hex"),
    sessionEpoch: randomBytes(8).toString("hex"),
    sessionEpochAt: 0,
    mustChange: false,
    lastSelfChangeAt: 0,
    failedAttempts: 0,
    blocked: false,
    updatedAt: Date.now(),
  };
  index.screens[profileId] = record;
  await writeIndex(store, index);
  return record;
}

function publicStatus(index: AuthIndex): Record<string, { blocked: boolean; failedAttempts: number }> {
  const out: Record<string, { blocked: boolean; failedAttempts: number }> = {};
  for (const [id, record] of Object.entries(index.screens)) {
    out[id] = { blocked: record.blocked, failedAttempts: record.failedAttempts };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Session cookie                                                      */
/* ------------------------------------------------------------------ */

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      const value = trimmed.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function isSecureRequest(req: Request): boolean {
  const forwarded = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * HttpOnly session cookie. `Secure` is only added on HTTPS so the same code
 * works over the local LAN during Netlify Dev testing. Max-Age is ten years:
 * the session lasts until sign-out, a passcode change, a block, or site data
 * is cleared — no periodic re-login.
 */
function sessionCookie(req: Request, token: string): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    TOKEN_TTL_MS / 1000,
  )}${secure}`;
}

function clearSessionCookie(req: Request): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/* ------------------------------------------------------------------ */
/* Device tokens                                                       */
/* ------------------------------------------------------------------ */

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenKey(hash: string): string {
  return `${TOKEN_PREFIX}${hash}.json`;
}

async function getToken(store: BlobStore, hash: string): Promise<TokenRecord | null> {
  const stored = await store.get(tokenKey(hash), { type: "json" });
  if (!isRecord(stored)) return null;
  const record = stored as unknown as TokenRecord;
  if (typeof record.profileId !== "string") return null;
  return record;
}

async function putToken(store: BlobStore, hash: string, record: TokenRecord): Promise<void> {
  await store.setJSON(tokenKey(hash), record);
}

async function deleteToken(store: BlobStore, hash: string): Promise<void> {
  try {
    await store.delete(tokenKey(hash));
  } catch {
    /* already gone */
  }
}

async function issueToken(
  store: BlobStore,
  profileId: string,
  authVersion: string,
  sessionEpoch: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;
  await putToken(store, tokenHash(token), {
    profileId,
    authVersion,
    sessionEpoch,
    createdAt: now,
    lastUsedAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

/* ------------------------------------------------------------------ */
/* One-time-pass change tokens                                          */
/* ------------------------------------------------------------------ */

function changeKey(hash: string): string {
  return `${CHANGE_PREFIX}${hash}.json`;
}

async function getChange(store: BlobStore, hash: string): Promise<ChangeRecord | null> {
  const stored = await store.get(changeKey(hash), { type: "json" });
  if (!isRecord(stored)) return null;
  const record = stored as unknown as ChangeRecord;
  if (typeof record.profileId !== "string") return null;
  return record;
}

async function putChange(store: BlobStore, hash: string, record: ChangeRecord): Promise<void> {
  await store.setJSON(changeKey(hash), record);
}

async function deleteChange(store: BlobStore, hash: string): Promise<void> {
  try {
    await store.delete(changeKey(hash));
  } catch {
    /* already gone */
  }
}

/**
 * The previous release kept tokens inside auth/index.json, where a concurrent
 * write could drop one. Move them to per-token blobs once, bound to the
 * screen's current passwordVersion, so existing sessions survive the upgrade.
 */
async function migrateLegacyTokens(store: BlobStore, index: AuthIndex): Promise<void> {
  const legacy = index.tokens;
  if (!isRecord(legacy) || Object.keys(legacy).length === 0) return;

  for (const [hash, raw] of Object.entries(legacy)) {
    if (!isRecord(raw)) continue;
    const profileId = typeof raw.profileId === "string" ? raw.profileId : "";
    const screen = index.screens[profileId];
    if (!screen) continue;
    ensureScreenSecurity(screen);
    const now = Date.now();
    await putToken(store, hash, {
      profileId,
      authVersion: screen.passwordVersion as string,
      sessionEpoch: screen.sessionEpoch as string,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
      lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : now,
      expiresAt:
        typeof raw.expiresAt === "number" ? raw.expiresAt : now + TOKEN_TTL_MS,
    });
  }

  index.tokens = {};
  await writeIndex(store, index);
}

async function readBody(req: Request): Promise<ParsedBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, error: "body_too_large" };
  }
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  return { ok: true, body: value };
}

function bodyErrorResponse(error: "invalid_json" | "invalid_body" | "body_too_large"): Response {
  return error === "body_too_large" ? json({ error, max: MAX_BODY_BYTES }, 413) : json({ error }, 400);
}

/** Small delay on failed admin logins to slow down guessing. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adminOk(store: BlobStore, index: AuthIndex, provided: string | null): Promise<boolean> {
  if (!provided || !index.admin) return false;
  return verifyHash(provided, index.admin);
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function route(req: Request): Promise<Response> {
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  }

  const parsed = await readBody(req);
  if (!parsed.ok) return bodyErrorResponse(parsed.error);
  const body = parsed.body;
  const action = typeof body.action === "string" ? body.action : "";

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const index = await readIndex(store);
  await migrateLegacyTokens(store, index);
  await ensureAdminPassword(store, index);

  switch (action) {
    case "status": {
      // Read-only: never seeds records here. Seeding on status would make a
      // first-login migration think every screen already had a password.
      return json({ screens: publicStatus(index) });
    }

    case "verify": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      if (typeof body.password !== "string") return json({ error: "invalid_password" }, 400);
      const password = body.password.slice(0, MAX_PASSWORD_LENGTH);

      const record = await seedScreen(store, index, profileId);
      if (record.blocked) {
        return json({
          ok: false,
          blocked: true,
          failedAttempts: record.failedAttempts,
          attemptsLeft: 0,
          error: "blocked",
        });
      }

      const good = await verifyHash(password, record);
      if (good) {
        record.failedAttempts = 0;
        record.blocked = false;
        record.updatedAt = Date.now();
        ensureScreenSecurity(record);

        // A one-time pass must never become a session. Accept it only long
        // enough to hand out a short-lived change token, then require the user
        // to choose their own passcode.
        if (record.mustChange === true) {
          const changeToken = randomBytes(32).toString("base64url");
          const now = Date.now();
          await putChange(store, tokenHash(changeToken), {
            profileId,
            authVersion: record.passwordVersion as string,
            createdAt: now,
            expiresAt: now + CHANGE_TOKEN_TTL_MS,
          });

          // Drop any older browser session for this screen.
          const previous = readCookie(req, SESSION_COOKIE);
          if (previous) await deleteToken(store, tokenHash(previous));

          await writeIndex(store, index);
          return json(
            {
              ok: true,
              blocked: false,
              failedAttempts: 0,
              attemptsLeft: MAX_FAILED_ATTEMPTS,
              mustChange: true,
              changeToken,
              expiresAt: now + CHANGE_TOKEN_TTL_MS,
            },
            200,
            { "set-cookie": clearSessionCookie(req) },
          );
        }

        // Replace any old browser token for this device; each successful
        // unlock gets one fresh 256-bit session cookie.
        const previous = readCookie(req, SESSION_COOKIE);
        if (previous) await deleteToken(store, tokenHash(previous));

        const issued = await issueToken(
          store,
          profileId,
          record.passwordVersion as string,
          record.sessionEpoch as string,
        );
        await writeIndex(store, index);
        return json(
          {
            ok: true,
            blocked: false,
            failedAttempts: 0,
            attemptsLeft: MAX_FAILED_ATTEMPTS,
            expiresAt: issued.expiresAt,
          },
          200,
          { "set-cookie": sessionCookie(req, issued.token) },
        );
      }

      await delay(WRONG_PASSWORD_DELAY_MS);
      record.failedAttempts += 1;
      record.updatedAt = Date.now();
      if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) record.blocked = true;
      await writeIndex(store, index);
      return json({
        ok: false,
        blocked: record.blocked,
        failedAttempts: record.failedAttempts,
        attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - record.failedAttempts),
        error: record.blocked ? "blocked" : "wrong_password",
      });
    }

    case "resume": {
      // Cookie first (the normal path), body token only for migrating a
      // localStorage token from the previous release. Tokens are stored as
      // separate blobs and bound to the screen's passwordVersion.
      const profileId = normalizeProfileId(body.profileId);
      const token =
        readCookie(req, SESSION_COOKIE) ??
        (typeof body.token === "string" ? body.token : "");
      if (!profileId || token.length < 20) {
        return json({ ok: false, error: "invalid_token" }, 401, {
          "set-cookie": clearSessionCookie(req),
        });
      }

      const hash = tokenHash(token);
      const tokenRecord = await getToken(store, hash);

      // The cookie belongs to the device, not to the screen being requested.
      // Probing another tile must never revoke the session the user is on.
      if (!tokenRecord) {
        return json({ ok: false, error: "invalid_token" }, 401, {
          "set-cookie": clearSessionCookie(req),
        });
      }
      if (tokenRecord.profileId !== profileId) {
        return json({ ok: false, error: "invalid_token" }, 401);
      }

      const screen = index.screens[profileId];
      if (screen && ensureScreenSecurity(screen)) await writeIndex(store, index);

      // Tokens from the previous release predate kicks. They are accepted only
      // if no kick happened after they were issued; a kick records its time.
      const epochMatches = tokenRecord.sessionEpoch
        ? tokenRecord.sessionEpoch === screen?.sessionEpoch
        : (screen?.sessionEpochAt ?? 0) <= tokenRecord.createdAt;
      const invalid =
        !screen ||
        !screen.passwordVersion ||
        tokenRecord.authVersion !== screen.passwordVersion ||
        !epochMatches ||
        tokenRecord.expiresAt <= Date.now();

      if (invalid) {
        await deleteToken(store, hash);
        return json({ ok: false, error: "invalid_token" }, 401, {
          "set-cookie": clearSessionCookie(req),
        });
      }

      if (screen.blocked) {
        return json({ ok: false, blocked: true, error: "blocked" }, 403, {
          "set-cookie": clearSessionCookie(req),
        });
      }

      const now = Date.now();
      tokenRecord.lastUsedAt = now;
      tokenRecord.expiresAt = now + TOKEN_TTL_MS;
      if (!tokenRecord.sessionEpoch) {
        tokenRecord.sessionEpoch = screen.sessionEpoch as string;
      }
      await putToken(store, hash, tokenRecord);
      return json(
        { ok: true, expiresAt: tokenRecord.expiresAt },
        200,
        { "set-cookie": sessionCookie(req, token) },
      );
    }

    case "revoke": {
      const profileId = normalizeProfileId(body.profileId);
      const token =
        readCookie(req, SESSION_COOKIE) ??
        (typeof body.token === "string" ? body.token : "");
      if (token.length >= 20) {
        const hash = tokenHash(token);
        const record = await getToken(store, hash);
        if (!record || !profileId || record.profileId === profileId) {
          await deleteToken(store, hash);
        }
      }
      return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(req) });
    }

    case "changePassword": {
      // Forced first-login change: consumes a one-time change token issued by
      // verify, sets the permanent passcode, then opens the session. No session
      // exists before this point.
      const profileId = normalizeProfileId(body.profileId);
      const changeToken = typeof body.changeToken === "string" ? body.changeToken : "";
      const password = normalizePassword(body.password);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      if (!password) return json({ error: "invalid_password" }, 400);
      if (changeToken.length < 20) return json({ error: "invalid_token" }, 401);

      const screen = index.screens[profileId];
      if (!screen) return json({ error: "invalid_token" }, 401);
      ensureScreenSecurity(screen);
      if (screen.blocked) return json({ error: "blocked" }, 403);

      const hash = tokenHash(changeToken);
      const change = await getChange(store, hash);
      if (
        !change ||
        change.profileId !== profileId ||
        change.authVersion !== screen.passwordVersion ||
        change.expiresAt <= Date.now()
      ) {
        if (change) await deleteChange(store, hash);
        return json({ error: "expired" }, 401);
      }

      // The one-time pass must not simply become the permanent passcode.
      if (await verifyHash(password, screen)) {
        return json({ error: "same_password" }, 400);
      }

      const nextHash = await makeHash(password);
      const encKey = await deriveServerEncKey();
      screen.salt = nextHash.salt;
      screen.hash = nextHash.hash;
      screen.enc = encryptPassword(password, encKey);
      screen.isDefault = false;
      screen.mustChange = false;
      screen.failedAttempts = 0;
      screen.blocked = false;
      // The forced change belongs to the one-time-pass flow, not the weekly
      // self-service change, so it must not consume the cooldown.
      rotateScreenSecurity(screen);
      screen.updatedAt = Date.now();

      await deleteChange(store, hash);
      const previous = readCookie(req, SESSION_COOKIE);
      if (previous) await deleteToken(store, tokenHash(previous));

      const issued = await issueToken(
        store,
        profileId,
        screen.passwordVersion as string,
        screen.sessionEpoch as string,
      );
      await writeIndex(store, index);
      return json(
        { ok: true, expiresAt: issued.expiresAt },
        200,
        { "set-cookie": sessionCookie(req, issued.token) },
      );
    }

    case "changePass": {
      // Self-service change from the profile. The cooldown is stored on the
      // screen record, so clearing cookies or local storage cannot reset it.
      const profileId = normalizeProfileId(body.profileId);
      const currentPassword =
        typeof body.currentPassword === "string"
          ? body.currentPassword.slice(0, MAX_PASSWORD_LENGTH)
          : "";
      const password = normalizePassword(body.password);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      if (!password) return json({ error: "invalid_password" }, 400);

      const screen = await seedScreen(store, index, profileId);
      if (screen.blocked) {
        return json({ error: "blocked", blocked: true }, 403);
      }

      const good = await verifyHash(currentPassword, screen);
      if (!good) {
        await delay(WRONG_PASSWORD_DELAY_MS);
        screen.failedAttempts += 1;
        screen.updatedAt = Date.now();
        if (screen.failedAttempts >= MAX_FAILED_ATTEMPTS) screen.blocked = true;
        await writeIndex(store, index);
        return json(
          {
            ok: false,
            blocked: screen.blocked,
            failedAttempts: screen.failedAttempts,
            attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - screen.failedAttempts),
            error: screen.blocked ? "blocked" : "wrong_password",
          },
          screen.blocked ? 403 : 401,
        );
      }

      const now = Date.now();
      const last = screen.lastSelfChangeAt ?? 0;
      if (last > 0 && now - last < SELF_CHANGE_COOLDOWN_MS) {
        return json(
          { error: "cooldown", retryAt: last + SELF_CHANGE_COOLDOWN_MS },
          403,
        );
      }

      if (await verifyHash(password, screen)) {
        return json({ error: "same_password" }, 400);
      }

      const nextHash = await makeHash(password);
      const encKey = await deriveServerEncKey();
      screen.salt = nextHash.salt;
      screen.hash = nextHash.hash;
      screen.enc = encryptPassword(password, encKey);
      screen.isDefault = false;
      screen.mustChange = false;
      screen.lastSelfChangeAt = now;
      screen.failedAttempts = 0;
      screen.blocked = false;
      // Changing the passcode signs every other device out.
      rotateScreenSecurity(screen);
      screen.updatedAt = now;

      const previous = readCookie(req, SESSION_COOKIE);
      if (previous) await deleteToken(store, tokenHash(previous));

      const issued = await issueToken(
        store,
        profileId,
        screen.passwordVersion as string,
        screen.sessionEpoch as string,
      );
      await writeIndex(store, index);
      return json(
        { ok: true, expiresAt: issued.expiresAt },
        200,
        { "set-cookie": sessionCookie(req, issued.token) },
      );
    }

    case "adminLogin": {
      const password = typeof body.password === "string" ? body.password : "";
      const ok = await adminOk(store, index, password);
      if (!ok) {
        await delay(400);
        return json({ error: "invalid_admin_password" }, 401);
      }
      return json({ ok: true });
    }

    default:
      break;
  }

  // Everything below is admin-only.
  const adminKey = req.headers.get("x-admin-key");
  if (!(await adminOk(store, index, adminKey))) {
    return json({ error: "admin_required" }, 401);
  }

  switch (action) {
    case "adminSet": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      const password = normalizePassword(body.password);
      if (!password) return json({ error: "invalid_password" }, 400);
      const temporary = body.temporary === true;
      const hash = await makeHash(password);
      const encKey = await deriveServerEncKey();
      const now = Date.now();
      index.screens[profileId] = {
        salt: hash.salt,
        hash: hash.hash,
        enc: encryptPassword(password, encKey),
        isDefault: false,
        passwordVersion: randomBytes(8).toString("hex"),
        sessionEpoch: randomBytes(8).toString("hex"),
        sessionEpochAt: now,
        mustChange: temporary,
        // An admin reset always clears the self-service cooldown and ref name
        // is kept: only the passcode changed.
        lastSelfChangeAt: 0,
        adminName: index.screens[profileId]?.adminName,
        failedAttempts: 0,
        blocked: false,
        updatedAt: now,
      };
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminKick": {
      // Rotates the session epoch so every existing device token for these
      // screens is invalid immediately. The passcode is untouched.
      const rawIds = Array.isArray(body.profileIds)
        ? body.profileIds
        : typeof body.profileId === "string"
          ? [body.profileId]
          : [];
      const now = Date.now();
      const kicked: string[] = [];
      for (const raw of rawIds.slice(0, 100)) {
        const id = normalizeProfileId(raw);
        if (!id) continue;
        const record = index.screens[id];
        if (!record) continue;
        ensureScreenSecurity(record);
        record.sessionEpoch = randomBytes(8).toString("hex");
        record.sessionEpochAt = now;
        record.updatedAt = now;
        kicked.push(id);
      }
      if (kicked.length > 0) await writeIndex(store, index);
      return json({ ok: true, kicked, screens: publicStatus(index) });
    }

    case "adminSetAdminName": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      const adminName = normalizeAdminName(body.adminName);
      const record = await seedScreen(store, index, profileId);
      record.adminName = adminName;
      record.updatedAt = Date.now();
      await writeIndex(store, index);
      return json({ ok: true, adminName });
    }

    case "adminUnblock": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      const record = index.screens[profileId];
      if (!record) return json({ error: "not_found" }, 404);
      record.failedAttempts = 0;
      record.blocked = false;
      record.updatedAt = Date.now();
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminAdd": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      const password = normalizePassword(body.password, DEFAULT_SCREEN_PASSWORD);
      if (!password) return json({ error: "invalid_password" }, 400);
      const temporary = body.temporary === true;
      const adminName = normalizeAdminName(body.adminName);
      const hash = await makeHash(password);
      const encKey = await deriveServerEncKey();
      const now = Date.now();
      index.screens[profileId] = {
        salt: hash.salt,
        hash: hash.hash,
        enc: encryptPassword(password, encKey),
        isDefault: password === DEFAULT_SCREEN_PASSWORD,
        passwordVersion: randomBytes(8).toString("hex"),
        sessionEpoch: randomBytes(8).toString("hex"),
        sessionEpochAt: now,
        mustChange: temporary,
        lastSelfChangeAt: 0,
        adminName,
        failedAttempts: 0,
        blocked: false,
        updatedAt: now,
      };
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminRemove": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      // Deleting the screen is enough: resume requires a screen record.
      delete index.screens[profileId];
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminList": {
      // Admin-only readback. Passcodes are decrypted with the server
      // AUTH_SECRET; copies from the previous release (encrypted with a key
      // derived from the admin password) are migrated here.
      const encKey = await deriveServerEncKey();
      const legacyKey = await deriveLegacyEncKey(adminKey as string);
      const ids = Array.isArray(body.profileIds)
        ? body.profileIds.filter(
            (id): id is string => typeof id === "string" && ID_PATTERN.test(id),
          )
        : [];
      const screens: Record<
        string,
        {
          blocked: boolean;
          failedAttempts: number;
          password: string | null;
          adminName?: string;
          mustChange?: boolean;
          lastSelfChangeAt?: number;
        }
      > = {};
      let migrated = false;

      for (const [id, record] of Object.entries(index.screens)) {
        let password: string | null = null;
        if (record.enc) {
          password = decryptPassword(record.enc, encKey);
          if (password === null) {
            const legacy = decryptPassword(record.enc, legacyKey);
            if (legacy !== null) {
              record.enc = encryptPassword(legacy, encKey);
              password = legacy;
              migrated = true;
            }
          }
        } else if (record.isDefault !== false) {
          password = DEFAULT_SCREEN_PASSWORD;
        }
        screens[id] = {
          blocked: record.blocked,
          failedAttempts: record.failedAttempts,
          password,
          adminName: record.adminName ?? "",
          mustChange: record.mustChange === true,
          lastSelfChangeAt: record.lastSelfChangeAt ?? 0,
        };
      }
      for (const id of ids.slice(0, 50)) {
        if (!screens[id]) {
          screens[id] = {
            blocked: false,
            failedAttempts: 0,
            password: DEFAULT_SCREEN_PASSWORD,
            adminName: "",
            mustChange: false,
            lastSelfChangeAt: 0,
          };
        }
      }
      if (migrated) await writeIndex(store, index);
      return json({ screens });
    }

    case "migrate": {
      // One-time push of passwords that only exist in a device's IndexedDB.
      // An existing record is only replaced while it still matches the default
      // 1234, so a password already changed on the server is never clobbered.
      const entries = Array.isArray(body.screens) ? body.screens : [];
      let changed = 0;
      for (const entry of entries.slice(0, 50)) {
        if (!isRecord(entry)) continue;
        const profileId = normalizeProfileId(entry.profileId);
        const password = normalizePassword(entry.password);
        if (!profileId || !password) continue;

        const existing = index.screens[profileId];
        if (existing) {
          const stillDefault = await verifyHash(DEFAULT_SCREEN_PASSWORD, existing);
          if (!stillDefault) continue;
        }

        const hash = await makeHash(password);
        const encKey = await deriveServerEncKey();
        const now = Date.now();
        index.screens[profileId] = {
          salt: hash.salt,
          hash: hash.hash,
          enc: encryptPassword(password, encKey),
          isDefault: password === DEFAULT_SCREEN_PASSWORD,
          passwordVersion: randomBytes(8).toString("hex"),
          sessionEpoch: randomBytes(8).toString("hex"),
          sessionEpochAt: now,
          mustChange: false,
          lastSelfChangeAt: 0,
          adminName: existing?.adminName,
          failedAttempts: 0,
          blocked: false,
          updatedAt: now,
        };
        changed += 1;
      }
      if (changed > 0) await writeIndex(store, index);
      return json({ ok: true, migrated: changed, screens: publicStatus(index) });
    }

    default:
      return json({ error: "unknown_action" }, 400);
  }
}

export default async function handler(req: Request): Promise<Response> {
  const expectedKey = (process.env.FAMILY_KEY ?? "").trim() || "samandmellu";
  if (!familyKeyOk(req.headers.get("x-family-key"), expectedKey)) {
    return json({ error: "forbidden" }, 403);
  }

  try {
    return await route(req);
  } catch (error) {
    console.error("auth: unhandled error", error);
    return json({ error: "internal_error" }, 500);
  }
}

export const config = { path: "/api/auth" };
