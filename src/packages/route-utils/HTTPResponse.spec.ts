import { HTTPResponse } from "./HTTPResponse";

describe("HTTPResponse", () => {
  describe("success", () => {
    it("wraps data in a { data } envelope", () => {
      expect(HTTPResponse.success({ uid: "abc" })).toEqual({
        data: { uid: "abc" },
      });
    });

    it("allows null/undefined data", () => {
      expect(HTTPResponse.success(null)).toEqual({ data: null });
      expect(HTTPResponse.success()).toEqual({ data: undefined });
    });
  });

  describe("error", () => {
    it("builds the { error, message, statusCode } envelope", () => {
      expect(
        HTTPResponse.error({
          error: "NOT_FOUND",
          message: "Missing",
          statusCode: 404,
        }),
      ).toEqual({ error: "NOT_FOUND", message: "Missing", statusCode: 404 });
    });

    it("omits reason when not provided, includes it when present", () => {
      const withoutReason = HTTPResponse.error({
        error: "FORBIDDEN",
        message: "No",
        statusCode: 403,
      });
      expect(withoutReason).not.toHaveProperty("reason");

      const withReason = HTTPResponse.error({
        error: "ALREADY_EXISTS",
        reason: "USER_EXISTS",
        message: "Dup",
        statusCode: 409,
      });
      expect(withReason.reason).toBe("USER_EXISTS");
    });
  });
});
