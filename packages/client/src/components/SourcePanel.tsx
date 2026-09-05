import type { Source } from "@clipper/shared";
import { ThumbStrip } from "./ThumbStrip";

function dur(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function SourcePanel(props: {
  focused: boolean;
  sources: Source[];
  selectedId: string | null;
  extractingIds: Set<string>;
  sort: "date" | "name";
  onFocus: () => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onSort: (sort: "date" | "name") => void;
}) {
  return (
    <section
      className={`panel ${props.focused ? "focused" : ""}`}
      data-testid="panel-source"
      onMouseDown={props.onFocus}
    >
      <div className="panel-head">
        <h2>Source</h2>
        <button type="button" className="primary" onClick={props.onAdd}>
          Add
        </button>
        <select
          value={props.sort}
          onChange={(e) => props.onSort(e.target.value as "date" | "name")}
        >
          <option value="date">Date</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="list">
        {props.sources.map((s) => (
          <div
            key={s.id}
            className={`row ${props.selectedId === s.id ? "selected" : ""} ${s.broken ? "broken" : ""}`}
            data-testid={`source-${s.id}`}
            onClick={() => props.onSelect(s.id)}
            onDoubleClick={() => !s.broken && props.onOpen(s.id)}
          >
            <div>
              <div className="row-title">
                <span className="name">{s.name}</span>
                <span className="meta">{dur(s.duration)}</span>
                {s.broken ? <span className="badge">missing</span> : null}
              </div>
              <ThumbStrip
                kind="source"
                id={s.id}
                count={s.thumbCount}
                extracting={props.extractingIds.has(s.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
