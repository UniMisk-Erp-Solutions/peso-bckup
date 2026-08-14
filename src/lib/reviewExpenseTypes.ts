/** Shared result types for the review expense loading pipeline. */

export type ReviewExpenseSourceResult = {
  source: string;
  rowsLoaded: number;
  complete: boolean;
  error: string | null;
};

export type ReviewExpenseFetchResult = {
  rows: Record<string, unknown>[];
  complete: boolean;
  totalAvailable: number | null;
  sourceResults: ReviewExpenseSourceResult[];
};
