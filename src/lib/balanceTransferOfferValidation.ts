export const MIN_TRANSFER_REJECTION_REASON_LENGTH = 3;

export function validateTransferRejectionReason(reason: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = String(reason ?? "").trim();
  if (trimmed.length < MIN_TRANSFER_REJECTION_REASON_LENGTH) {
    return {
      valid: false,
      error: "rejectionReasonTooShort",
    };
  }
  return { valid: true };
}
