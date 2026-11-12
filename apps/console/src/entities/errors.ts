/** A failed console API call, with the gateway's stable error code (see docs/ERRORS.md). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
