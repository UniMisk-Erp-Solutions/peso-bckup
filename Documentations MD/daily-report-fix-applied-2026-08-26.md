# Daily Project Report — fix applied — 2026-08-26

**Doc ID:** DOC-140 follow-up (applied) (formerly DOC-113 follow-up) (renumbered on the 2026-10-05 upstream sync — see DOC-143; the pre-sync `peso-bckup` index gave this a different ID than upstream's independently-numbered catalog)
**Status:** deployed to backup instance. NOT applied to Production.
**Scope:** MicroLink organization, approved expenses only (10,457 of 12,946 total — the exact population the Daily Project Report itself shows; this is narrower than the original analysis doc, which covered all statuses — see correction note below).
**Supersedes:** `daily-report-gap-analysis-2026-08-26.md` for the two categories the user asked to be applied; that file's other categories (ambiguous, flagged, medium-confidence) still stand as-is.

## What was actually done

Three changes, in this order:

1. **390 Project Name values written** — deterministic recovery. Each is the real name someone else already recorded for that exact Project ID elsewhere in the organization; inserted under the specific per-project branch field the expense was missing a value for. Not a guess.
2. **73 Project ID values written** — same-employee nearest-neighbor prediction, HIGH confidence only (every neighbor checked — up to 5 before and 5 after, same employee — agreed unanimously).
3. **The actual report bug fixed** — `get_daily_project_report_page_v1` (and its helper `_daily_report_parse_source_v1`) now support a `dynamic` field-source kind. MicroLink's `daily_expense_report_config.fieldMappings.projectName` was switched from a fixed field id that didn't exist (`template:7ae2b9f5-...`) to `dynamic:project_name_by_project_id`, which resolves each row's Project Name from the specific branch that belongs to *that row's own* Project ID — correct by construction, for every project, forever, not just for today's gaps. Migration: `supabase/migrations/20260826100000_daily_report_dynamic_project_name.sql`.

## Important correction from the original analysis doc

The original analysis (`daily-report-gap-analysis-2026-08-26.md`) reported 12,754 "deterministic recoveries" and 88 "high-confidence Project ID predictions." Both numbers were **wrong**, found and corrected before anything was written:

- The 12,754 figure checked blankness against the *broken* report field, not the *real* database state. Once checked correctly, **12,376 of those 12,946 "blank" project names already existed in the database** under the correct per-project field — they were never actually missing, only invisible to the broken report query. Writing predicted data for them would have been both wrong and unnecessary; the actual fix was the report-logic bug (#3 above), which makes all 12,376 appear correctly with zero data written.
- Both original counts (12,754 and 88) also included non-approved expenses (draft/submitted/rejected), which never appear in the Daily Project Report at all — only `status='approved'` expenses do. Scoping to the correct population changed the real counts to **390** and **73**.

Every number below was re-verified against the live backup database via a SQL dry-run before any write executed, and every write was followed by a live before/after row-count check.

## Verification

| Check | Result |
|---|---|
| Project Name write: dry-run count vs. actual INSERT count | 390 = 390 |
| Project Name write: `expense_form_field_values` row count, before → after | 61,836 → 62,226 (+390) |
| Project ID write: candidate list vs. actual INSERT count | 73 = 73 |
| Project ID write: `expense_form_field_values` row count, before → after | 62,226 → 62,299 (+73) |
| Report config after fix | `fieldMappings.projectName` = `dynamic:project_name_by_project_id` |
| Remaining blank Project Name after fix (live re-check) | 136 = 132 genuinely flagged + 4 deliberately-untouched ambiguous rows — exact match, nothing lost, nothing over-applied |

## What was deliberately left untouched (per your instruction — nothing else was touched)

### Project Name — ambiguous (4 expenses, 2 Project IDs with more than one name on record)

Not applied. More than one name has genuinely been recorded for these Project IDs — picking one would be a guess dressed up as a fact.

**Project ID `197001M3`** — recorded names: `project_id 197001M3 has MULTIPLE recorded names: [('Support', 23), ('Training', 9)] -- majority (23/32)`

| Voucher No | Employee | Employee Code | Date |
|---|---|---|---|
| 01023 | Aman Jaiswal | 6826 | 2026-07-03 |
| 01437 | Gajanand Matre | 6860 | 2026-07-06 |
| 01438 | Gajanand Matre | 6860 | 2026-07-06 |
| 01069 | Nand Lal Paswan | 5944 | 2026-07-03 |

### Project Name — flagged, no value exists anywhere (132 expenses)

No canonical value exists for these Project IDs across the whole organization — nobody has ever recorded that project's name. Not applied, not guessed.

| Voucher No | Employee | Employee Code | Date | Project ID |
|---|---|---|---|---|
| 00516 | Aman Jaiswal | 6826 | 2026-07-01 | (also blank) |
| 00517 | Aman Jaiswal | 6826 | 2026-07-01 | (also blank) |
| 00779 | Aman Jaiswal | 6826 | 2026-07-02 | (also blank) |
| 00780 | Aman Jaiswal | 6826 | 2026-07-02 | (also blank) |
| 04611 | Amit Pathak | 6380 | 2026-07-17 | (also blank) |
| 04776 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 04778 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 04777 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 05928 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 05926 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 05927 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 08483 | Amit Pathak | 6380 | 2026-07-31 | (also blank) |
| Cctv mantince | Ankit Dixit | 6634 | 2026-08-03 | (also blank) |
| 00404 | Arunbhai Prakashkumar Gupta | 6942 | 2026-07-01 | 202606M277 |
| 01168 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01165 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01166 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01169 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01177 | Aswinkumar | 6546 | 2026-07-03 | (also blank) |
| NRO | Audumbar Nagnath Gaikwad | 6688 | 2026-07-15 | (also blank) |
| 05178 | Bhavesh Hirabhai Prajapati | 6842 | 2026-07-21 | (also blank) |
| 02184 | Chintukumar Rupeshkumar Choursiya | 6541 | 2026-07-08 | (also blank) |
| CCTV camera Installation | Dinesh Chandra Patel | 6432 | 2026-07-23 | (also blank) |
| 00478 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00474 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00472 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00476 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00479 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00477 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00726 | Gautam Meena | 6815 | 2026-07-02 | (also blank) |
| 00727 | Gautam Meena | 6815 | 2026-07-02 | (also blank) |
| 00939 | Gautam Meena | 6815 | 2026-07-03 | (also blank) |
| 00940 | Gautam Meena | 6815 | 2026-07-03 | (also blank) |
| 01214 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| 01212 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| 01213 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| 06922 | Jayesh Patel | 6101 | 2026-07-27 | (also blank) |
| 06921 | Jayesh Patel | 6101 | 2026-07-27 | (also blank) |
| 07773 | Jayesh Patel | 6101 | 2026-07-31 | (also blank) |
| 07772 | Jayesh Patel | 6101 | 2026-07-31 | (also blank) |
| 01110 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01115 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01114 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01111 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01113 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01112 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01118 | K. Ramesh Babu | 5437 | 2026-07-03 | (also blank) |
| 01117 | K. Ramesh Babu | 5437 | 2026-07-03 | (also blank) |
| 01144 | K. Ramesh Babu | 5437 | 2026-07-04 | (also blank) |
| 00937 | Krishna Kumar Rajak | 6664 | 2026-07-03 | (also blank) |
| 00938 | Krishna Kumar Rajak | 6664 | 2026-07-03 | (also blank) |
| 00530 | Kuldeep Patel | 6223 | 2026-07-01 | (also blank) |
| 00532 | Kuldeep Patel | 6223 | 2026-07-01 | (also blank) |
| 00768 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00805 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00806 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00767 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 01064 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01067 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01068 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01063 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01454 | Kuldeep Patel | 6223 | 2026-07-06 | (also blank) |
| 01497 | Kuldeep Patel | 6223 | 2026-07-06 | 202605M126 |
| 01498 | Kuldeep Patel | 6223 | 2026-07-06 | 202605M126 |
| 01453 | Kuldeep Patel | 6223 | 2026-07-06 | (also blank) |
| 00531 | Kunal Singh Kori | 6920 | 2026-07-01 | (also blank) |
| 00533 | Kunal Singh Kori | 6920 | 2026-07-01 | (also blank) |
| 00781 | Kunal Singh Kori | 6920 | 2026-07-02 | (also blank) |
| 00782 | Kunal Singh Kori | 6920 | 2026-07-02 | (also blank) |
| 01082 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01080 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01081 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01083 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| It work | Kunal Singh Kori | 6920 | 2026-07-07 | (also blank) |
| Engineer visit to locking system installation | Manohar Kumar | 6490 | 2026-07-09 | (also blank) |
| Atg interlock work | Manohar Kumar | 6490 | 2026-07-20 | (also blank) |
| 01078 | Mayur Patel | 5740 | 2026-07-03 | 202606M231 |
| 00771 | Nand Lal Paswan | 5944 | 2026-07-02 | (also blank) |
| 00772 | Nand Lal Paswan | 5944 | 2026-07-02 | (also blank) |
| 02859 | Nilesh Ramshi Vaghela | 6840 | 2026-07-11 | (also blank) |
| 07068 | Pavankumar Prahladbhai Ramchandani | 6887 | 2026-07-22 | (also blank) |
| Bio Metric Issue | Pratham Chokshi | 6883 | 2026-07-28 | (also blank) |
| CCTV | Pravin Gaund | 6828 | 2026-07-29 | (also blank) |
| 02563 | Rajat Shakyawar | 5476 | 2026-07-01 | (also blank) |
| 02564 | Rajat Shakyawar | 5476 | 2026-07-03 | (also blank) |
| 10683 | Rajeshkumar Chauhan | 3702 | 2026-08-10 | (also blank) |
| 00553 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00547 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00552 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00548 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00549 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00554 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00773 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00774 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00775 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00574 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00576 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00572 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00575 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00573 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 06832 | Sagar Nareshbhai Koshti | 3890 | 2026-07-27 | (also blank) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-08 | (also blank) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-30 | (also blank) |
| 10400 | Shanis Parmanand Gupta | 6444 | 2026-08-01 | (also blank) |
| 01505 | Vaibhav Mathankar | 6585 | 2026-07-05 | 202310M522 |
| 03515 | Vipin Kumar Kumhar | 6215 | 2026-07-14 | (also blank) |
| 00799 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00802 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00800 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00801 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 01015 | Virendrasinh Mahida | 6118 | 2026-07-03 | (also blank) |
| It work | Virendrasinh Mahida | 6118 | 2026-08-01 | (also blank) |
| 00485 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00487 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00488 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00482 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00484 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00489 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00486 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00483 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| Nro | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| 00749 | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| 00748 | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| 00944 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00948 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00947 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00946 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00941 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00943 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00942 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00945 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| Opt | Yuvraj Ratan | 6805 | 2026-07-06 | (also blank) |

### Project ID — neighbor prediction, MEDIUM confidence, NOT applied (17 expenses)

Neighbors disagree with a majority (>=75% of 3+), not unanimous. You asked for only the HIGH-confidence bucket to be applied — these were left alone.

| Voucher No | Employee | Employee Code | Date | Would-be prediction | Evidence |
|---|---|---|---|---|---|
| 01168 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01165 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01166 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01169 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01177 | Aswinkumar | 6546 | 2026-07-03 | 202508M328 | 9/10 neighbors agree; minority: {'202508M327': 1} |
| NRO | Audumbar Nagnath Gaikwad | 6688 | 2026-07-15 | 202310M551 | 9/10 neighbors agree; minority: {'202508M328': 1} |
| 05178 | Bhavesh Hirabhai Prajapati | 6842 | 2026-07-21 | 202510M515 | 9/10 neighbors agree; minority: {'202606M229': 1} |
| 01110 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01115 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01114 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01111 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01113 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01112 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 6/8 neighbors agree; minority: {'202508M327': 2} |
| 01118 | K. Ramesh Babu | 5437 | 2026-07-03 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| 01117 | K. Ramesh Babu | 5437 | 2026-07-03 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| 01144 | K. Ramesh Babu | 5437 | 2026-07-04 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| Atg interlock work | Manohar Kumar | 6490 | 2026-07-20 | 202508M327 | 8/10 neighbors agree; minority: {'202508M328': 2} |

### Project ID — flagged, unresolvable (37 expenses)

No same-employee neighbor has a Project ID value at all, or neighbors are split with no majority.

| Voucher No | Employee | Employee Code | Date |
|---|---|---|---|
| 00516 | Aman Jaiswal | 6826 | 2026-07-01 |
| 00517 | Aman Jaiswal | 6826 | 2026-07-01 |
| 00779 | Aman Jaiswal | 6826 | 2026-07-02 |
| 00780 | Aman Jaiswal | 6826 | 2026-07-02 |
| 07773 | Jayesh Patel | 6101 | 2026-07-31 |
| 07772 | Jayesh Patel | 6101 | 2026-07-31 |
| 00530 | Kuldeep Patel | 6223 | 2026-07-01 |
| 00532 | Kuldeep Patel | 6223 | 2026-07-01 |
| 00768 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00805 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00806 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00767 | Kuldeep Patel | 6223 | 2026-07-02 |
| 01064 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01067 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01068 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01063 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01454 | Kuldeep Patel | 6223 | 2026-07-06 |
| 01453 | Kuldeep Patel | 6223 | 2026-07-06 |
| 00531 | Kunal Singh Kori | 6920 | 2026-07-01 |
| 00533 | Kunal Singh Kori | 6920 | 2026-07-01 |
| 00781 | Kunal Singh Kori | 6920 | 2026-07-02 |
| 00782 | Kunal Singh Kori | 6920 | 2026-07-02 |
| 01082 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01080 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01081 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01083 | Kunal Singh Kori | 6920 | 2026-07-04 |
| It work | Kunal Singh Kori | 6920 | 2026-07-07 |
| 00771 | Nand Lal Paswan | 5944 | 2026-07-02 |
| 00772 | Nand Lal Paswan | 5944 | 2026-07-02 |
| 02859 | Nilesh Ramshi Vaghela | 6840 | 2026-07-11 |
| 07068 | Pavankumar Prahladbhai Ramchandani | 6887 | 2026-07-22 |
| Bio Metric Issue | Pratham Chokshi | 6883 | 2026-07-28 |
| 00799 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00802 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00800 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00801 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 01015 | Virendrasinh Mahida | 6118 | 2026-07-03 |

## Summary

| Category | Count | Action taken |
|---|---|---|
| Project Name — deterministic recovery | 390 | **Written** |
| Project Name — ambiguous | 4 | Left alone, listed above |
| Project Name — flagged unresolvable | 132 | Left alone, listed above |
| Project ID — neighbor prediction, HIGH | 73 | **Written** |
| Project ID — neighbor prediction, MEDIUM | 17 | Left alone, listed above |
| Project ID — flagged unresolvable | 37 | Left alone, listed above |
| Report field-mapping bug | — | **Fixed** (migration `20260826100000`) |

All writes are idempotent (guarded with `NOT EXISTS`) — safe to re-run this migration or the write scripts without risk of duplication. Nothing here touches Production; backup instance (`pesowise-backup-supabase.unimisk.com`) only.
