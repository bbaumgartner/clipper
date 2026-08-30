import type { Segment } from "@clipper/shared";
import { CUT_EPSILON_SEC } from "@clipper/shared";

export type Draft = {
  segments: Segment[];
  marks: number[];
};

export const emptyDraft = (): Draft => ({ segments: [], marks: [] });

export function applyDraftCut(draft: Draft, t: number): Draft {
  const nearestLeft = Math.max(0, ...[0, ...draft.marks].filter((b) => b < t));
  if (t - nearestLeft < CUT_EPSILON_SEC) return draft;
  return {
    segments: [
      ...draft.segments.filter((s) => s.startSec < nearestLeft),
      { startSec: nearestLeft, endSec: t },
    ],
    marks: [...draft.marks.filter((m) => m <= nearestLeft), t],
  };
}
