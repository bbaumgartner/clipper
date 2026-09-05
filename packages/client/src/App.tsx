import { useCallback, useEffect, useRef, useState } from "react";
import type { Clip, JobEvent, Source } from "@clipper/shared";
import { api, subscribeEvents } from "./api";
import { SourcePanel } from "./components/SourcePanel";
import { ClipPanel, visibleClips } from "./components/ClipPanel";
import { VideoPanel } from "./components/VideoPanel";
import { OverlayPlayer, type OverlayState } from "./components/OverlayPlayer";
import type { Draft } from "./draft";

type Panel = "source" | "clips" | "video";

function jobKey(ev: JobEvent): string {
  const entity = ev.sourceId ? "source" : ev.clipId ? "clip" : "job";
  const id = ev.sourceId ?? ev.clipId ?? "job";
  return `${ev.kind ?? "job"}:${entity}:${id}`;
}

function toolbarLabel(clips: Clip[], jobs: Map<string, string>, extra: string): string {
  const queued = clips.filter((c) => c.status === "pending").length;
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (raw: string) => {
    const n = raw.trim();
    if (!n) return;
    const k = n.toLowerCase();
    if (k === "ready" || k === "pending" || k === "running") return;
    if (k.endsWith(" ready")) return;
    if (seen.has(k)) return;
    seen.add(k);
    parts.push(n);
  };
  if (queued > 0) add(queued === 1 ? "encoding…" : `encoding ${queued}…`);
  for (const msg of jobs.values()) add(msg);
  add(extra);
  return parts.join(" · ");
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
  const [jobs, setJobs] = useState<Map<string, string>>(() => new Map());
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
    return subscribeEvents(
      (ev) => {
        if (ev.type === "source") {
          setSources((prev) => upsert(prev, ev.source, (x) => x.id));
        } else if (ev.type === "clip") {
          setClips((prev) => upsert(prev, ev.clip, (x) => x.id));
        } else if (ev.type === "sequence") {
          setSequenceIds(ev.clipIds);
        } else if (ev.type === "job") {
          const key = jobKey(ev);
          setJobs((prev) => {
            const next = new Map(prev);
            if (ev.status === "ready") next.delete(key);
            else if (ev.status === "failed") next.set(key, ev.message ?? "failed");
            else if (ev.message) next.set(key, ev.message);
            else next.delete(key);
            return next;
          });
          if (ev.status === "failed") setStatus(ev.message ?? "failed");
        } else if (ev.type === "export") {
          if (ev.status === "ready") setStatus("");
          else if (ev.status === "failed") setStatus(ev.message ?? "export failed");
          else setStatus("exporting…");
        }
      },
      () => {
        void reload();
      },
    );
  }, [reload]);

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

  async function clearClips() {
    if (clips.length === 0) return;
    if (
      !window.confirm(
        "All clips will be removed from the library and deleted from disk, including any in the video sequence. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      await api.clearClips();
      setClips([]);
      setClipSel(null);
      setSequenceIds([]);
      setVideoSel([]);
      await reload();
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

  function focusPanel(panel: Panel) {
    setFocus(panel);
    if (panel === "source") {
      if (!sourceSel || !sources.some((s) => s.id === sourceSel)) {
        const first = sources[0];
        if (first) setSourceSel(first.id);
      }
    } else if (panel === "clips") {
      if (!clipSel || !clips.some((c) => c.id === clipSel)) {
        const first = visibleClips(clips, clipSort)[0];
        if (first) setClipSel(first.id);
      }
    } else if (panel === "video") {
      if (videoSel.every((id) => !sequenceIds.includes(id))) {
        const first = sequenceIds[0];
        if (first) setVideoSel([first]);
      }
    }
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
        e.preventDefault();
        focusPanel("source");
      } else if (e.key === "2") {
        e.preventDefault();
        focusPanel("clips");
      } else if (e.key === "3") {
        e.preventDefault();
        focusPanel("video");
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
      } else if (e.key === "+" && focus === "source") {
        e.preventDefault();
        void addFiles();
      } else if (e.key === "e" && focus === "video") {
        e.preventDefault();
        void exportVideo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app">
      <header className="topbar">
        <h1>Clipper</h1>
        <span className="status">{toolbarLabel(clips, jobs, status)}</span>
      </header>
      <div className="panels">
        <SourcePanel
          focused={focus === "source"}
          sources={sources}
          selectedId={sourceSel}
          extractingIds={extractingIds("thumbs", "source", jobs)}
          sort={sourceSort}
          onFocus={() => focusPanel("source")}
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
          extractingIds={extractingIds("thumbs", "clip", jobs)}
          sort={clipSort}
          onFocus={() => focusPanel("clips")}
          onSelect={(id) => {
            setClipSel(id);
            openClip(id);
          }}
          onOpen={openClip}
          onRetry={(id) => void api.retryClip(id).then(() => reload())}
          onSort={setClipSort}
          onClear={() => void clearClips()}
        />
        <VideoPanel
          focused={focus === "video"}
          clips={clips}
          sequenceIds={sequenceIds}
          selectedIds={videoSel}
          onFocus={() => focusPanel("video")}
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

function extractingIds(kind: string, entity: "source" | "clip", jobs: Map<string, string>): Set<string> {
  const prefix = `${kind}:${entity}:`;
  const ids = new Set<string>();
  for (const key of jobs.keys()) {
    if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  return ids;
}

function upsert<T>(list: T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [item, ...list];
  const next = [...list];
  next[i] = item;
  return next;
}
