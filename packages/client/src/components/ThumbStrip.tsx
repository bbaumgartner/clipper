import { useLayoutEffect, useRef, useState } from "react";
import { listThumbIndices, listThumbVisibleCount } from "@clipper/shared";
import { thumbUrl } from "../api";

export function ThumbStrip(props: {
  kind: "source" | "clip";
  id: string;
  count: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setWidth(el.clientWidth);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = listThumbVisibleCount(width, props.count);
  const indices = listThumbIndices(visible, props.count);

  return (
    <div className="thumbs" ref={ref}>
      {props.count <= 0
        ? Array.from({ length: visible }, (_, i) => <span key={i} />)
        : indices.map((thumbIndex) => (
            <img
              key={thumbIndex}
              src={thumbUrl(props.kind, props.id, thumbIndex, props.count)}
              alt=""
            />
          ))}
    </div>
  );
}
