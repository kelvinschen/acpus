export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function apiError(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
