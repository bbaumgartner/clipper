import { useEffect, useRef } from "react";
import type { Filmstrip } from "@clipper/shared";
import { stripFrameUrl } from "../api";

const FRAME_W = 96;

export function FilmstripView(props: {
  kind: "source" | "clip";
  id: string;
  strip: Filmstrip | null;
  currentTime: number;
  duration: number;
  marks?: number[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const duration = props.duration || props.strip?.duration || 1;
  const count = props.strip?.count ?? 0;
  const totalW = Math.max(count * FRAME_W, 1);
  const playhead = (props.currentTime / duration) * totalW;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const left = playhead - el.clientWidth / 2;
    el.scrollLeft = Math.max(0, left);
  }, [playhead]);

  return (
    <div className="filmstrip-wrap" ref={scroller}>
      <div className="filmstrip" style={{ width: totalW }}>
        {Array.from({ length: count }, (_, i) =>
          props.strip?.frames[i]?.ready ? (
            <img key={i} src={stripFrameUrl(props.kind, props.id, i)} alt="" />
          ) : (
            <div key={i} className="slot" />
          ),
        )}
        <div className="mark blue" style={{ left: playhead }} />
        {(props.marks ?? []).map((t) => (
          <div
            key={t}
            className="mark yellow"
            style={{ left: (t / duration) * totalW }}
          />
        ))}
      </div>
    </div>
  );
}
