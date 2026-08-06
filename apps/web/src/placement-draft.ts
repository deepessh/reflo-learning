import type { PlacementQuestion } from "./placement-view";

interface PlacementDraftStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function placementDraftKey(courseId: string, questionId: string): string {
  return `reflo:placement-draft:v1:${courseId}:${questionId}`;
}

export function readPlacementDraft(
  storage: PlacementDraftStorage,
  courseId: string,
  question: PlacementQuestion,
): string {
  const draft = storage.getItem(placementDraftKey(courseId, question.id)) ?? "";
  if (question.itemType === "short_answer") return draft;
  return question.responseOptions?.includes(draft) === true ? draft : "";
}

export function storePlacementDraft(
  storage: PlacementDraftStorage,
  courseId: string,
  questionId: string,
  draft: string,
): void {
  const key = placementDraftKey(courseId, questionId);
  if (draft === "") {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, draft);
}

export function clearPlacementDraft(
  storage: PlacementDraftStorage,
  courseId: string,
  questionId: string,
): void {
  storage.removeItem(placementDraftKey(courseId, questionId));
}
