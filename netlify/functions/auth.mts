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
  /** AES-GCM copy for the admin view; encrypted with a key derived from the admin password. */
  enc?: string;
  /** True while the screen still uses the seeded 1234 (no admin-set password yet). */
  isDefault?: boolean;
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
  createdAt: number;
  lastUsedAt: number;
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
const ADMIN_PASSWORD = "light0552";
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

/** 180 days, sliding: every successful resume extends it. */
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 200;
const MAX_TOKENS_PER_PROFILE = 10;
const WRONG_PASSWORD_DELAY_MS = 250;

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
 * use the hash. The encrypted copy is keyed from the admin password, which the
 * server receives on every admin request, so no extra environment secret is
 * required. Losing/rotating the admin password makes old copies unreadable —
 * the admin then resets those screens, which is the safe failure mode.
 */
const ENC_SALT = Buffer.from("lighthook-admin-enc-v1");

async function deriveEncKey(adminPassword: string): Promise<Buffer> {
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

  // First run: seed the admin hash only. Screen records are created lazily so
  // the default 1234 is never written for a screen the household removed.
  const admin = await makeHash(ADMIN_PASSWORD);
  const fresh: AuthIndex = {
    version: 1,
    admin: { ...admin, updatedAt: Date.now() },
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

async function seedScreen(
  store: BlobStore,
  index: AuthIndex,
  profileId: string,
): Promise<ScreenRecord> {
  const existing = index.screens[profileId];
  if (existing) return existing;
  const hash = await makeHash(DEFAULT_SCREEN_PASSWORD);
  const record: ScreenRecord = {
    salt: hash.salt,
    hash: hash.hash,
    isDefault: true,
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
/* Device tokens                                                       */
/* ------------------------------------------------------------------ */

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Drops expired tokens and enforces per-profile/total caps, oldest-used first.
 * Called before every write that touches tokens so the store cannot grow
 * without bound.
 */
function pruneTokens(index: AuthIndex, now = Date.now()): void {
  const groups = new Map<string, Array<[string, TokenRecord]>>();
  for (const [hash, record] of Object.entries(index.tokens)) {
    if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
      delete index.tokens[hash];
      continue;
    }
    const list = groups.get(record.profileId) ?? [];
    list.push([hash, record]);
    groups.set(record.profileId, list);
  }

  for (const list of groups.values()) {
    if (list.length <= MAX_TOKENS_PER_PROFILE) continue;
    list.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [hash] of list.slice(0, list.length - MAX_TOKENS_PER_PROFILE)) {
      delete index.tokens[hash];
    }
  }

  const remaining = Object.entries(index.tokens);
  if (remaining.length > MAX_TOKENS) {
    remaining.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [hash] of remaining.slice(0, remaining.length - MAX_TOKENS)) {
      delete index.tokens[hash];
    }
  }
}

function issueToken(index: AuthIndex, profileId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;
  index.tokens[tokenHash(token)] = {
    profileId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt,
  };
  pruneTokens(index, now);
  return { token, expiresAt };
}

function revokeProfileTokens(index: AuthIndex, profileId: string): void {
  for (const [hash, record] of Object.entries(index.tokens)) {
    if (record.profileId === profileId) delete index.tokens[hash];
  }
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
        const issued = issueToken(index, profileId);
        await writeIndex(store, index);
        return json({
          ok: true,
          blocked: false,
          failedAttempts: 0,
          attemptsLeft: MAX_FAILED_ATTEMPTS,
          token: issued.token,
          expiresAt: issued.expiresAt,
        });
      }

      await delay(WRONG_PASSWORD_DELAY_MS);
      record.failedAttempts += 1;
      record.updatedAt = Date.now();
      if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        record.blocked = true;
        // A block invalidates every remembered device: all of them must wait
        // for the admin and re-enter the passcode afterwards.
        revokeProfileTokens(index, profileId);
      }
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
      // A device token is a bearer secret. Only its SHA-256 is stored, it is
      // scoped to one profile, and it dies with a password change or a block.
      const profileId = normalizeProfileId(body.profileId);
      const token = typeof body.token === "string" ? body.token : "";
      if (!profileId || token.length < 20) return json({ error: "invalid_token" }, 400);

      const hash = tokenHash(token);
      const tokenRecord = index.tokens[hash];
      if (!tokenRecord || tokenRecord.profileId !== profileId) {
        return json({ ok: false, error: "invalid_token" }, 401);
      }
      if (tokenRecord.expiresAt <= Date.now()) {
        delete index.tokens[hash];
        await writeIndex(store, index);
        return json({ ok: false, error: "expired_token" }, 401);
      }

      const screen = await seedScreen(store, index, profileId);
      if (screen.blocked) {
        delete index.tokens[hash];
        await writeIndex(store, index);
        return json({ ok: false, blocked: true, error: "blocked" }, 403);
      }

      const now = Date.now();
      tokenRecord.lastUsedAt = now;
      tokenRecord.expiresAt = now + TOKEN_TTL_MS; // sliding
      pruneTokens(index, now);
      await writeIndex(store, index);
      return json({ ok: true, expiresAt: tokenRecord.expiresAt });
    }

    case "revoke": {
      const profileId = normalizeProfileId(body.profileId);
      const token = typeof body.token === "string" ? body.token : "";
      if (!profileId || token.length < 20) return json({ ok: true });
      const hash = tokenHash(token);
      if (index.tokens[hash]?.profileId === profileId) {
        delete index.tokens[hash];
        await writeIndex(store, index);
      }
      return json({ ok: true });
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
      const hash = await makeHash(password);
      const encKey = await deriveEncKey(adminKey as string);
      // A password change signs every remembered device out.
      revokeProfileTokens(index, profileId);
      index.screens[profileId] = {
        salt: hash.salt,
        hash: hash.hash,
        enc: encryptPassword(password, encKey),
        isDefault: false,
        failedAttempts: 0,
        blocked: false,
        updatedAt: Date.now(),
      };
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
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
      const hash = await makeHash(password);
      const encKey = await deriveEncKey(adminKey as string);
      index.screens[profileId] = {
        salt: hash.salt,
        hash: hash.hash,
        enc: encryptPassword(password, encKey),
        isDefault: password === DEFAULT_SCREEN_PASSWORD,
        failedAttempts: 0,
        blocked: false,
        updatedAt: Date.now(),
      };
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminRemove": {
      const profileId = normalizeProfileId(body.profileId);
      if (!profileId) return json({ error: "invalid_profile" }, 400);
      revokeProfileTokens(index, profileId);
      delete index.screens[profileId];
      await writeIndex(store, index);
      return json({ ok: true, screens: publicStatus(index) });
    }

    case "adminList": {
      // Admin-only readback. The encrypted copy is decrypted with a key derived
      // from the admin password supplied on this request. Screens with no
      // record yet still have the seeded default, so report that instead of a
      // blank row on a brand-new Blobs store.
      const encKey = await deriveEncKey(adminKey as string);
      const ids = Array.isArray(body.profileIds)
        ? body.profileIds.filter(
            (id): id is string => typeof id === "string" && ID_PATTERN.test(id),
          )
        : [];
      const screens: Record<
        string,
        { blocked: boolean; failedAttempts: number; password: string | null }
      > = {};
      for (const [id, record] of Object.entries(index.screens)) {
        let password: string | null = null;
        if (record.enc) password = decryptPassword(record.enc, encKey);
        else if (record.isDefault !== false) password = DEFAULT_SCREEN_PASSWORD;
        screens[id] = {
          blocked: record.blocked,
          failedAttempts: record.failedAttempts,
          password,
        };
      }
      for (const id of ids.slice(0, 50)) {
        if (!screens[id]) {
          screens[id] = {
            blocked: false,
            failedAttempts: 0,
            password: DEFAULT_SCREEN_PASSWORD,
          };
        }
      }
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
        const encKey = await deriveEncKey(adminKey as string);
        index.screens[profileId] = {
          salt: hash.salt,
          hash: hash.hash,
          enc: encryptPassword(password, encKey),
          isDefault: password === DEFAULT_SCREEN_PASSWORD,
          failedAttempts: 0,
          blocked: false,
          updatedAt: Date.now(),
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
