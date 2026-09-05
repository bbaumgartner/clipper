import { useEffect, useRef } from "react";
import { FILMSTRIP_FRAME_WIDTH, filmstripVisibleIndices, type Filmstrip } from "@clipper/shared";
import { stripFrameUrl } from "../api";

const FRAME_W = FILMSTRIP_FRAME_WIDTH;

type LaidOut = { index: number; time: number; x: number; width: number; ready: boolean };

function layoutFrames(
  strip: Filmstrip | null,
  duration: number,
  currentTime: number,
  magnify: boolean,
): LaidOut[] {
  const count = strip?.count ?? 0;
  if (count <= 0) return [];
  const indices = filmstripVisibleIndices(count, duration, currentTime, magnify);
  return indices.map((index, i) => {
    const frame = strip?.frames[index];
    return {
      index,
      time: frame?.time ?? 0,
      x: i * FRAME_W,
      width: FRAME_W,
      ready: frame?.ready ?? false,
    };
  });
}

function secondsToPrevCut(currentTime: number, marks: number[]): number {
  const prev = Math.max(0, ...[0, ...marks].filter((m) => m < currentTime));
  return Math.max(0, currentTime - prev);
}

function formatSeconds(sec: number): string {
  return `${sec.toFixed(1)}s`;
}

function xAtTime(t: number, items: LaidOut[]): number {
  if (items.length === 0) return 0;
  const centers = items.map((it) => ({ t: it.time, x: it.x + it.width / 2 }));
  const first = centers[0];
  const last = centers[centers.length - 1];
  if (!first || !last) return 0;
  if (t <= first.t) return first.x;
  if (t >= last.t) return last.x;
  for (let i = 1; i < centers.length; i++) {
    const b = centers[i];
    const a = centers[i - 1];
    if (!a || !b || t > b.t) continue;
    const span = b.t - a.t;
    const u = span > 0 ? (t - a.t) / span : 0;
    return a.x + u * (b.x - a.x);
  }
  return last.x;
}

export function FilmstripView(props: {
  kind: "source" | "clip";
  id: string;
  strip: Filmstrip | null;
  currentTime: number;
  duration: number;
  magnify?: boolean;
  marks?: number[];
  onCut?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const duration = props.duration || props.strip?.duration || 1;
  const magnify = props.magnify === true;
  const items = layoutFrames(props.strip, duration, props.currentTime, magnify);
  const totalW = Math.max(items.length * FRAME_W, 1);
  const playhead = xAtTime(props.currentTime, items);
  const canCut = props.onCut != null;
  const gapSec = secondsToPrevCut(props.currentTime, props.marks ?? []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const left = playhead - el.clientWidth / 2;
    el.scrollLeft = Math.max(0, left);
  }, [playhead]);

  return (
    <div
      className={`filmstrip-wrap${magnify ? " magnify" : ""}${canCut ? " has-cut" : ""}`}
      ref={scroller}
    >
      <div className="filmstrip" style={{ width: totalW }}>
        {items.map((item) =>
          item.ready ? (
            <img
              key={item.index}
              src={stripFrameUrl(props.kind, props.id, item.index)}
              alt=""
            />
          ) : (
            <div key={item.index} className="slot" />
          ),
        )}
        {(props.marks ?? []).map((t) => (
          <div
            key={t}
            className="mark yellow"
            style={{ left: xAtTime(t, items) }}
          />
        ))}
        <div className="playhead" style={{ left: playhead }}>
          <div className="playhead-line" />
          {canCut ? (
            <div className="playhead-foot">
              <span className="playhead-gap" data-testid="cut-gap">
                {formatSeconds(gapSec)}
              </span>
              <button
                type="button"
                className="playhead-cut"
                data-testid="cut"
                title="Cut at playhead"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCut?.();
                }}
              >
                Cut
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
