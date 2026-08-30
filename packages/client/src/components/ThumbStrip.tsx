import { LIST_THUMB_COUNT } from "@clipper/shared";
import { thumbUrl } from "../api";

export function ThumbStrip(props: {
  kind: "source" | "clip";
  id: string;
  count: number;
}) {
  const n = Math.min(LIST_THUMB_COUNT, props.count);
  return (
    <div className="thumbs">
      {Array.from({ length: LIST_THUMB_COUNT }, (_, i) =>
        i < n ? (
          <img key={i} src={thumbUrl(props.kind, props.id, i)} alt="" />
        ) : (
          <span key={i} style={{ width: 72, background: "#111" }} />
        ),
      )}
    </div>
  );
}
