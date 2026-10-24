/**
 * Ripstream sidecar smoke test — resolve → playlist → segment, all through the
 * local proxy. No browser automation here: it only talks HTTP to a sidecar you
 * already have running (`node scripts/ripstream/server.mjs`).
 *
 * Run: node scripts/ripstream/selftest.mjs
 * Exit: 0 when every assertion passes, 1 otherwise.
 */

import { AD_HOST } from "./extract.mjs";

const BASE = process.env.RIP_BASE ?? "http://127.0.0.1:5174";
const RESOLVE_TIMEOUT_MS = 70_000;

let failures = 0;

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

function fail(msg) {
  failures += 1;
  console.log(`FAIL  ${msg}`);
}

function check(condition, okMsg, badMsg) {
  if (condition) pass(okMsg);
  else fail(badMsg);
  return condition;
}

/** Split a proxied playlist into its /rip/hls/ child URLs (decoded upstream). */
function children(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("/rip/hls/")) continue;
    try {
      out.push(decodeURIComponent(trimmed.slice(trimmed.indexOf("/rip/hls/") + "/rip/hls/".length)));
    } catch {
      /* unparseable child — skip */
    }
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function fetchProxied(childUrl, init) {
  return fetch(`${BASE}/rip/hls/${encodeURIComponent(childUrl)}`, init);
}

