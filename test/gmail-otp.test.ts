import { describe, it, expect } from "vitest";
import { extractOtp } from "@/lib/gmail/otp";

describe("extractOtp — keyword-anchored codes", () => {
  const cases: [string, string][] = [
    ["Your verification code is 123456", "123456"],
    ["Code: 482910", "482910"],
    ["Your one-time passcode: 90210", "90210"],
    ["Enter the code 246810 to continue.", "246810"],
    ["Your OTP is 9921", "9921"],
    ["Your security code is 04827", "04827"],
    ["Use 5821 as your verification code", "5821"],
    ["882244 is your one-time password", "882244"],
  ];
  for (const [body, expected] of cases) {
    it(`pulls ${expected} from "${body}"`, () => {
      expect(extractOtp(body)).toBe(expected);
    });
  }
});

describe("extractOtp — subject + alphanumeric + fallback", () => {
  it("reads the code from the subject line", () => {
    expect(extractOtp("", "654321 is your login code")).toBe("654321");
  });

  it("accepts a labeled alphanumeric code", () => {
    expect(extractOtp("Your code: A1B2C3")).toBe("A1B2C3");
  });

  it("falls back to a lone 6-digit number", () => {
    expect(extractOtp("Use 135790 to sign in to your account.")).toBe("135790");
  });
});

describe("extractOtp — rejects non-codes", () => {
  it("returns null when there is no code", () => {
    expect(extractOtp("Thanks for applying! We'll be in touch soon.")).toBeNull();
  });

  it("ignores a bare 4-digit year with no code context", () => {
    expect(extractOtp("Copyright 2024 Acme Corp. All rights reserved.")).toBeNull();
  });

  it("does not grab part of a phone number with no keyword", () => {
    expect(extractOtp("Call us at 1-800-555-0199 for help.")).toBeNull();
  });
});
