import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type HlsType from "hls.js";
import type { RipSub } from "../lib/rip";
import "../styles/player.css";

export interface HlsPlayerProps {
  kind: "hls" | "mp4";
  /** Root-relative sidecar path: `/rip/hls/...` or a proxied mp4. */
  src: string;
  title: string;
  /** TMDB backdrop shown while the stream buffers its first bytes. */
  poster?: string;
  /** External WebVTT tracks snarfed by the sidecar (CC outside the HLS master). */
  subs?: RipSub[];
  /** Fatal, unrecoverable failure — the parent falls back to iframe providers. */
  onUnrecoverable: () => void;
}

const NATIVE_HLS_MIME = "application/vnd.apple.mpegurl";

/** iOS-only video APIs absent from lib.dom — the documented webkit casts. */
interface WebkitVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

interface QualityLevel {
  index: number;
  width: number;
  height: number;
}

interface SubtitleTrackOption {
  id: number;
  label: string;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Subtitle sync: ±5s in half-second taps (2026-10-24 user report: some
 *  provider VTTs run early against the video). */
const SUB_DELAY_STEP = 0.5;
const SUB_DELAY_LIMIT = 5;

/** The standard rung ladder providers' master SHOULD use (2026-10-24). */
const QUALITY_LADDER = [2160, 1440, 1080, 720, 480, 360, 240, 144] as const;

/**
 * Effective 16:9-equivalent height for a level. Cinematic masters are often
 * 1920x800 (2.40:1): the 800 is the letterboxed frame height, NOT a 720p
 * encode. Width is the honest quality signal there, so an ultrawide 1920x800
 * must read 1080p, not 720p (2026-10-24 user report: "720p only max").
 */
function effectiveHeight(width: number, height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  if (Number.isFinite(width) && width > 0 && width >= height) {
    return Math.max(height, Math.round((width * 9) / 16));
  }
  return height;
}

/**
 * Snap oddball effective heights to the nearest standard rung within ±14% so
 * the picker reads the recognizable 1440/1080/720/360… ladder, while staying
 * dynamic — the sheet only ever lists what the stream genuinely contains.
 */
function ladderLabel(height: number): string {
  if (!Number.isFinite(height) || height <= 0) return "";
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const step of QUALITY_LADDER) {
    const diff = Math.abs(Math.log2(height / step));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = step;
    }
  }
  if (best !== null && Math.abs(1 - height / best) <= 0.14) return `${best}p`;
  return `${Math.round(height)}p`; // genuinely custom — show it as-is
}

type SettingsSheet = "none" | "quality" | "subs" | "speed";

