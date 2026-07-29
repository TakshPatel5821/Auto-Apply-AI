import { describe, it, expect } from "vitest";
import { matchDropdownOptionScored, type DropdownOption } from "@/lib/profile/dropdown-intelligence";

const opts = (...texts: string[]): DropdownOption[] => texts.map((t) => ({ value: t, text: t }));

describe("dropdown fallback ladder (opt-in, non-sensitive only)", () => {
  it("stays ambiguous by default (no fallback flag)", () => {
    const m = matchDropdownOptionScored("New", opts("New York", "New Jersey"), "state");
    expect(m.ambiguous).toBe(true);
  });

  it("resolves an ambiguous tie deterministically (first match) when fallback allowed", () => {
    const m = matchDropdownOptionScored("New", opts("New York", "New Jersey"), "state", { allowFallback: true });
    expect(m.ambiguous).toBe(false);
    expect(m.value).toBe("New York");
  });

  it("token-overlap fallback matches reordered words", () => {
    const m = matchDropdownOptionScored("Remote - US", opts("US Remote", "Onsite"), undefined, { allowFallback: true });
    expect(m.value).toBe("US Remote");
    expect(m.ambiguous).toBe(false);
  });

  it("fallback never invents a match when nothing relates", () => {
    const m = matchDropdownOptionScored("Astrophysics", opts("Yes", "No"), undefined, { allowFallback: true });
    expect(m.value).toBeNull();
  });

  it("default behavior is unchanged for a clean exact match", () => {
    const m = matchDropdownOptionScored("Texas", opts("Texas", "California"), "state");
    expect(m.value).toBe("Texas");
    expect(m.score).toBe(1);
  });
});
