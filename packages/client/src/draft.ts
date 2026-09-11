import type { Segment } from "@clipper/shared";
import { CUT_EPSILON_SEC } from "@clipper/shared";

export type Draft = {
  segments: Segment[];
  marks: number[];
};

export const emptyDraft = (): Draft => ({ segments: [], marks: [] });

function draftFromMarks(marks: number[], duration: number): Draft {
  const sorted = [...marks].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { segments: [], marks: [] };
  }
  const segments: Segment[] = [];
  let prev = 0;
  for (const m of sorted) {
    if (m - prev >= CUT_EPSILON_SEC) {
      segments.push({ startSec: prev, endSec: m });
    }
    prev = m;
  }
  if (duration - prev >= CUT_EPSILON_SEC) {
    segments.push({ startSec: prev, endSec: duration });
  }
  return { segments, marks: sorted };
}

export function applyDraftCut(draft: Draft, t: number, duration: number): Draft {
  const nearestLeft = Math.max(0, ...[0, ...draft.marks].filter((b) => b < t));
  if (t - nearestLeft < CUT_EPSILON_SEC) return draft;
  if (duration - t < CUT_EPSILON_SEC) return draft;
  return draftFromMarks([...draft.marks.filter((m) => m <= nearestLeft), t], duration);
}

export function removeDraftCut(draft: Draft, t: number, duration: number): Draft {
  const remaining = draft.marks.filter((m) => m !== t);
  if (remaining.length === draft.marks.length) return draft;
  return draftFromMarks(remaining, duration);
}

export function removeNearestLeftCut(draft: Draft, t: number, duration: number): Draft {
  const left = draft.marks.filter((m) => m <= t);
  if (left.length === 0) return draft;
  return removeDraftCut(draft, Math.max(...left), duration);
}
