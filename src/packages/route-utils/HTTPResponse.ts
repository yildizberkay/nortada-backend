/** The client-facing error envelope shape. Single source of truth. */
export interface ErrorEnvelope {
  error: string;
  reason?: string;
  message: string;
  statusCode: number;
}

export class HTTPResponse {
  /** Success envelope: `{ data }`. */
  static success(data?: object | null) {
    return {
      data,
    };
  }

  /** Error envelope: `{ error, reason?, message, statusCode }`. */
  static error(params: ErrorEnvelope): ErrorEnvelope {
    return {
      error: params.error,
      ...(params.reason && { reason: params.reason }),
      message: params.message,
      statusCode: params.statusCode,
    };
  }
}