function formatSubDelay(seconds: number): string {
  if (Math.abs(seconds) < 0.001) return "0.0s";
  const sign = seconds > 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(1)}s`;
}

function formatTime(seconds: number, forceHours: boolean): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = (h > 0 || forceHours ? String(m).padStart(2, "0") : String(m));
  const ss = String(s).padStart(2, "0");
  return h > 0 || forceHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** End of the last buffered range, 0 when nothing is buffered. */
function bufferedEnd(video: HTMLVideoElement): number {
  const { buffered } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
}

const PlayIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </svg>
);

const PauseIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
  </svg>
);

const FullscreenIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const QualityIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M4 18v-4M10 18V8M16 18v-7M22 18V5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * First-class ad-free playback (2026-10-24): a `<video>` we fully own, fed by
 * the Lighthook sidecar's same-origin proxied stream. No provider page ever
 * loads, so no ad host is contacted and no popunder can spawn. Safari (all
 * iDevices) plays HLS natively — HW decode, AirPlay and PiP come free; every
 * other browser gets hls.js over MSE via a dynamic import (bundle-split).
 * Fatal engine errors and a hard stall surface `onUnrecoverable` so the
 * parent can drop back to the iframe providers.
 */
export default function HlsPlayer({ kind, src, title, poster, subs, onUnrecoverable }: HlsPlayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const mountedRef = useRef(true);
  const onUnrecoverableRef = useRef(onUnrecoverable);
  const hideTimerRef = useRef(0);
  const draggingRef = useRef(false);
  const playingRef = useRef(false);

  useEffect(() => {
    onUnrecoverableRef.current = onUnrecoverable;
  }, [onUnrecoverable]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [levels, setLevels] = useState<QualityLevel[] | null>(null);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackOption[]>([]);
  const [subIdx, setSubIdx] = useState(-1);
  /** Subtitle sync offset in seconds. Positive = captions appear later. */
  const [subDelay, setSubDelay] = useState(0);
  const subDelayRef = useRef(0);
  /** Original cue times, so changing the offset never compounds. */
  const cueBaseRef = useRef(new WeakMap<TextTrackCue, { start: number; end: number }>());
  const [speed, setSpeed] = useState(1);
  const [sheet, setSheet] = useState<SettingsSheet>("none");
  const [retryNonce, setRetryNonce] = useState(0);
  const nativeTracksRef = useRef<TextTrack[]>([]);
  const [activeHeight, setActiveHeight] = useState(0); // height actually playing (Auto sub-label)
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const [flash, setFlash] = useState<{ side: "left" | "right"; text: string; key: number } | null>(null);
  const toastTimerRef = useRef(0);
  const flashTimerRef = useRef(0);
  const singleTapTimerRef = useRef(0);
  const lastTapRef = useRef<{ time: number; side: "" | "left" | "right" }>({ time: 0, side: "" });
  const seqRef = useRef(0);

  /** VidFast-style feedback pill — fades out by itself. */
  const showToast = useCallback((msg: string) => {
    if (!mountedRef.current) return;
    window.clearTimeout(toastTimerRef.current);
    seqRef.current += 1;
    setToast({ msg, key: seqRef.current });
    toastTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setToast(null);
    }, 1500);
  }, []);

  // Unmount: leave no timers firing into a dead tree.
  useEffect(() => {
    return () => {
      window.clearTimeout(toastTimerRef.current);
      window.clearTimeout(flashTimerRef.current);
      window.clearTimeout(singleTapTimerRef.current);
    };
  }, []);

  /* ------------------------------ engine ------------------------------ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let destroyed = false;
    setLevels(null);
    setCurrentLevel(-1);
    setSubtitleTracks([]);
    setSubIdx(-1);
    setActiveHeight(0);
    nativeTracksRef.current = [];

    const fail = () => {
      if (!destroyed && mountedRef.current) onUnrecoverableRef.current();
    };

    const teardownVideo = () => {
      video.removeAttribute("src");
      video.load();
    };

    let cancelled = false;
    let detachNativeSubs: (() => void) | null = null;

    void (async () => {
      // Engine choice (2026-10-24 rev): hls.js FIRST for every HLS stream it
      // can attach to — desktop, Android and, since iOS 17.1 via
      // ManagedMediaSource, iPhone/iPad too. The quality + subtitle sheets
      // feed off engine events; native Safari HLS wins on decode cost but
      // exposes NEITHER levels NOR its track-list, which made the real
      // phone's quality picker vanish (caught live: CC showed via textTracks,
      // quality never rendered). Native playback is the fallback only for
      // devices where the engine can't attach (iOS < 17.1: playback works,
      // in-app picker can't exist — Safari has no levels API there). MP4 is
      // always native.
      if (kind !== "mp4") {
        const mod = await import("hls.js");
        const Hls = mod.default;
        // The parent may have flipped to embed mode while the chunk loaded.
        if (cancelled || !mountedRef.current) return;
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            maxBufferLength: 30,
            backBufferLength: 90,
            fragLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 3,
          });
          hlsRef.current = hls;
          // ManagedMediaSource (iPhone) requires this per hls.js docs;
          // scoped to MSS devices so desktop casting is untouched.
          if (
            typeof (window as { ManagedMediaSource?: unknown }).ManagedMediaSource !==
              "undefined" &&
            "disableRemotePlayback" in video
          ) {
            video.disableRemotePlayback = true;
          }

          let networkRetried = false;
          let mediaRetried = 0;
          let otherRetried = 0;

          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            if (destroyed) return;
            setLevels(
              data.levels.map((level, index) => ({
                index,
                width: level.width,
                height: level.height,
              })),
            );
          });

          // The rung actually being served right now — labels Auto's height
          // (VidFast shows "Auto · 1080p" while it adapts).
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            if (destroyed) return;
            const active = hls.levels[data.level];
            setActiveHeight(active ? effectiveHeight(active.width, active.height) : 0);
          });

          hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
            if (destroyed) return;
            setSubtitleTracks(
              data.subtitleTracks.map((track, index) => ({
                id: typeof track.id === "number" ? track.id : index,
                label: track.name || track.lang || `Track ${index + 1}`,
              })),
            );
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (destroyed || !data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                if (!networkRetried) {
                  networkRetried = true;
                  hls.startLoad(); // one re-fetch attempt (drops the buffer cursor, not the player)
                  return;
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                if (mediaRetried < 1) {
                  mediaRetried += 1;
                  hls.recoverMediaError();
                  return;
                }
                break;
              default:
                if (otherRetried < 2) {
                  otherRetried += 1;
                  hls.startLoad();
                  return;
                }
                break;
            }
            fail();
          });

          hls.loadSource(src);
          hls.attachMedia(video);
          return;
        }
        // No usable MSE/MSS — HLS devices that answer canPlayType still
        // get real playback through Safari's internal (opaque) player.
      }

      if (kind === "hls" && !video.canPlayType(NATIVE_HLS_MIME)) {
        fail(); // neither engine nor native can touch this stream
        return;
      }

      // Native path: MP4, or HLS where the engine can't attach.
      video.src = src;

      // Subtitles come through the video's own text tracks on the native
      // path (Safari re-hydrates them from the master playlist). Read them
      // whenever metadata lands or a track gets added.
      const syncNativeSubs = () => {
        if (destroyed) return;
        // External <track> elements are the snarfed subs — exclude them from
        // the manifest/rendition list so one CC pick never double-counts.
        const external = new Set(
          [...video.querySelectorAll("track")].map((el) => el.track).filter(Boolean),
        );
        const tracks = [...video.textTracks].filter(
          (t) => t.kind === "subtitles" && !external.has(t),
        );
        nativeTracksRef.current = tracks;
        setSubtitleTracks(
          tracks.map((track, index) => ({
            id: index,
            label: track.label || track.language || `Track ${index + 1}`,
          })),
        );
      };
      video.textTracks.addEventListener?.("addtrack", syncNativeSubs);
      video.addEventListener("loadedmetadata", syncNativeSubs);
      video.addEventListener("loadeddata", syncNativeSubs);
      // The outer cleanup knows nothing about these closures — hand it a hook.
      detachNativeSubs = () => {
        video.textTracks.removeEventListener?.("addtrack", syncNativeSubs);
        video.removeEventListener("loadedmetadata", syncNativeSubs);
        video.removeEventListener("loadeddata", syncNativeSubs);
      };
    })();

    return () => {
      cancelled = true;
      destroyed = true;
      detachNativeSubs?.();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      teardownVideo();
    };
  }, [kind, src, retryNonce]);

  /* --------------------------- controls chrome ------------------------ */

  const clearHideTimer = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = 0;
  }, []);

  const armHideTimer = useCallback(() => {
    clearHideTimer();
    if (!playingRef.current || draggingRef.current) return; // paused/dragging keeps chrome up
    hideTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setShowControls(false);
    }, 2200);
  }, [clearHideTimer]);

  /** Any interaction: reveal the chrome and restart the auto-hide countdown. */
  const bumpControls = useCallback(() => {
    if (mountedRef.current) setShowControls(true);
    armHideTimer();
  }, [armHideTimer]);

  const toggleControls = useCallback(() => {
    if (showControls) {
      clearHideTimer();
      if (mountedRef.current) setShowControls(false);
    } else {
      bumpControls();
    }
  }, [showControls, bumpControls, clearHideTimer]);

  // An open sheet owns the chrome: keep the control bar up and pause the
  // auto-hide countdown. Closing the sheet starts a fresh 2.2s countdown
  // (2026-10-24: the bar used to fade out from under the CC/quality sheet).
  useEffect(() => {
    if (sheet === "none") {
      armHideTimer();
      return;
    }
    clearHideTimer();
    if (mountedRef.current) setShowControls(true);
  }, [sheet, armHideTimer, clearHideTimer]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let waitingTimer = 0;
    let stalledFor = 0; // continuous seconds with readyState < 3 while unpaused

    const onPlay = () => {
      playingRef.current = true;
      if (!mountedRef.current) return;
      setPlaying(true);
      setEnded(false);
      bumpControls();
    };
    const onPause = () => {
      playingRef.current = false;
      clearHideTimer();
      if (mountedRef.current) {
        setPlaying(false);
        setShowControls(true); // paused → chrome stays
      }
    };
    const onEndedVideo = () => {
      playingRef.current = false;
      clearHideTimer();
      if (mountedRef.current) {
        setPlaying(false);
        setEnded(true);
        setShowControls(true);
      }
    };
    const onTime = () => {
      if (mountedRef.current) setCurrentTime(video.currentTime);
    };
    const onDuration = () => {
      if (mountedRef.current) setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const onProgress = () => {
      if (mountedRef.current) setBuffered(bufferedEnd(video));
    };
    // "Buffering…" only after the wait persists past 1.2s — no flicker on seeks.
    const onWaiting = () => {
      window.clearTimeout(waitingTimer);
      waitingTimer = window.setTimeout(() => {
        if (mountedRef.current) setWaiting(true);
      }, 1200);
    };
    const onPlaying = () => {
      window.clearTimeout(waitingTimer);
      stalledFor = 0;
      if (mountedRef.current) {
        setWaiting(false);
        setStuck(false);
      }
      bumpControls();
    };
    const onSeeked = () => bumpControls();
    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      armHideTimer();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEndedVideo);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("progress", onProgress);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeked", onSeeked);
    window.addEventListener("pointerup", endDrag);
    onDuration();
    onProgress();

    // Stall watchdog: genuinely playing-but-frozen for >8s → offer a way out.
    // (A paused, seeking or loading video never counts — only the wedged state.)
    const stallTimer = window.setInterval(() => {
      if (video.readyState < 3 && !video.seeking && !video.paused) {
        stalledFor += 1;
        if (stalledFor >= 8 && mountedRef.current) setStuck(true);
      } else {
        stalledFor = 0;
      }
    }, 1000);

    return () => {
      window.clearTimeout(waitingTimer);
      window.clearInterval(stallTimer);
      window.clearTimeout(hideTimerRef.current);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEndedVideo);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeked", onSeeked);
      window.removeEventListener("pointerup", endDrag);
    };
    // Stable callbacks + a stable <video> element: listeners live for the
    // component's lifetime; engine restarts (retryNonce) don't rebind them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ actions ----------------------------- */

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (mountedRef.current) setEnded(false);
    video.play().catch(() => undefined); // autoplay policy: the tap is the gesture
  }, []);

  const replay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    play();
  }, [play]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) play();
    else video.pause();
  }, [play]);

  const skip = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      const limit = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      video.currentTime = Math.min(Math.max(video.currentTime + delta, 0), limit);
      bumpControls();
    },
    [bumpControls],
  );

  const onSeekInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const value = Number(event.target.value);
    video.currentTime = value;
    if (mountedRef.current) {
      setCurrentTime(value);
      setEnded(false);
    }
  }, []);

  const startDrag = useCallback(() => {
    draggingRef.current = true;
    bumpControls();
  }, [bumpControls]);

  const endDragLocal = useCallback(() => {
    draggingRef.current = false;
    armHideTimer();
  }, [armHideTimer]);

  const selectLevel = useCallback(
    (index: number) => {
      if (hlsRef.current) hlsRef.current.currentLevel = index; // -1 = auto
      setCurrentLevel(index);
      const level = levels?.find((l) => l.index === index);
      const height = level ? effectiveHeight(level.width, level.height) : 0;
      showToast(
        index === -1
          ? "Quality: Auto"
          : `Quality: ${height > 0 ? ladderLabel(height) : `Level ${index + 1}`}`,
      );
      setSheet("none");
      bumpControls();
    },
    [bumpControls, showToast, levels],
  );

  /** Shift every loaded subtitle cue by `delay` seconds. Base times are kept
   * in a WeakMap so repeated changes never compound, and new cues from
   * hls.js are caught by the timeupdate listener below. Positive = later. */
  const adjustSubDelay = useCallback((delta: number) => {
    setSubDelay((value) => {
      const next = Math.round((value + delta) * 10) / 10;
      return Math.max(-SUB_DELAY_LIMIT, Math.min(SUB_DELAY_LIMIT, next));
    });
  }, []);

  const applySubDelay = useCallback((delay: number) => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = Array.from(video.textTracks).filter((t) => t.kind === "subtitles");
    for (const track of tracks) {
      const cues = track.cues;
      if (!cues || cues.length === 0) continue;
      for (let i = 0; i < cues.length; i += 1) {
        const cue = cues[i];
        let base = cueBaseRef.current.get(cue);
        if (!base) {
          base = { start: cue.startTime, end: cue.endTime };
          cueBaseRef.current.set(cue, base);
        }
        const start = Math.max(0, base.start + delay);
        const end = Math.max(start + 0.001, base.end + delay);
        if (Math.abs(cue.startTime - start) > 0.0005) cue.startTime = start;
        if (Math.abs(cue.endTime - end) > 0.0005) cue.endTime = end;
      }
    }
  }, []);

  // Keep the offset applied while a track loads or hls.js appends new cues.
  useEffect(() => {
    subDelayRef.current = subDelay;
    const video = videoRef.current;
    if (!video) return;
    const apply = () => applySubDelay(subDelayRef.current);
    apply();
    // <track> cues load just after mode="showing"; hls.js may add its first
    // cues a beat later. Re-apply on the next ticks and during playback.
    const t1 = window.setTimeout(apply, 0);
    const t2 = window.setTimeout(apply, 120);
    const t3 = window.setTimeout(apply, 500);
    video.addEventListener("timeupdate", apply);
    video.addEventListener("seeked", apply);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      video.removeEventListener("timeupdate", apply);
      video.removeEventListener("seeked", apply);
    };
  }, [subDelay, subIdx, retryNonce, subtitleTracks, applySubDelay]);

  /** -1 = off. One unified CC index space (2026-10-24): choices address ALL
   * subtitle sources — external WebVTT <track>s first (0..n-1), then the
   * manifest's own rendition tracks. Picking an external shows it and pins
   * hls.subtitleTrack (or the native list) off; picking a rendition does the
   * reverse, so captions can never double-render. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const extEls = [...video.querySelectorAll("track")];
    const extCount = extEls.length;
    const pickedExt = subIdx >= 0 && subIdx < extCount;
    const engineIdx = pickedExt ? -1 : Math.max(-1, subIdx - extCount);
    extEls.forEach((el, index) => {
      const track = el.track;
      if (track) track.mode = pickedExt && index === subIdx ? "showing" : "disabled";
    });
    const hls = hlsRef.current;
    if (hls) {
      if (hls.subtitleTrack !== engineIdx) hls.subtitleTrack = engineIdx;
      return;
    }
    const native = nativeTracksRef.current;
    native.forEach((track, index) => {
      track.mode = index === engineIdx ? "showing" : "disabled";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subIdx, retryNonce, subtitleTracks]);

  /** Playback speed — engine restarts re-apply the chosen rate. */
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, retryNonce]);

  /** Stall-bar retry: destroy the engine and re-init the same source. */
  const retry = useCallback(() => {
    if (mountedRef.current) {
      setStuck(false);
      setWaiting(false);
    }
    setRetryNonce((value) => value + 1);
  }, []);

  const switchToBackup = useCallback(() => {
    if (mountedRef.current) onUnrecoverableRef.current();
  }, []);

  // 2026-10-24 — PiP removed entirely per user ("pop out player? We don't
  // need that feature"): its mini-window carried a second player chrome
  // with its own confusing options. toggleFullscreen kept.

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    const video = videoRef.current as WebkitVideo | null;
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
        return;
      }
      if (root && typeof root.requestFullscreen === "function") {
        void root.requestFullscreen().catch(() => {
          // Rejected (rare) → fall back to iOS native video fullscreen.
          video?.webkitEnterFullscreen?.();
        });
        return;
      }
      // iOS Safari has no element fullscreen: the native video player takes
      // over with its own controls — acceptable there.
      video?.webkitEnterFullscreen?.();
    } catch {
      /* ignore */
    }
  }, []);

  /* -------------------------------- view ------------------------------ */

  const durationSafe = duration > 0 ? duration : 0;
  const playedPct = durationSafe > 0 ? Math.min(100, (currentTime / durationSafe) * 100) : 0;
  const bufferedPct = durationSafe > 0 ? Math.min(100, (buffered / durationSafe) * 100) : 0;
  /**
   * Quality picker shows as soon as ANY rung is known — single-rung rips list
   * that one ("whichever is available", 2026-10-24). Effective heights bucket
   * into the standard ladder (duplicates collapse to their tallest member,
   * highest first) so the sheet reads 1440/1080/720/360… — including ultrawide
   * 1920x800 masters, which are 1080p-class and must not be called 720p.
   */
  const qualityAvailable = levels !== null && levels.length > 0;
  const qualityItems: Array<{ index: number; height: number; label: string }> =
    useMemo(() => {
      if (!levels) return [];
      const byLabel = new Map<string, { index: number; height: number; label: string }>();
      for (const level of levels) {
        const rawHeight = level.height > 0 ? level.height : 0;
        const height = effectiveHeight(level.width, rawHeight);
        if (height === 0) {
          // Heightless level: show it as Level N, no bucketing possible.
          byLabel.set(`l${level.index}`, {
            index: level.index,
            height: 0,
            label: `Level ${level.index + 1}`,
          });
          continue;
        }
        const label = ladderLabel(height);
        const previous = byLabel.get(label);
        // Same rung twice → keep the higher raw member's engine index.
        if (!previous || rawHeight > previous.height) {
          byLabel.set(label, { index: level.index, height: rawHeight, label });
        }
      }
      return [...byLabel.values()].sort((a, b) => b.height - a.height);
    }, [levels]);

  const subTracks = useMemo(() => subs ?? [], [subs]);

  return (
    <div className="hp" ref={rootRef}>
      <video
        ref={videoRef}
        className="hp-video"
        playsInline
        preload="auto"
        poster={poster}
        aria-label={title}
      >
        {subTracks.map((sub, index) => (
          <track
            key={`${sub.src}#${index}`}
            kind="subtitles"
            label={sub.label}
            src={sub.src}
          />
        ))}
      </video>

      {/* Tap surface over the video. Single tap toggles the chrome; a
          second tap on the same half within 320ms is the VidFast
          double-tap-skip (±10s) and cancels the chrome toggle. */}
      <div
        className="hp-hit"
        onClick={(event) => {
          const video = videoRef.current;
          if (!video) return;
          const rect = video.getBoundingClientRect();
          const side: "left" | "right" =
            event.clientX - rect.left < rect.width / 2 ? "left" : "right";
          const now = performance.now();
          const last = lastTapRef.current;
          if (last.side === side && now - last.time < 320) {
            lastTapRef.current = { time: 0, side: "" };
            window.clearTimeout(singleTapTimerRef.current);
            singleTapTimerRef.current = 0;
            const delta = side === "left" ? -10 : 10;
            skip(delta);
            if (mountedRef.current) {
              window.clearTimeout(flashTimerRef.current);
              seqRef.current += 1;
              setFlash({ side, text: delta > 0 ? "+10s" : "−10s", key: seqRef.current });
              flashTimerRef.current = window.setTimeout(() => {
                if (mountedRef.current) setFlash(null);
              }, 600);
            }
            return;
          }
          lastTapRef.current = { time: now, side };
          window.clearTimeout(singleTapTimerRef.current);
          // Functional updater — never a stale closure from an older render.
          singleTapTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setShowControls((value) => !value);
          }, 320);
        }}
        aria-hidden="true"
      />

      {/* Gradient scrim: text on bright frames stays legible (VidFast). */}
      {showControls && (
        <div className="hp-scrim" aria-hidden="true" />
      )}

      {waiting && !stuck && (
        <div className="hp-buffering" role="status">
          <span className="hp-spinner" aria-hidden="true" />
          <span>Buffering…</span>
        </div>
      )}

      {(!playing || ended) && !waiting && (
        <button
          type="button"
          className="hp-center"
          onClick={ended ? replay : play}
          aria-label={ended ? "Replay" : "Play"}
        >
          {PlayIcon}
        </button>
      )}

      {stuck && (
        <div className="hp-stuck" role="status">
          <span>Stream looks stuck?</span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={retry}
            aria-label="Retry playback"
          >
            Retry
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={switchToBackup}
            aria-label="Switch to a backup server"
          >
            Switch to backup
          </button>
        </div>
      )}

      <div className={`hp-controls${showControls ? " is-visible" : ""}`}>
        <div className="hp-seek">
          <div className="hp-seek-track" aria-hidden="true">
            <div className="hp-seek-buffered" style={{ width: `${bufferedPct}%` }} />
            <div className="hp-seek-played" style={{ width: `${playedPct}%` }} />
          </div>
          <input
            className="hp-seek-input"
            type="range"
            min={0}
            max={durationSafe}
            step={0.1}
            value={Math.min(currentTime, durationSafe)}
            onChange={onSeekInput}
            onPointerDown={startDrag}
            onPointerUp={endDragLocal}
            aria-label="Seek"
          />
        </div>

        <div className="hp-buttons">
          <button
            type="button"
            className="icon-btn hp-btn"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? PauseIcon : PlayIcon}
          </button>
          <button
            type="button"
            className="icon-btn hp-btn"
            onClick={() => skip(-10)}
            aria-label="Back 10 seconds"
          >
            −10
          </button>
          <button
            type="button"
            className="icon-btn hp-btn"
            onClick={() => skip(10)}
            aria-label="Forward 10 seconds"
          >
            +10
          </button>
          <span className="hp-time" aria-hidden="true">
            {formatTime(currentTime, false)} / {formatTime(durationSafe, durationSafe >= 3600)}
          </span>
          <span className="hp-spacer" />
          {/* CC is part of the player, always — even when a title carries no
              captions. The sheet tells the truth instead of hiding the control
              (2026-10-24: user could not find CC on the main player). */}
          <button
            type="button"
            className={`icon-btn hp-btn${subIdx >= 0 ? " hp-btn--on" : ""}`}
            onClick={() => setSheet((value) => (value === "subs" ? "none" : "subs"))}
            aria-label="Subtitles"
            aria-expanded={sheet === "subs"}
          >
            CC
          </button>
          <button
            type="button"
            className={`icon-btn hp-btn${speed !== 1 ? " hp-btn--on" : ""}`}
            onClick={() => setSheet((value) => (value === "speed" ? "none" : "speed"))}
            aria-label="Playback speed"
            aria-expanded={sheet === "speed"}
          >
            {speed === 1 ? "1×" : `${speed}×`}
          </button>
          {qualityAvailable && (
            <button
              type="button"
              className="icon-btn hp-btn"
              onClick={() => setSheet((value) => (value === "quality" ? "none" : "quality"))}
              aria-label="Quality"
              aria-expanded={sheet === "quality"}
            >
              {QualityIcon}
            </button>
          )}
          <button
            type="button"
            className="icon-btn hp-btn"
            onClick={toggleFullscreen}
            aria-label="Fullscreen"
          >
            {FullscreenIcon}
          </button>
        </div>
      </div>

      {toast && (
        <div className="hp-toast" role="status" key={toast.key}>
          {toast.msg}
        </div>
      )}

      {flash && (
        <div
          className={`hp-flash hp-flash--${flash.side}`}
          key={flash.key}
          aria-hidden="true"
        >
          {flash.text}
        </div>
      )}

      {sheet === "subs" && (
        <div className="hp-sheet" role="group" aria-label="Subtitles">
          {/* Explicit product label: Chrome/Android "Live Caption" is a
              browser/OS overlay we cannot toggle, so our sheet must identify
              itself instead of looking like the system captions UI. */}
          <p className="hp-cap" aria-hidden="true">Lighthook subtitles</p>
          <button
            type="button"
            className={subIdx === -1 ? "is-active" : ""}
            aria-pressed={subIdx === -1}
            onClick={() => {
              setSubIdx(-1);
              showToast("Subtitles: Off");
              setSheet("none");
            }}
          >
            <span>Off</span>
            <span className="hp-check" aria-hidden="true">{subIdx === -1 ? "✓" : ""}</span>
          </button>
          {subTracks.length === 0 && subtitleTracks.length === 0 && (
            <p className="hp-sub-empty" role="note">
              No subtitles found for this title
            </p>
          )}
          {/* External WebVTT tracks first, then manifest renditions — one
              unified index the apply effect resolves for any engine. */}
          {subTracks.map((sub, index) => (
            <button
              key={`${sub.src}#${index}`}
              type="button"
              className={subIdx === index ? "is-active" : ""}
              aria-pressed={subIdx === index}
              onClick={() => {
                setSubIdx(index);
                showToast(`Subtitles: ${sub.label}`);
                setSheet("none");
              }}
            >
              <span>{sub.label}</span>
              <span className="hp-check" aria-hidden="true">{subIdx === index ? "✓" : ""}</span>
            </button>
          ))}
          {subtitleTracks.map((track, index) => (
            <button
              key={track.id}
              type="button"
              className={subIdx === subTracks.length + index ? "is-active" : ""}
              aria-pressed={subIdx === subTracks.length + index}
              onClick={() => {
                setSubIdx(subTracks.length + index);
                showToast(`Subtitles: ${track.label}`);
                setSheet("none");
              }}
            >
              <span>{track.label}</span>
              <span className="hp-check" aria-hidden="true">
                {subIdx === subTracks.length + index ? "✓" : ""}
              </span>
            </button>
          ))}
          {/* Sync only applies when a track actually exists — showing dead
              ±0.5s buttons on a no-subtitles title would be a lie. */}
          {(subTracks.length > 0 || subtitleTracks.length > 0) && (
            <div className="hp-sub-sync">
              <p className="hp-sub-sync-label">Subtitle sync</p>
              <div className="hp-sub-sync-row">
                <button
                  type="button"
                  className="hp-sub-sync-btn"
                  onClick={() => adjustSubDelay(-SUB_DELAY_STEP)}
                  disabled={subDelay <= -SUB_DELAY_LIMIT}
                  aria-label="Show subtitles earlier by half a second"
                >
                  −0.5s
                </button>
                <button
                  type="button"
                  className="hp-sub-sync-value"
                  onClick={() => setSubDelay(0)}
                  aria-label="Reset subtitle sync to zero"
                  title="Reset subtitle sync"
                >
                  {formatSubDelay(subDelay)}
                </button>
                <button
                  type="button"
                  className="hp-sub-sync-btn"
                  onClick={() => adjustSubDelay(SUB_DELAY_STEP)}
                  disabled={subDelay >= SUB_DELAY_LIMIT}
                  aria-label="Show subtitles later by half a second"
                >
                  +0.5s
                </button>
              </div>
              <p className="hp-sub-sync-hint">
                {subDelay === 0
                  ? "Captions early? Tap +0.5s."
                  : "Positive = captions later · tap the value to reset"}
              </p>
            </div>
          )}
        </div>
      )}

      {sheet === "speed" && (
        <div className="hp-sheet" role="group" aria-label="Playback speed">
          <p className="hp-cap" aria-hidden="true">Speed</p>
          {SPEED_OPTIONS.map((rate) => (
            <button
              key={rate}
              type="button"
              className={speed === rate ? "is-active" : ""}
              aria-pressed={speed === rate}
              onClick={() => {
                setSpeed(rate);
                showToast(rate === 1 ? "Speed: Normal" : `Speed: ${rate}×`);
                setSheet("none");
              }}
            >
              <span>{rate === 1 ? "Normal (1×)" : `${rate}×`}</span>
              <span className="hp-check" aria-hidden="true">{speed === rate ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      )}

      {sheet === "quality" && qualityAvailable && (
        <div className="hp-sheet" role="group" aria-label="Quality">
          <p className="hp-cap" aria-hidden="true">Quality</p>
          <button
            type="button"
            className={currentLevel === -1 ? "is-active" : ""}
            aria-pressed={currentLevel === -1}
            onClick={() => selectLevel(-1)}
          >
            <span>Auto{activeHeight > 0 ? ` · ${ladderLabel(activeHeight)}` : ""}</span>
            <span className="hp-check" aria-hidden="true">{currentLevel === -1 ? "✓" : ""}</span>
          </button>
          {qualityItems.map((item) => (
            <button
              key={item.index}
              type="button"
              className={currentLevel === item.index ? "is-active" : ""}
              aria-pressed={currentLevel === item.index}
              onClick={() => selectLevel(item.index)}
            >
              <span>{item.label}</span>
              <span className="hp-check" aria-hidden="true">{currentLevel === item.index ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
