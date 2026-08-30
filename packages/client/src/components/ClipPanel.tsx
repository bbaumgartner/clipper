import type { Clip } from "@clipper/shared";
import { ThumbStrip } from "./ThumbStrip";

function dur(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function ClipPanel(props: {
  focused: boolean;
  clips: Clip[];
  selectedId: string | null;
  sort: "date" | "name";
  onFocus: () => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onSort: (sort: "date" | "name") => void;
}) {
  const groups = groupClips(props.clips, props.sort);
  return (
    <section
      className={`panel ${props.focused ? "focused" : ""}`}
      data-testid="panel-clips"
      onMouseDown={props.onFocus}
    >
      <div className="panel-head">
        <h2>Clips</h2>
        <select
          value={props.sort}
          onChange={(e) => props.onSort(e.target.value as "date" | "name")}
        >
          <option value="date">Date</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="list">
        {groups.map(([label, clips]) => (
          <div key={label}>
            <div className="group-label">{label}</div>
            {clips.map((c) => (
              <div
                key={c.id}
                className={`row ${props.selectedId === c.id ? "selected" : ""} ${c.status === "failed" ? "failed" : ""}`}
                data-testid={`clip-${c.id}`}
                onClick={() => props.onSelect(c.id)}
                onDoubleClick={() => c.status !== "failed" && props.onOpen(c.id)}
              >
                <div>
                  <div className="row-title">
                    <span className="name">
                      {dur(c.startSec)}–{dur(c.endSec)}
                    </span>
                    <span className="meta">{c.status}</span>
                    {c.status === "failed" ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onRetry(c.id);
                        }}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                  <ThumbStrip kind="clip" id={c.id} count={c.thumbCount} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function groupClips(clips: Clip[], sort: "date" | "name"): [string, Clip[]][] {
  const sorted = [...clips].sort((a, b) =>
    sort === "name"
      ? (a.sourceName ?? "").localeCompare(b.sourceName ?? "") || a.createdAt - b.createdAt
      : b.createdAt - a.createdAt,
  );
  const map = new Map<string, Clip[]>();
  for (const c of sorted) {
    const label = c.sourceName ?? "Orphans";
    const list = map.get(label) ?? [];
    list.push(c);
    map.set(label, list);
  }
  return [...map.entries()];
}
