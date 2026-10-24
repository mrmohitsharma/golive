/**
 * Consistent error shape for every API response:
 *   { "error": { "code": "camera_not_found", "message": "Human readable text" } }
 * The mobile apps (Android and iOS) map `code` to UI behaviour and show `message`.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
