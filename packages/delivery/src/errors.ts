export type DeliveryErrorCode =
  | "authorization_denied"
  | "conflicting_duplicate"
  | "delivery_expired"
  | "dispatch_ambiguous"
  | "dispatch_failed"
  | "invalid_configuration"
  | "invalid_input"
  | "invalid_signature"
  | "link_redeemed"
  | "not_found";

export class DeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) {
    super(code);
    this.name = "DeliveryError";
  }
}
