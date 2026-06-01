import { describe, it, expect } from "vitest";
import {
  matchDropdownOptionScored,
  matchDropdownOption,
  normalizeDegreeLevel,
  type DropdownOption,
} from "@/lib/profile/dropdown-intelligence";

const opts = (...texts: string[]): DropdownOption[] => texts.map((t) => ({ value: t, text: t }));

describe("matchDropdownOptionScored", () => {
  it("exact normalized match scores 1.0", () => {
    const m = matchDropdownOptionScored("Texas", opts("Texas", "California"), "state");
    expect(m.value).toBe("Texas");
    expect(m.score).toBe(1);
    expect(m.ambiguous).toBe(false);
  });

  it("state abbreviation expands to the full name", () => {
    const m = matchDropdownOptionScored("TX", opts("Texas", "California"), "state");
    expect(m.value).toBe("Texas");
  });

  it("country alias USA → United States", () => {
    const m = matchDropdownOptionScored("USA", opts("United States", "United Kingdom"), "country");
    expect(m.value).toBe("United States");
  });

  it("degree M.S. → Master's", () => {
    expect(normalizeDegreeLevel("M.S.")).toBe("Master's");
    const m = matchDropdownOptionScored("M.S.", opts("Bachelor's", "Master's", "Doctorate"), "degree");
    expect(m.value).toBe("Master's");
  });

  it("yes maps to a 'Yes, I am authorized' style option (prefix match, not ambiguous)", () => {
    const m = matchDropdownOptionScored("Yes", opts("Yes, I am authorized", "No"), "yesno");
    expect(m.value).toBe("Yes, I am authorized");
    expect(m.ambiguous).toBe(false);
  });

  it("flags ambiguous when two options tie", () => {
    const m = matchDropdownOptionScored("New", opts("New York", "New Jersey"), "state");
    expect(m.ambiguous).toBe(true);
    // back-compat helper fails safe on ambiguity
    expect(matchDropdownOption("New", opts("New York", "New Jersey"), "state")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    const m = matchDropdownOptionScored("Mars", opts("Yes", "No"), "yesno");
    expect(m.value).toBeNull();
    expect(m.score).toBe(0);
  });

  it("ignores placeholder options", () => {
    const m = matchDropdownOptionScored("Select...", opts("Select...", "Texas"), "state");
    // "Select..." should not be a valid match target
    expect(m.value).not.toBe("Select...");
  });
});
