import { describe, it, expect } from "vitest";
import { isPlausibleAnswer, hashQuestion } from "@/lib/storage/memory";

// Pure guard (no DB): the value↔label sanity check that keeps memory clean and
// stops a captured email from being re-served into "Degree"/"Country"/etc. The
// semantic recall and rejection-propagation paths are DB+embedding coupled and
// are validated by the apply-engine integration, not here.
describe("isPlausibleAnswer — value must fit the field", () => {
  it("an email only belongs in an email field", () => {
    expect(isPlausibleAnswer("Email Address", "me@example.com")).toBe(true);
    expect(isPlausibleAnswer("Highest Degree", "me@example.com")).toBe(false);
    expect(isPlausibleAnswer("Country", "me@example.com")).toBe(false);
  });

  it("a phone number only belongs in a phone field", () => {
    expect(isPlausibleAnswer("Phone Number", "+1 (555) 010-4477")).toBe(true);
    expect(isPlausibleAnswer("School", "+1 (555) 010-4477")).toBe(false);
  });

  it("a name field rejects an email or URL", () => {
    expect(isPlausibleAnswer("First Name", "https://x.com")).toBe(false);
    expect(isPlausibleAnswer("First Name", "Jordan")).toBe(true);
  });

  it("an email field demands an actual email", () => {
    expect(isPlausibleAnswer("Email", "not an email")).toBe(false);
  });
});

describe("hashQuestion — stable, whitespace/case-insensitive", () => {
  it("normalizes case and spacing to the same hash", () => {
    expect(hashQuestion("Are You Authorized   to work?")).toBe(hashQuestion("are you authorized to work?"));
  });
  it("distinct questions hash differently", () => {
    expect(hashQuestion("years with React")).not.toBe(hashQuestion("years with Java"));
  });
});
