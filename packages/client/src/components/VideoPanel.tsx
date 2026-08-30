import type { Clip } from "@clipper/shared";
import { ThumbStrip } from "./ThumbStrip";

function dur(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function VideoPanel(props: {
  focused: boolean;
  clips: Clip[];
  sequenceIds: string[];
  selectedIds: string[];
  onFocus: () => void;
  onSelect: (id: string, shift: boolean) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section
      className={`panel ${props.focused ? "focused" : ""}`}
      data-testid="panel-video"
      onMouseDown={props.onFocus}
    >
      <div className="panel-head">
        <h2>Video</h2>
      </div>
      <div className="list">
        {props.sequenceIds.map((id, i) => {
          const c = props.clips.find((x) => x.id === id);
          if (!c) return null;
          return (
            <div
              key={`${id}-${i}`}
              className={`row ${props.selectedIds.includes(id) ? "selected" : ""} ${c.status === "failed" ? "failed" : ""}`}
              data-testid={`seq-${id}`}
              onClick={(e) => props.onSelect(id, e.shiftKey)}
              onDoubleClick={() => c.status !== "failed" && props.onOpen(id)}
            >
              <div>
                <div className="row-title">
                  <span className="name">
                    {i + 1}. {c.sourceName ?? "orphan"} {dur(c.duration)}
                  </span>
                  <span className="meta">{c.status}</span>
                </div>
                <ThumbStrip kind="clip" id={c.id} count={c.thumbCount} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
