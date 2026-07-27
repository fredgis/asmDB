export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "obo_exchange_failed"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "share_unreadable"
  | "upstream_too_large"
  | "upstream_malformed"
  | "cdc_gap"
  | "cdc_corrupt"
  | "rate_limited";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function errorBody(error: HttpError): { error: Record<string, unknown> } {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ?? {}),
    },
  };
}
