export type AccountRequestKind = "initial" | "refresh" | "retry";
export type RetryState = "idle" | "pending" | "failed";

export interface RetryPresentation {
  readonly ariaBusy: boolean;
  readonly buttonDisabled: boolean;
  readonly buttonLabel: string;
  readonly visibleStatus: string | null;
}

export function isLinkActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

export function retryPresentation(state: RetryState): RetryPresentation {
  if (state === "pending") {
    return {
      ariaBusy: true,
      buttonDisabled: true,
      buttonLabel: "Trying again…",
      visibleStatus: "Checking your connection…",
    };
  }
  if (state === "failed") {
    return {
      ariaBusy: false,
      buttonDisabled: false,
      buttonLabel: "Try again",
      visibleStatus:
        "The connection is still unavailable. You can safely try again.",
    };
  }
  return {
    ariaBusy: false,
    buttonDisabled: false,
    buttonLabel: "Try again",
    visibleStatus: null,
  };
}

export function accountConnectionStatus(
  requestKind: AccountRequestKind,
  result: "pending" | "success" | "failure" | "signed-out",
): string {
  if (result === "signed-out") {
    return "Sign in to open your library.";
  }
  if (result === "pending") {
    return requestKind === "retry"
      ? "Checking your library connection…"
      : "Opening your library…";
  }
  if (result === "success") {
    return requestKind === "retry"
      ? "Connection restored. Your library is open."
      : "Your library is open.";
  }
  return requestKind === "retry"
    ? "The connection is still unavailable. Your progress is safe; try again when you are ready."
    : "Your library connection is unavailable. Your progress is safe.";
}
