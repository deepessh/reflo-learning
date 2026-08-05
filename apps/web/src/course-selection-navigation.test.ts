import { describe, expect, it } from "vitest";

import {
  courseIdFromPageUrl,
  courseIdToRestore,
  pageUrlForCourse,
} from "./course-selection-navigation";

describe("course selection navigation", () => {
  it("reads only a nonblank course identity from an absolute page URL", () => {
    expect(
      courseIdFromPageUrl(
        "https://app.reflo.example/?course=course-b&view=knowledge",
      ),
    ).toBe("course-b");
    expect(
      courseIdFromPageUrl("https://app.reflo.example/?view=knowledge"),
    ).toBe(null);
    expect(
      courseIdFromPageUrl("https://app.reflo.example/?course=%20%20"),
    ).toBe(null);
    expect(
      courseIdFromPageUrl(
        "https://app.reflo.example/?course=course-a&course=course-b",
      ),
    ).toBe(null);
    expect(courseIdFromPageUrl("not a page URL")).toBe(null);
  });

  it("preserves unrelated query parameters and the hash while adding a course", () => {
    expect(
      pageUrlForCourse(
        "https://app.reflo.example/library?view=knowledge&panel=history#course-map",
        "course/b",
      ),
    ).toBe(
      "/library?view=knowledge&panel=history&course=course%2Fb#course-map",
    );
  });

  it("restores only an accessible opaque identity and falls back deterministically", () => {
    const accessibleCourseIds = ["duplicate-title-a", "duplicate-title-b"];
    expect(courseIdToRestore(accessibleCourseIds, "duplicate-title-b")).toBe(
      "duplicate-title-b",
    );
    expect(courseIdToRestore(accessibleCourseIds, "not-accessible")).toBe(
      "duplicate-title-a",
    );
    expect(courseIdToRestore([], "not-accessible")).toBe(null);
  });

  it("replaces every stale course parameter without changing other navigation state", () => {
    expect(
      pageUrlForCourse(
        "https://app.reflo.example/?course=old&view=knowledge&course=stale#map",
        "course-new",
      ),
    ).toBe("/?course=course-new&view=knowledge#map");
  });

  it("removes course selection while preserving other query parameters and the hash", () => {
    expect(
      pageUrlForCourse(
        "https://app.reflo.example/library?course=old&view=knowledge#map",
        null,
      ),
    ).toBe("/library?view=knowledge#map");
  });
});
