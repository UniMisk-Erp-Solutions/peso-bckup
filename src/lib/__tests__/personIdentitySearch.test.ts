import { describe, it, expect } from "vitest";
import {
  employeeIdFromSyntheticEmail,
  buildPersonIdentityTokens,
  matchesPersonIdentitySearch,
  formatPersonIdentitySubline,
} from "@/lib/personIdentitySearch";
import { resolveOrganizationIdentityPolicy } from "@/lib/organizationIdentityMode";

const emailOnly = resolveOrganizationIdentityPolicy(false, false);
const mixed = resolveOrganizationIdentityPolicy(true, false);
const eidOnly = resolveOrganizationIdentityPolicy(true, true);

const syntheticEmail = "emp.acme.EMP001.ab12cd3ef456@users.unimisk.com";

describe("employeeIdFromSyntheticEmail", () => {
  it("parses employee ID from synthetic email", () => {
    expect(employeeIdFromSyntheticEmail(syntheticEmail)).toBe("EMP001");
  });

  it("returns '' for regular email", () => {
    expect(employeeIdFromSyntheticEmail("john@example.com")).toBe("");
  });

  it("returns '' for empty string", () => {
    expect(employeeIdFromSyntheticEmail("")).toBe("");
  });
});

describe("buildPersonIdentityTokens", () => {
  const person = {
    name: "Ramesh Patel",
    email: "ramesh@example.com",
    employee_id: "EMP042",
    role: "employee",
  };

  it("4. email_only includes email", () => {
    const tokens = buildPersonIdentityTokens(person, emailOnly);
    expect(tokens).toContain("ramesh@example.com");
  });

  it("5. email_only does not require employee_id token", () => {
    const tokens = buildPersonIdentityTokens(person, emailOnly);
    expect(tokens).not.toContain("emp042");
  });

  it("6. mixed includes email", () => {
    const tokens = buildPersonIdentityTokens(person, mixed);
    expect(tokens.some((t) => t.includes("ramesh"))).toBe(true);
  });

  it("7. mixed includes employee_id", () => {
    const tokens = buildPersonIdentityTokens(person, mixed);
    expect(tokens).toContain("emp042");
  });

  it("8. employee_id_only includes employee_id", () => {
    const tokens = buildPersonIdentityTokens(person, eidOnly);
    expect(tokens).toContain("emp042");
  });

  it("9. employee_id_only does NOT include genuine email", () => {
    const tokens = buildPersonIdentityTokens(person, eidOnly);
    expect(tokens).not.toContain("ramesh@example.com");
  });

  it("10. employee_id_only does NOT include full synthetic email", () => {
    const personWithSynthetic = { ...person, email: syntheticEmail, employee_id: null };
    const tokens = buildPersonIdentityTokens(personWithSynthetic, eidOnly);
    expect(tokens).not.toContain(syntheticEmail.toLowerCase());
    expect(tokens.every((t) => !t.includes("@"))).toBe(true);
  });

  it("11. employee_id_only fallback parses only ID fragment from synthetic email", () => {
    const personWithSynthetic = { ...person, email: syntheticEmail, employee_id: null };
    const tokens = buildPersonIdentityTokens(personWithSynthetic, eidOnly);
    expect(tokens).toContain("emp001");
  });

  it("14. name search works in all modes", () => {
    for (const policy of [emailOnly, mixed, eidOnly]) {
      const tokens = buildPersonIdentityTokens(person, policy);
      expect(tokens.some((t) => t.includes("ramesh"))).toBe(true);
    }
  });

  it("role is included in tokens", () => {
    const tokens = buildPersonIdentityTokens(person, emailOnly);
    expect(tokens).toContain("employee");
  });
});

describe("matchesPersonIdentitySearch", () => {
  const person = {
    name: "Kavita Shah",
    email: "kavita@example.com",
    employee_id: "KS007",
    role: "manager",
  };

  it("15. empty query returns true in all modes", () => {
    for (const policy of [emailOnly, mixed, eidOnly]) {
      expect(matchesPersonIdentitySearch(person, "", policy)).toBe(true);
      expect(matchesPersonIdentitySearch(person, "   ", policy)).toBe(true);
    }
  });

  it("16. whitespace-normalised query matches", () => {
    expect(matchesPersonIdentitySearch(person, "  kavita  ", emailOnly)).toBe(true);
  });

  it("case-insensitive name match", () => {
    expect(matchesPersonIdentitySearch(person, "KAVITA", emailOnly)).toBe(true);
  });

  it("email_only: email matched", () => {
    expect(matchesPersonIdentitySearch(person, "kavita@example.com", emailOnly)).toBe(true);
  });

  it("employee_id_only: genuine email NOT matched", () => {
    expect(matchesPersonIdentitySearch(person, "kavita@example.com", eidOnly)).toBe(false);
  });

  it("employee_id_only: employee_id matched", () => {
    expect(matchesPersonIdentitySearch(person, "KS007", eidOnly)).toBe(true);
  });

  it("mixed: both email and employee_id matched", () => {
    expect(matchesPersonIdentitySearch(person, "kavita@example.com", mixed)).toBe(true);
    expect(matchesPersonIdentitySearch(person, "KS007", mixed)).toBe(true);
  });

  it("extras are searched", () => {
    expect(
      matchesPersonIdentitySearch(person, "मैनेजर", emailOnly, ["मैनेजर"]),
    ).toBe(true);
  });
});

describe("formatPersonIdentitySubline", () => {
  const person = {
    name: "Ankit Desai",
    email: "ankit@example.com",
    employee_id: "AD123",
  };

  it("email_only returns email", () => {
    expect(formatPersonIdentitySubline(person, emailOnly)).toBe("ankit@example.com");
  });

  it("employee_id mode returns formatted ID", () => {
    expect(formatPersonIdentitySubline(person, eidOnly)).toBe("ID: AD123");
  });

  it("employee_id mode with missing ID returns fallback", () => {
    const noId = { ...person, employee_id: null };
    expect(formatPersonIdentitySubline(noId, eidOnly)).toBe("Employee ID unavailable");
  });

  it("12. synthetic email is NEVER returned as display subline", () => {
    const noId = { ...person, employee_id: null, email: syntheticEmail };
    const result = formatPersonIdentitySubline(noId, eidOnly);
    expect(result).not.toContain("@");
    expect(result).not.toBe(syntheticEmail);
  });

  it("synthetic email fallback shows parsed ID, not email", () => {
    const noId = { ...person, employee_id: null, email: syntheticEmail };
    const result = formatPersonIdentitySubline(noId, eidOnly);
    expect(result).toBe("ID: EMP001");
  });
});
