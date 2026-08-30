import { useEffect, useRef, useState } from "react";
import {
  SEEK_JUMP_SEC,
  SEEK_STEP_SEC,
  isHtml5Safe,
  type Clip,
  type Filmstrip,
  type Source,
} from "@clipper/shared";
import { api, mediaUrl } from "../api";
import { applyDraftCut, emptyDraft, type Draft } from "../draft";
import { FilmstripView } from "./Filmstrip";

export type OverlayState =
  | { mode: "source"; sourceId: string }
  | { mode: "clip"; clipId: string }
  | { mode: "video"; startIndex: number };

type PlayItem = {
  stripKind: "source" | "clip";
  stripId: string;
  playKind: "source" | "clip";
  playId: string;
  src: string;
  start: number;
  end: number | null;
  duration: number;
  fileName: string;
  videoCodec: string;
  audioCodec: string;
};

function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function OverlayPlayer(props: {
  overlay: OverlayState;
  sources: Source[];
  clips: Clip[];
  sequenceIds: string[];
  onClose: (commit: boolean, draft: Draft) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [index, setIndex] = useState(
    props.overlay.mode === "video" ? props.overlay.startIndex : 0,
  );
  const [strip, setStrip] = useState<Filmstrip | null>(null);
  const [playSrc, setPlaySrc] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const item = resolveItem(props, index);
  const isCut = props.overlay.mode === "source";

  useEffect(() => {
    if (!item) return;
    let stop = false;
    setPlaySrc(null);
    setNote("");
    const safe = isHtml5Safe(item.fileName, item.videoCodec, item.audioCodec);
    if (safe) {
      setPlaySrc(item.src);
      return () => {
        stop = true;
      };
    }
    const waitProxy = async () => {
      setNote("Encoding a playable preview…");
      while (!stop) {
        const status = await api.playback(item.playKind, item.playId);
        if (stop) return;
        if (status.error) {
          setNote(status.error);
          return;
        }
        if (status.ready) {
          setNote("");
          setPlaySrc(mediaUrl(item.playKind, item.playId, status.proxy));
          return;
        }
        await sleep(800);
      }
    };
    void waitProxy();
    return () => {
      stop = true;
    };
  }, [item?.src, item?.playKind, item?.playId, item?.fileName, item?.videoCodec, item?.audioCodec]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item || !playSrc) return;
    let cancelled = false;
    let fallback = false;

    const tryPlay = () => {
      if (cancelled) return;
      void v.play().catch((err) => {
        console.warn("clipper: play failed", err);
      });
    };

    const onReady = () => {
      if (cancelled) return;
      if (item.start > 0.01) {
        const onSeeked = () => tryPlay();
        v.addEventListener("seeked", onSeeked, { once: true });
        v.currentTime = item.start;
      } else {
        tryPlay();
      }
    };

    const startProxy = () => {
      if (cancelled || fallback) return;
      if (playSrc.includes("proxy=1") || isHtml5Safe(item.fileName, item.videoCodec, item.audioCodec)) {
        setNote("This video could not be played.");
        return;
      }
      fallback = true;
      setNote("Encoding a playable preview…");
      void (async () => {
        while (!cancelled) {
          const status = await api.playback(item.playKind, item.playId);
          if (cancelled) return;
          if (status.error) {
            setNote(status.error);
            return;
          }
          if (status.ready) {
            setNote("");
            setPlaySrc(mediaUrl(item.playKind, item.playId, true));
            return;
          }
          await sleep(800);
        }
      })();
    };

    v.src = playSrc;
    v.load();
    v.addEventListener("loadeddata", onReady);
    v.addEventListener("error", startProxy);
    if (v.readyState >= 2) onReady();
    const timer = window.setTimeout(() => {
      if (!cancelled && v.readyState < 2) startProxy();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      v.removeEventListener("loadeddata", onReady);
      v.removeEventListener("error", startProxy);
      v.removeAttribute("src");
      v.load();
    };
  }, [playSrc, item?.start, item?.playKind, item?.playId, item?.fileName, item?.videoCodec, item?.audioCodec]);

  useEffect(() => {
    if (!item) return;
    let stop = false;
    const load = async () => {
      const next =
        item.stripKind === "source"
          ? await api.filmstripSource(item.stripId)
          : await api.filmstripClip(item.stripId);
      if (!stop) setStrip(next);
    };
    void load();
    const id = window.setInterval(() => void load(), 800);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [item?.stripKind, item?.stripId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const fired = { current: false };
    const onTime = () => {
      setTime(v.currentTime);
      if (item?.end != null && v.currentTime >= item.end - 0.02 && !fired.current) {
        fired.current = true;
        v.pause();
        if (props.overlay.mode === "video") {
          setIndex((cur) => {
            const ids = props.sequenceIds;
            for (let i = cur + 1; i < ids.length; i++) {
              const clip = props.clips.find((c) => c.id === ids[i]);
              if (clip && clip.status !== "failed") return i;
            }
            return cur;
          });
        }
      }
    };
    const onEnded = () => {
      if (props.overlay.mode !== "video") return;
      setIndex((cur) => {
        const ids = props.sequenceIds;
        for (let i = cur + 1; i < ids.length; i++) {
          const clip = props.clips.find((c) => c.id === ids[i]);
          if (clip && clip.status !== "failed") return i;
        }
        return cur;
      });
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
    };
  }, [item?.end, playSrc, props.overlay.mode, props.sequenceIds, props.clips]);

  const itemRef = useRef(item);
  itemRef.current = item;
  const isCutRef = useRef(isCut);
  isCutRef.current = isCut;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  function seek(delta: number) {
    const v = videoRef.current;
    const it = itemRef.current;
    if (!v || !it) return;
    const min = it.start;
    const max = it.end ?? it.duration;
    v.currentTime = Math.min(max, Math.max(min, v.currentTime + delta));
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function cut() {
    if (!isCutRef.current) return;
    setDraft((d) => applyDraftCut(d, videoRef.current?.currentTime ?? 0));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current(false, draftRef.current);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === "Enter" && e.metaKey && isCutRef.current) {
        e.preventDefault();
        onCloseRef.current(true, draftRef.current);
        return;
      }
      if (e.key === "Enter" && isCutRef.current) {
        e.preventDefault();
        cut();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek(e.shiftKey ? -SEEK_JUMP_SEC : -SEEK_STEP_SEC);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        seek(e.shiftKey ? SEEK_JUMP_SEC : SEEK_STEP_SEC);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!item) return null;

  return (
    <div className="overlay" data-testid="overlay">
      <div className="overlay-bar">
        <button
          className="close"
          data-testid="overlay-close"
          onClick={() => props.onClose(isCut, draft)}
          title="Close"
        >
          ×
        </button>
        <span>{formatTime(time)}</span>
        <span className="spacer" />
        {isCut ? (
          <>
            <button data-testid="cut" onClick={cut}>
              Cut
            </button>
            <button
              className="primary"
              data-testid="apply"
              onClick={() => props.onClose(true, draft)}
            >
              Apply
            </button>
          </>
        ) : null}
      </div>
      <video ref={videoRef} autoPlay playsInline preload="auto" />
      {note ? <div className="overlay-note">{note}</div> : null}
      <FilmstripView
        kind={item.stripKind}
        id={item.stripId}
        strip={strip}
        currentTime={item.end != null ? time - item.start : time}
        duration={item.end != null ? item.end - item.start : item.duration}
        marks={isCut ? draft.marks : undefined}
      />
    </div>
  );
}

function resolveItem(
  props: {
    overlay: OverlayState;
    sources: Source[];
    clips: Clip[];
    sequenceIds: string[];
  },
  index: number,
): PlayItem | null {
  if (props.overlay.mode === "source") {
    const sourceId = props.overlay.sourceId;
    const source = props.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    return {
      stripKind: "source",
      stripId: source.id,
      playKind: "source",
      playId: source.id,
      src: mediaUrl("source", source.id),
      start: 0,
      end: null,
      duration: source.duration,
      fileName: source.name,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
    };
  }
  const clipId =
    props.overlay.mode === "clip"
      ? props.overlay.clipId
      : props.sequenceIds[index];
  const clip = props.clips.find((c) => c.id === clipId);
  if (!clip || clip.status === "failed") return null;
  if (clip.status === "ready") {
    return {
      stripKind: "clip",
      stripId: clip.id,
      playKind: "clip",
      playId: clip.id,
      src: mediaUrl("clip", clip.id),
      start: 0,
      end: null,
      duration: clip.duration,
      fileName: `${clip.id}.mp4`,
      videoCodec: clip.videoCodec,
      audioCodec: clip.audioCodec,
    };
  }
  if (!clip.sourceId) return null;
  const source = props.sources.find((s) => s.id === clip.sourceId);
  return {
    stripKind: "clip",
    stripId: clip.id,
    playKind: "source",
    playId: clip.sourceId,
    src: mediaUrl("source", clip.sourceId),
    start: clip.startSec,
    end: clip.endSec,
    duration: clip.endSec,
    fileName: source?.name ?? "source.mp4",
    videoCodec: source?.videoCodec ?? clip.videoCodec,
    audioCodec: source?.audioCodec ?? clip.audioCodec,
  };
}
