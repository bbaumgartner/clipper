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
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const duration = props.duration || props.strip?.duration || 1;
  const magnify = props.magnify === true;
  const items = layoutFrames(props.strip, duration, props.currentTime, magnify);
  const totalW = Math.max(items.length * FRAME_W, 1);
  const playhead = xAtTime(props.currentTime, items);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const left = playhead - el.clientWidth / 2;
    el.scrollLeft = Math.max(0, left);
  }, [playhead]);

  return (
    <div className={`filmstrip-wrap${magnify ? " magnify" : ""}`} ref={scroller}>
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
        <div className="mark blue" style={{ left: playhead }} />
        {(props.marks ?? []).map((t) => (
          <div
            key={t}
            className="mark yellow"
            style={{ left: xAtTime(t, items) }}
          />
        ))}
      </div>
    </div>
  );
}