async function main() {
  /* 1 — health ------------------------------------------------------ */
  try {
    const res = await fetch(`${BASE}/rip/health`, { signal: AbortSignal.timeout(5000) });
    const health = await res.json();
    console.log(`health: ${JSON.stringify(health)}`);
    check(res.status === 200 && health.ok === true, "health responds ok", `health failed (${res.status})`);
  } catch (err) {
    fail(`health unreachable at ${BASE}: ${err?.message ?? err}`);
    console.log("\nIs the sidecar running? node scripts/ripstream/server.mjs");
    process.exit(1);
  }

  /* 2 — resolve ----------------------------------------------------- */
  let resolved = null;
  let ref = "type=movie&tmdbId=603";
  try {
    console.log(`resolve: ${ref} (The Matrix) …`);
    const res = await fetch(`${BASE}/rip/resolve?${ref}`, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    console.log(`resolve status: ${res.status}`);
    resolved = await res.json();
  } catch (err) {
    fail(`resolve request failed: ${err?.message ?? err}`);
  }

  if (resolved && !resolved.ok) {
    console.log(`movie 603 failed, trying fallback tv 1399 S1E1 …`);
    ref = "type=tv&tmdbId=1399&s=1&e=1";
    try {
      const res = await fetch(`${BASE}/rip/resolve?${ref}`, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
      console.log(`resolve status: ${res.status}`);
      resolved = await res.json();
    } catch (err) {
      fail(`fallback resolve failed: ${err?.message ?? err}`);
    }
  }

  /* 3 — print ------------------------------------------------------- */
  console.log(`resolve result: ${JSON.stringify(resolved, null, 2)}`);
  if (!check(Boolean(resolved?.ok), `resolved via ${resolved?.providerName ?? resolved?.provider}`, "no provider produced a stream")) {
    return;
  }
  check(typeof resolved.playlistUrl === "string" && resolved.playlistUrl.startsWith("/rip/hls/"), "playlistUrl is a /rip/hls/ path", "playlistUrl missing or malformed");

  /* 4 — fetch the playlist through the proxy ------------------------ */
  const playlistUrl = `${BASE}${resolved.playlistUrl}`;
  let body = "";
  let contentType = "";
  let playlistStatus = 0;
  try {
    const res = await fetch(playlistUrl, { signal: AbortSignal.timeout(30_000) });
    playlistStatus = res.status;
    contentType = String(res.headers.get("content-type") ?? "");
    body = await res.text();
  } catch (err) {
    fail(`playlist fetch failed: ${err?.message ?? err}`);
    return;
  }
  console.log(`playlist: ${playlistUrl}`);
  console.log(`  status ${playlistStatus}, content-type ${contentType || "(none)"}, ${body.length} bytes`);
  check(playlistStatus === 200, "playlist returns 200", `playlist returns ${playlistStatus}`);

  const isM3u8 = body.startsWith("#EXTM3U") || /mpegurl/i.test(contentType) || resolved.kind === "hls";

  if (!isM3u8) {
    /* Direct MP4 passthrough. */
    console.log(`  treating as direct mp4 (kind ${resolved.kind})`);
    try {
      const res = await fetch(playlistUrl, {
        headers: { Range: "bytes=0-1023" },
        signal: AbortSignal.timeout(30_000),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      console.log(`  range fetch: status ${res.status}, ${buf.byteLength} bytes`);
      check(res.status === 206 || res.status === 200, "mp4 range request accepted", `mp4 range status ${res.status}`);
      check(buf.byteLength > 1000, `mp4 body ${buf.byteLength} bytes`, `mp4 body too short (${buf.byteLength})`);
    } catch (err) {
      fail(`mp4 range fetch failed: ${err?.message ?? err}`);
    }
    return;
  }

  const rewritten = (body.match(/\/rip\/hls\//g) ?? []).length;
  check(body.startsWith("#EXTM3U"), "playlist starts with #EXTM3U", "playlist missing #EXTM3U");
  check(rewritten > 0, `playlist has ${rewritten} rewritten child URIs`, "playlist has no rewritten child URIs");

  /* Ad sweep: no child URI may resolve to an AD_HOST. */
  const kids = children(body);
  const adKids = kids.filter((u) => AD_HOST.test(hostOf(u)));
  check(adKids.length === 0, `ad sweep clean (${kids.length} children checked)`, `ad sweep found ${adKids.length} ad-host children: ${adKids.slice(0, 3).join(", ")}`);

  /* 5 — pick a media playlist, then one segment --------------------- */
  const mediaPlaylist = kids.find((u) => /\.m3u8(\?|$)/i.test(u)) ?? null;
  let variantUrl = playlistUrl;
  let variantText = body;

  if (mediaPlaylist) {
    console.log(`  media playlist child: ${mediaPlaylist.slice(0, 140)}`);
    try {
      const res = await fetchProxied(mediaPlaylist, { signal: AbortSignal.timeout(30_000) });
      variantText = await res.text();
      console.log(`  child status ${res.status}, content-type ${res.headers.get("content-type") ?? "(none)"}`);
      console.log(`  child head: ${JSON.stringify(variantText.slice(0, 400))}`);
      check(res.status === 200, "media playlist returns 200", `media playlist returns ${res.status}`);
      check(variantText.startsWith("#EXTM3U"), "media playlist starts with #EXTM3U", "media playlist missing #EXTM3U");
      const variantKids = children(variantText);
      check(variantKids.length > 0, `media playlist has ${variantKids.length} rewritten children`, "media playlist has no rewritten children");
      const variantAds = variantKids.filter((u) => AD_HOST.test(hostOf(u)));
      check(variantAds.length === 0, "media playlist ad sweep clean", `media playlist ad sweep found ${variantAds.length} ad-host children`);
      variantUrl = `${BASE}/rip/hls/${encodeURIComponent(mediaPlaylist)}`;
    } catch (err) {
      fail(`media playlist fetch failed: ${err?.message ?? err}`);
    }
  } else {
    console.log("  playlist is already a media (variant) playlist");
  }

  const segments = children(variantText).filter((u) => !/\.m3u8(\?|$)/i.test(u));
  if (!segments.length) {
    fail("no segment found in media playlist");
    return;
  }

  const segment = segments[0];
  console.log(`  segment: ${segment.slice(0, 140)}`);
  try {
    const res = await fetchProxied(segment, {
      headers: { Range: "bytes=0-1023" },
      signal: AbortSignal.timeout(30_000),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    console.log(`  segment range: status ${res.status}, content-range ${res.headers.get("content-range") ?? "(none)"}, ${buf.byteLength} bytes`);
    check(res.status === 206 || res.status === 200, "segment range request accepted", `segment status ${res.status}`);
    check(buf.byteLength >= 1000, `segment body ${buf.byteLength} bytes`, `segment body too short (${buf.byteLength})`);
  } catch (err) {
    fail(`segment fetch failed: ${err?.message ?? err}`);
  }

  console.log(`\nref used: ${ref}`);
  console.log(`playlist exercised: ${variantUrl.slice(0, 200)}`);
}

main()
  .catch((err) => {
    fail(`selftest crashed: ${err?.stack ?? err}`);
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
