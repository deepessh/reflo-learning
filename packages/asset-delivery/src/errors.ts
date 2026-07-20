export type PrivateDeliveryErrorCode =
  | "authorization_unavailable"
  | "configuration_invalid"
  | "deletion_incomplete"
  | "integrity_check_failed"
  | "not_found_or_forbidden"
  | "signing_unavailable";

export class PrivateDeliveryError extends Error {
  readonly safeCode: PrivateDeliveryErrorCode;

  constructor(safeCode: PrivateDeliveryErrorCode) {
    super(safeMessage(safeCode));
    this.name = "PrivateDeliveryError";
    this.safeCode = safeCode;
  }
}

function safeMessage(code: PrivateDeliveryErrorCode): string {
  switch (code) {
    case "authorization_unavailable":
      return "private resource authorization is unavailable";
    case "configuration_invalid":
      return "private delivery configuration is invalid";
    case "deletion_incomplete":
      return "private resource deletion is incomplete";
    case "integrity_check_failed":
      return "private resource integrity check failed";
    case "not_found_or_forbidden":
      return "private resource is unavailable";
    case "signing_unavailable":
      return "private resource signing is unavailable";
  }
}
