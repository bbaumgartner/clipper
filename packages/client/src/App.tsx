import { useCallback, useEffect, useRef, useState } from "react";
import type { Clip, Source } from "@clipper/shared";
import { api, subscribeEvents } from "./api";
import { SourcePanel } from "./components/SourcePanel";
import { ClipPanel } from "./components/ClipPanel";
import { VideoPanel } from "./components/VideoPanel";
import { OverlayPlayer, type OverlayState } from "./components/OverlayPlayer";
import type { Draft } from "./draft";

type Panel = "source" | "clips" | "video";

function toolbarLabel(clips: Clip[], status: string): string {
  const queued = clips.filter((c) => c.status === "pending").length;
  if (queued > 0) return queued === 1 ? "encoding…" : `encoding ${queued}…`;
  const n = status.trim().toLowerCase();
  if (!n || n === "ready" || n === "pending" || n === "running") return "";
  if (n.endsWith(" ready")) return "";
  return status;
}

export function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [sequenceIds, setSequenceIds] = useState<string[]>([]);
  const [sourceSort, setSourceSort] = useState<"date" | "name">("date");
  const [clipSort, setClipSort] = useState<"date" | "name">("date");
  const [focus, setFocus] = useState<Panel>("source");
  const [sourceSel, setSourceSel] = useState<string | null>(null);
  const [clipSel, setClipSel] = useState<string | null>(null);
  const [videoSel, setVideoSel] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [status, setStatus] = useState("");
  const overlayOpen = overlay !== null;
  const overlayRef = useRef(overlayOpen);
  overlayRef.current = overlayOpen;

  const reload = useCallback(async () => {
    const [s, c, seq] = await Promise.all([
      api.sources(sourceSort),
      api.clips(),
      api.sequence(),
    ]);
    setSources(s.sources);
    setClips(c.clips);
    setSequenceIds(seq.clipIds);
  }, [sourceSort]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return subscribeEvents((ev) => {
      if (ev.type === "source") {
        setSources((prev) => upsert(prev, ev.source, (x) => x.id));
      } else if (ev.type === "clip") {
        setClips((prev) => upsert(prev, ev.clip, (x) => x.id));
      } else if (ev.type === "sequence") {
        setSequenceIds(ev.clipIds);
      } else if (ev.type === "job") {
        if (ev.status === "ready") setStatus("");
        else if (ev.status === "failed") setStatus(ev.message ?? "failed");
        else if (ev.message) setStatus(ev.message);
      } else if (ev.type === "export") {
        if (ev.status === "ready") setStatus("");
        else if (ev.status === "failed") setStatus(ev.message ?? "export failed");
        else setStatus("exporting…");
      }
    });
  }, []);

  async function addFiles() {
    const paths = (await window.clipper?.selectFiles()) ?? [];
    for (const p of paths) {
      await api.addSource(p);
    }
    await reload();
  }

  async function onOverlayClose(commit: boolean, draft: Draft) {
    const current = overlay;
    overlayRef.current = false;
    setOverlay(null);
    if (commit && current?.mode === "source" && draft.segments.length > 0) {
      await api.apply(current.sourceId, draft.segments);
      await reload();
    }
  }

  async function deleteSelected() {
    if (overlayOpen) return;
    if (focus === "source" && sourceSel) {
      await api.deleteSource(sourceSel);
      setSourceSel(null);
      await reload();
    } else if (focus === "clips" && clipSel) {
      const { inSequence } = await api.clipInSequence(clipSel);
      if (inSequence && !window.confirm("This clip is in the video sequence. Delete it from the library and sequence?")) {
        return;
      }
      await api.deleteClip(clipSel);
      setClipSel(null);
      await reload();
    } else if (focus === "video" && videoSel.length) {
      const next = sequenceIds.filter((id) => !videoSel.includes(id));
      await api.setSequence(next);
      setVideoSel([]);
      await reload();
    }
  }

  async function sendToVideo() {
    if (!clipSel) return;
    const { clipIds } = await api.appendSequence(clipSel);
    setSequenceIds(clipIds);
    setFocus("video");
    setVideoSel([clipSel]);
  }

  async function clearSeq() {
    if (sequenceIds.length === 0) return;
    if (!window.confirm("Clear the video sequence? Clips stay in the library.")) return;
    try {
      const { clipIds } = await api.clearSequence();
      setSequenceIds(clipIds);
      setVideoSel([]);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportVideo() {
    const outputPath = (await window.clipper?.selectSavePath()) ?? null;
    if (!outputPath) return;
    setStatus("exporting…");
    try {
      await api.exportVideo(outputPath);
      setStatus("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function openSource(id: string) {
    const s = sources.find((x) => x.id === id);
    if (!s || s.broken) return;
    setSourceSel(id);
    setOverlay({ mode: "source", sourceId: id });
  }

  function openClip(id: string) {
    const c = clips.find((x) => x.id === id);
    if (!c || c.status === "failed") return;
    setClipSel(id);
    setOverlay({ mode: "clip", clipId: id });
  }

  function openVideo(id: string) {
    const i = sequenceIds.indexOf(id);
    if (i < 0) return;
    const c = clips.find((x) => x.id === id);
    if (!c || c.status === "failed") return;
    setVideoSel([id]);
    setOverlay({ mode: "video", startIndex: i });
  }

  function moveSourceSel(dir: number) {
    if (sources.length === 0) return;
    const i = Math.max(0, sources.findIndex((s) => s.id === sourceSel));
    const next = sources[Math.min(sources.length - 1, Math.max(0, i + dir))];
    if (next) setSourceSel(next.id);
  }

  function moveClipSel(dir: number) {
    if (clips.length === 0) return;
    const i = Math.max(0, clips.findIndex((c) => c.id === clipSel));
    const next = clips[Math.min(clips.length - 1, Math.max(0, i + dir))];
    if (next) setClipSel(next.id);
  }

  function moveVideoSel(dir: number, shift: boolean) {
    if (sequenceIds.length === 0) return;
    const current = videoSel[videoSel.length - 1] ?? sequenceIds[0];
    const i = sequenceIds.indexOf(current ?? "");
    const ni = Math.min(sequenceIds.length - 1, Math.max(0, i + dir));
    const id = sequenceIds[ni];
    if (!id) return;
    if (shift) {
      setVideoSel((prev) => Array.from(new Set([...prev, id])));
    } else {
      setVideoSel([id]);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayRef.current) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") {
        return;
      }
      if (e.key === "1") {
        setFocus("source");
        e.preventDefault();
      } else if (e.key === "2") {
        setFocus("clips");
        e.preventDefault();
      } else if (e.key === "3") {
        setFocus("video");
        e.preventDefault();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const dir = e.key === "ArrowUp" ? -1 : 1;
        if (e.altKey && focus === "video") {
          e.preventDefault();
          const ids = videoSel.length ? videoSel : [];
          if (ids.length) void api.moveSequence(ids, dir).then((r) => setSequenceIds(r.clipIds));
          return;
        }
        e.preventDefault();
        if (focus === "source") moveSourceSel(dir);
        if (focus === "clips") moveClipSel(dir);
        if (focus === "video") moveVideoSel(dir, e.shiftKey);
      } else if (e.key === "Enter") {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        if (focus === "source" && sourceSel) openSource(sourceSel);
        if (focus === "clips" && clipSel) openClip(clipSel);
        if (focus === "video") {
          const id = videoSel[0] ?? sequenceIds[0];
          if (id) openVideo(id);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void deleteSelected();
      } else if (e.key === "ArrowRight" && focus === "clips") {
        e.preventDefault();
        void sendToVideo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app">
      <header className="topbar">
        <h1>Clipper</h1>
        <span className="status">{toolbarLabel(clips, status)}</span>
      </header>
      <div className="panels">
        <SourcePanel
          focused={focus === "source"}
          sources={sources}
          selectedId={sourceSel}
          sort={sourceSort}
          onFocus={() => setFocus("source")}
          onSelect={(id) => {
            setSourceSel(id);
            openSource(id);
          }}
          onOpen={openSource}
          onAdd={() => void addFiles()}
          onSort={setSourceSort}
        />
        <ClipPanel
          focused={focus === "clips"}
          clips={clips}
          selectedId={clipSel}
          sort={clipSort}
          onFocus={() => setFocus("clips")}
          onSelect={(id) => {
            setClipSel(id);
            openClip(id);
          }}
          onOpen={openClip}
          onRetry={(id) => void api.retryClip(id).then(() => reload())}
          onSort={setClipSort}
        />
        <VideoPanel
          focused={focus === "video"}
          clips={clips}
          sequenceIds={sequenceIds}
          selectedIds={videoSel}
          onFocus={() => setFocus("video")}
          onSelect={(id, shift) => {
            if (shift) {
              setVideoSel((prev) =>
                prev.includes(id) ? prev : [...prev, id],
              );
            } else {
              openVideo(id);
            }
          }}
          onOpen={openVideo}
          onClear={() => void clearSeq()}
          onExport={() => void exportVideo()}
        />
      </div>
      {overlay ? (
        <OverlayPlayer
          overlay={overlay}
          sources={sources}
          clips={clips}
          sequenceIds={sequenceIds}
          onClose={(commit, draft) => void onOverlayClose(commit, draft)}
        />
      ) : null}
    </div>
  );
}

function upsert<T>(list: T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [item, ...list];
  const next = [...list];
  next[i] = item;
  return next;
}
