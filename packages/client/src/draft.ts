import type { Segment } from "@clipper/shared";
import { CUT_EPSILON_SEC } from "@clipper/shared";

export type Draft = {
  segments: Segment[];
  marks: number[];
};

export const emptyDraft = (): Draft => ({ segments: [], marks: [] });

function draftFromMarks(marks: number[]): Draft {
  const sorted = [...marks].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let prev = 0;
  for (const m of sorted) {
    if (m - prev >= CUT_EPSILON_SEC) {
      segments.push({ startSec: prev, endSec: m });
    }
    prev = m;
  }
  return { segments, marks: sorted };
}

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

export function removeDraftCut(draft: Draft, t: number): Draft {
  const remaining = draft.marks.filter((m) => m !== t);
  if (remaining.length === draft.marks.length) return draft;
  return draftFromMarks(remaining);
}

export function removeNearestLeftCut(draft: Draft, t: number): Draft {
  const left = draft.marks.filter((m) => m <= t);
  if (left.length === 0) return draft;
  return removeDraftCut(draft, Math.max(...left));
}
