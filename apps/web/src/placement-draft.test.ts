import { describe, expect, it } from "vitest";

import {
  clearPlacementDraft,
  readPlacementDraft,
  storePlacementDraft,
} from "./placement-draft";
import type { PlacementQuestion } from "./placement-view";

describe("placement draft persistence", () => {
  it("restores text and valid keyed drafts independently per course and question", () => {
    const storage = memoryStorage();
    const keyedQuestion = question("keyed", "multiple_choice", ["A", "B"]);
    const textQuestion = question("text", "short_answer", null);

    storePlacementDraft(storage, "course-a", keyedQuestion.id, "B");
    storePlacementDraft(storage, "course-a", textQuestion.id, "draft answer");

    expect(readPlacementDraft(storage, "course-a", keyedQuestion)).toBe("B");
    expect(readPlacementDraft(storage, "course-a", textQuestion)).toBe(
      "draft answer",
    );
    expect(readPlacementDraft(storage, "course-b", keyedQuestion)).toBe("");
  });

  it("rejects a stale keyed draft that is not an option", () => {
    const storage = memoryStorage();
    const keyedQuestion = question("keyed", "multiple_choice", ["A", "B"]);
    storePlacementDraft(storage, "course", keyedQuestion.id, "old option");

    expect(readPlacementDraft(storage, "course", keyedQuestion)).toBe("");
  });

  it("clears a draft after submission or an explicit empty edit", () => {
    const storage = memoryStorage();
    const textQuestion = question("text", "short_answer", null);
    storePlacementDraft(storage, "course", textQuestion.id, "draft answer");
    clearPlacementDraft(storage, "course", textQuestion.id);
    expect(readPlacementDraft(storage, "course", textQuestion)).toBe("");

    storePlacementDraft(storage, "course", textQuestion.id, "another draft");
    storePlacementDraft(storage, "course", textQuestion.id, "");
    expect(readPlacementDraft(storage, "course", textQuestion)).toBe("");
  });
});

function question(
  id: string,
  itemType: PlacementQuestion["itemType"],
  responseOptions: readonly string[] | null,
): PlacementQuestion {
  return {
    difficulty: 1,
    id,
    itemType,
    position: 1,
    prompt: "Question",
    responseOptions,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}
