const COURSE_QUERY_PARAMETER = "course";

export function courseIdFromPageUrl(pageUrl: string): string | null {
  try {
    const values = new URL(pageUrl).searchParams.getAll(COURSE_QUERY_PARAMETER);
    const value = values[0];
    return values.length !== 1 ||
      value === undefined ||
      value.trim().length === 0
      ? null
      : value;
  } catch {
    return null;
  }
}

export function browserCourseId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return courseIdFromPageUrl(window.location.href);
}

export function courseIdToRestore(
  accessibleCourseIds: readonly string[],
  preferredCourseId?: string | null,
): string | null {
  if (
    preferredCourseId !== null &&
    preferredCourseId !== undefined &&
    accessibleCourseIds.includes(preferredCourseId)
  ) {
    return preferredCourseId;
  }
  return accessibleCourseIds[0] ?? null;
}

export function pageUrlForCourse(pageUrl: string, courseId: string | null) {
  const url = new URL(pageUrl);
  if (courseId === null) {
    url.searchParams.delete(COURSE_QUERY_PARAMETER);
  } else {
    url.searchParams.set(COURSE_QUERY_PARAMETER, courseId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function replaceBrowserCourse(courseId: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  const pageUrl = pageUrlForCourse(window.location.href, courseId);
  const currentPageUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (pageUrl === currentPageUrl) {
    return;
  }
  window.history.replaceState(window.history.state, "", pageUrl);
}

export function pushBrowserCourse(courseId: string) {
  if (typeof window === "undefined" || browserCourseId() === courseId) {
    return;
  }
  window.history.pushState(
    window.history.state,
    "",
    pageUrlForCourse(window.location.href, courseId),
  );
}
