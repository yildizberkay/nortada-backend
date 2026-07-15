import { type ErrorCode, GenericError } from "./index";

describe("GenericError", () => {
  const cases: Array<[ErrorCode, number]> = [
    ["INTERNAL_ERROR", 500],
    ["FORM_ERROR", 400],
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["EXTERNAL_SERVICE_ERROR", 500],
    ["ALREADY_EXISTS", 409], // Nortada delta — brandscale used 422
    ["CONFLICT", 409],
    ["RATE_LIMIT_EXCEEDED", 429],
  ];

  it.each(cases)("maps %s to HTTP %i", (code, status) => {
    const error = new GenericError(code);
    expect(error.errorCode).toBe(code);
    expect(error.statusCode).toBe(status);
  });

  it("maps ALREADY_EXISTS to 409, not 422 (Nortada delta)", () => {
    const error = new GenericError("ALREADY_EXISTS");
    expect(error.statusCode).toBe(409);
  });

  it("carries reason and message in options", () => {
    const error = new GenericError("NOT_FOUND", {
      reason: "USER_NOT_FOUND",
      message: "User not found",
    });
    expect(error.options?.reason).toBe("USER_NOT_FOUND");
    expect(error.message).toBe("User not found");
  });

  it("defaults message to the error code when none is given", () => {
    const error = new GenericError("FORBIDDEN");
    expect(error.message).toBe("FORBIDDEN");
  });
});
