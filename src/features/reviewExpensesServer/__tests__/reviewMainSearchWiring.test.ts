/**
 * MAIN Review search wiring guard (hotfix/review-search-main).
 *
 * The Executive/Manager Review search on main had reverted to the old
 * enrichment-dependent free-text input (expenseRowMatchesSearch over locally
 * loaded rows), which drops an employee's rows before their name/ID is enriched
 * and confuses employee 6174 with transaction 06174. These assertions pin the
 * proven single-bar search into EngineerReview so the regression cannot recur.
 *
 * The submit-driven behaviour itself (zero requests while typing, 6174 →
 * immutable user_id, 06174 never matched, ambiguous → picker, txn:/# → expense
 * path) is runtime-tested against useSingleBarSearch in
 * reviewEmployeeFilterAndBatchState.test.tsx. Because /review renders exactly one
 * page (EngineerReview) for Manager, Executive and Team Leader, wiring it here
 * restores the search identically for all three roles.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const engineerReview = readFileSync(
  resolve(process.cwd(), "src/pages/EngineerReview.tsx"),
  "utf-8",
);

describe("EngineerReview wires the proven single-bar Review search", () => {
  it("imports the proven search hook and UI (not a bespoke input)", () => {
    expect(engineerReview).toMatch(
      /import \{ useSingleBarSearch \} from "@\/features\/reviewQueueServer\/hooks\/useSingleBarSearch"/,
    );
    expect(engineerReview).toMatch(
      /import \{ ReviewSearchBar \} from "@\/features\/reviewExpensesServer\/ReviewSearchBar"/,
    );
    expect(engineerReview).toMatch(
      /import \{ ReviewEmployeeResultsPopover \} from "@\/features\/reviewExpensesServer\/ReviewEmployeeResultsPopover"/,
    );
  });

  it("instantiates useSingleBarSearch with the organization and renders ReviewSearchBar", () => {
    expect(engineerReview).toMatch(/useSingleBarSearch\(\{\s*organizationId:/);
    expect(engineerReview).toMatch(/<ReviewSearchBar/);
    expect(engineerReview).toMatch(/<ReviewEmployeeResultsPopover/);
    // The disambiguation popover is shown on the ambiguous state.
    expect(engineerReview).toMatch(/singleBar\.state === "choose_employee"/);
  });

  it("filters rows by the immutable resolved user_id, not by name/ID text", () => {
    expect(engineerReview).toMatch(/selectedEmployeeUserId\s*=\s*singleBar\.selectedEmployee\?\.user_id/);
    expect(engineerReview).toMatch(/exp\.user_id === selectedEmployeeUserId/);
  });

  it("no longer uses the old free-text employee-search input as the search bar", () => {
    // The specific old placeholder that searched employee/ID/name locally is gone.
    expect(engineerReview).not.toMatch(/placeholder="Search employee, employee ID, project/);
    // And the search input is no longer bound directly to setSearchTerm on change.
    expect(engineerReview).not.toMatch(/value=\{searchTerm\}\s*onChange=\{\(e\) => setSearchTerm/);
  });
});
