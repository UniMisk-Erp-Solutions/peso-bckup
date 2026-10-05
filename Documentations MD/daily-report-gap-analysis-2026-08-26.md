# Daily Project Report gap analysis — 2026-08-26

**Doc ID:** DOC-140 (formerly DOC-113) (renumbered on the 2026-10-05 upstream sync — see DOC-143; the pre-sync `peso-bckup` index gave this a different ID than upstream's independently-numbered catalog)

**Status:** analysis only, nothing written to the database.
**Scope:** MicroLink organization (`6709c1fe-e8c8-404d-bc68-d1edda923344`), all 12,946 expenses.
**Requested by:** user, in response to blank Voucher No / project id / project name cells in the Daily Project Report.

## 0. The blank cells are not deleted data

Before predicting anything, I checked the live backup database directly. The blank cells are **not** the result of deleted rows:

- **Voucher No** is populated on essentially every expense (18,287/18,368 across the whole database, 0 blanks in the MicroLink sample pulled for this analysis) — it wasn't actually the problem despite appearing in the screenshot's header.
- **project id** is blank on 149/12,946 MicroLink expenses (1.2%) — plausible "employee left an optional field blank," not deletion.
- **project name** was blank on **all 12,946** MicroLink expenses before this analysis. That's not data loss either — it's a **real, fixable bug**: the organization's Daily Report field mapping (`organization_settings.daily_expense_report_config.fieldMappings.projectName`) points at field id `7ae2b9f5-9c7a-456c-9403-314680526741`, which **does not exist anywhere in the schema** (not a template, not a branch field, zero matches). The report query was always joining against a phantom field id and getting nothing back.

### The actual architecture (and the real fix)

"Project Name" is not one field. It is a **dependent branch field**, scoped separately to each of the 510 distinct Project ID values an employee can pick — 506 of those Project ID values have their own "Project Name" branch. Concretely: an expense's real project name isn't found by matching one fixed field id; it's found by (1) reading the expense's own Project ID value, then (2) looking up the *specific* Project Name branch that belongs to *that* Project ID, then (3) reading the value recorded there.

This means the report's field-mapping design ("one fixed field id per report column") is structurally wrong for a field that's actually per-project. **The durable fix is to correct the report generation query to resolve Project Name dynamically per-project (via the branch's `parent_option_value`), not to just swap in a different fixed id** — I have not made this code change; it needs your sign-off since it touches the live report-generation SQL function. I'm flagging it here because fixing it once would make this whole class of gap disappear for every future report run, not just today's.

## 1. Project Name — recovered deterministically (real data, not a guess)

**12754 of 12946 blank project-name cells (98.5%) recovered this way.** For each, the project's name was actually recorded — by that employee or another — under the correct dependent branch field for that exact Project ID; this analysis just reunited the two. Grouped by Project ID (not one row per expense) since the same real value applies to every expense sharing that Project ID.

| Project ID | Recovered Project Name | Expenses affected |
|---|---|---|
| 199601M1 | At Office | 45 |
| 199601M2 | SURVEY | 32 |
| 201904M522 | Courtesy - Sales 2019-20 | 63 |
| 201904M523 | Courtesy - SSE 2019-20 | 66 |
| 201904M525 | Courtesy 2019-20 | 56 |
| 201904M531 | At Office 2019-20 | 4 |
| 202106M297 | GIFT City Gandhinagar ELV | 110 |
| 202108M566 | Polycab_Unit8 Asoj ELV | 34 |
| 202108M567 | Polycab Hyderabad ELV | 7 |
| 202108M568 | Polycab- Unit3 Experience Center ELV | 8 |
| 202207M1240 | Torrent Ahmedabad IT Services | 7 |
| 202210M767 | Polycab Halol ELV | 39 |
| 202210M769 | Polycab Daman ELV | 5 |
| 202303M1249 | GSPL Gandhinagar Networking System Infra | 9 |
| 202307M212 | ISRO Ahmedabad CCTV Surveillance System | 4 |
| 202307M319 | Polycab Halol Networking | 31 |
| 202307M323 | Polycab Daman Networking | 18 |
| 202308M331 | MSU Baroda ELV Networking | 103 |
| 202308M388 | RBML Solutions CAI services for rebranding With store | 14 |
| 202310M522 | Troikaa Dahej ELV Project | 11 |
| 202310M550 | RBML West Region NRO Project. FOR COCO | 1 |
| 202310M551 | RBML NRO Project. COCO | 298 |
| 202310M567 | Reliance NRO - DODO | 613 |
| 202312M722 | Polycab Halol Collaboration Impl & Services | 6 |
| 202401M679 | Lubi Ahmedabad IT Services | 6 |
| 202404M56 | Harsha Engineers IT FMS Support L1 | 1 |
| 202405M117 | Revenue Department Gandhinagar | 6 |
| 202405M129 | GSFC Baroda IT Services | 1 |
| 202406M228 | Torrent Gas Multiple Locations ELV Project | 29 |
| 202406M232 | Torrent GAS Multiple Locations CAMC of CCTV system | 142 |
| 202406M233 | Torrent Gas Chennai CAMC of CCTV | 11 |
| 202406M234 | Torrent Gas Jaipur CAMC of CCTV | 7 |
| 202408M391 | Loxim Ahmedabad Networking | 1 |
| 202408M412 | Amneal Rajoda Networking | 8 |
| 202409M437 | GIFTCT Gandhinagar Networking & ELV | 20 |
| 202409M470 | Revenue Gandhinagar Networking, ELV , Collaboration & System Infra | 2 |
| 202410M588 | Intas Matoda Networking | 359 |
| 202411M630 | Emcure Gandhinagar Networking & ELV | 4 |
| 202412M707 | Intas Moraiya Networking | 12 |
| 202412M758 | Reliance Prayagraj Networking, ELV, collaboration & System Infra | 117 |
| 202412M759 | Reliance Barabanki Networking, ELV, Collaboration & System Infra | 53 |
| 202412M761 | RCAML Hoshiarpur Networking, ELV, Collaboration & System Infra | 17 |
| 202412M764 | RBEL Satna Networking, ELV, Collaboration & System Infra | 28 |
| 202412M766 | RBEL Kakinada-1 Networking, ELV, Collaboration & System Infra | 5 |
| 202412M767 | RBEL Kakinada-2 Networking, ELV, Collaboration & System Infra | 7 |
| 202412M769 | RBEL Bhopal Networking, ELV, Collaboration & System Infra | 10 |
| 202412M770 | RBEL Raipur Networking, ELV, Collaboration & System Infra | 11 |
| 202412M772 | RBEL Nellore Networking, ELV, Collaboration & System Infra | 23 |
| 202502M833 | S.Mehta Torrent Ahmedabad Networking & ELV & AMC | 24 |
| 202503M890 | Intas Moraiya Networking | 5 |
| 202503M948 | Reliance Jamnagar Networking | 9 |
| 202504M17 | Intas Dehradun Networking | 134 |
| 202504M54 | Gunnebo Halol Networking & ELV | 8 |
| 202504M93 | Reliance Silvassa IT Services | 2 |
| 202505M105 | Intas Moraiya Networking | 7 |
| 202505M114 | Intas Ahmedabad Networking , ELV & Collaboration | 1 |
| 202505M115 | ONGC Ahmedabad Collaboration | 24 |
| 202505M82 | Intas Moraiya Networking | 2 |
| 202505M87 | MGVCL Baroda IT Services | 28 |
| 202505M92 | ESIC Ahmedabad ELV | 26 |
| 202506M166 | MS Vadodara Services | 173 |
| 202506M169 | Dynatech Ahmedabad Networking | 24 |
| 202506M183 | IAR Gandhinagar Networking | 10 |
| 202507M243 | Torrent Gas Ahmedabad Implementation | 8 |
| 202507M259 | Reliance CBG Nagothane Implementation | 10 |
| 202507M297 | Reliance Pan India Automation | 6 |
| 202507M298 | Rubamin Halol Implementation | 31 |
| 202508M320 | Arcelormittal Sanand Networking & Elv | 11 |
| 202508M327 | Reliance North,South & West India Automation | 1801 |
| 202508M328 | Reliance North, South & West India Automation | 1928 |
| 202508M343 | Reliance CBG AP State Implementation | 369 |
| 202508M344 | Reliance CBG Bilaspur Implementation | 59 |
| 202508M345 | Reliance Navsari 1 & 2 Implementation | 160 |
| 202508M346 | Reliance Vadodara Implementation | 14 |
| 202508M347 | Reliance CBG Jhajjar-2 Implementation | 175 |
| 202508M348 | Reliance CBG Jind 1 & 2 Implementation | 39 |
| 202508M349 | Reliance CBG MH State Implementation | 281 |
| 202508M350 | Reliance CBG MP State Implementation | 130 |
| 202508M351 | Reliance CBG OD State Implementation | 160 |
| 202508M352 | Reliance CBG Mansa Implementation | 68 |
| 202508M353 | Reliance CBG Suratgarh Implementatio | 36 |
| 202508M354 | Reliance CBG Warangal Implementation | 35 |
| 202508M355 | Reliance CBG UP State Implementation | 529 |
| 202508M361 | Intas Pharma Sanand Networking | 13 |
| 202508M392 | Veeda Clinical Ahmedabad IT Services | 4 |
| 202509M399 | Gandhinagar District Police Gandhinagar It Services | 6 |
| 202509M409 | Mangalam Information Ahmedabad IT Services | 20 |
| 202509M426 | Aspire Footwear Vellore Networking | 8 |
| 202509M433 | Amneal Pharma Matoda Networking | 43 |
| 202509M455 | Amneal Pharma Ahmedabad Services | 131 |
| 202509M463 | Air Water Kolkata Networking | 22 |
| 202510M452 | Saumya Construction Ahmedabad Networking, ELV, Collaboration | 140 |
| 202510M462 | Emcure Pharma Sanand It Services | 2 |
| 202510M493 | Sysmex India Sanand Networking & ELV | 4 |
| 202510M496 | Jeet City Gandhinagar Networking & Collaboration | 2 |
| 202510M505 | Intas Pharma Ahmedabad Networking & Implementation | 23 |
| 202510M515 | JK Cement Bihar Implementation | 50 |
| 202510M563 | Reliance Industries Dahej PM FMS Services | 43 |
| 202511M520 | Rubamin Vadoadra IT Services | 6 |
| 202511M560 | Veer Narmad Surat Networking | 2 |
| 202511M665 | Intas Pharma Matoda Implementation | 12 |
| 202512M643 | Bosch Rexroth Ahmedabad FMS Services | 6 |
| 202601M675 | Intas Pharma Matoda Networking | 61 |
| 202601M678 | Intash Pharma Matoda Networking | 4 |
| 202601M683 | MAS Financial Ahmedabad Networking, ELV, Collaboration | 54 |
| 202601M715 | Corona Remedies Bhayla Impl | 6 |
| 202601M717 | Jeet City Chiloda ELV, Collaboration | 2 |
| 202602M727 | Newzone India Madhya Pradesh Networking, Collaboration, System Infra, Security | 46 |
| 202602M729 | The Puri Foundation Gandhinagar Networking, ELV | 65 |
| 202602M739 | Mr. Ashish Jain Bungalow Vadodara Networking | 14 |
| 202602M751 | Test 1 Ahmedabad Networking | 1 |
| 202602M760 | Torrent Gas Jaipur Networking & ELV | 12 |
| 202602M764 | Torrent Gas Pune & Sangareddy Networking & ELV | 2 |
| 202602M787 | Emcure Pharma Sanand Implementation and Service | 56 |
| 202603M797 | Piramal Pharma Digwal IMPL | 64 |
| 202603M801 | Reliance Industries Vadodara Networking | 3 |
| 202603M807 | SNF Slopam Kutch Impl & It Services | 17 |
| 202603M823 | SKF Bavla IT Services | 4 |
| 202603M828 | Piramal Pharma Pithampur IMPL | 100 |
| 202603M844 | Intas Pharma Matoda Networking | 47 |
| 202603M847 | Neogen Iconics Bharuch Networking | 89 |
| 202603M848 | Reliance Industries Kutch IT Services | 8 |
| 202603M856 | The Anup Engineering Ahmedabad Networking | 4 |
| 202603M868 | Reliance Industries Jamnagar IT Services | 27 |
| 202603M876 | Reliance Industries Jamnagar IT Services | 4 |
| 202604M11 | Reliance Jamnagar PM FMS Services | 24 |
| 202604M18 | SOLBERRY ENERGY Mehsana Networking & System Infra | 14 |
| 202604M21 | Aarti Industries Vapi IT Services | 23 |
| 202604M28 | Arvind Bangalore Implementation | 12 |
| 202604M3 | The Anup Ahmedabad Networking&Implementation&IT Services | 1 |
| 202604M30 | TORRENT Power Ahmebadad Networking & Implementation | 4 |
| 202604M31 | Alembic Pharma Vadodara IT Services | 77 |
| 202604M33 | Reliance Industries Jamnagar Networking | 6 |
| 202604M34 | Intas Pharma Ahmedabad Networking | 9 |
| 202604M43 | Torrent Power Agra Implementation | 78 |
| 202604M49 | Espee Global Ahmedabad ELV | 1 |
| 202604M5 | Stallion Labs Ahmedabad Networking, ELV, Collaboration | 70 |
| 202604M76 | South-West Rajasthan Implementation | 5 |
| 202604M86 | Reliance Industries Jamnagar Implementation | 2 |
| 202605M107 | Reliance Industries Jamnagar IT Services | 1 |
| 202605M114 | Value Fashion Indore Networking | 16 |
| 202605M115 | Emcure Pharma Kadu Implementation | 16 |
| 202605M118 | Intas Pharma Matoda Implementation | 56 |
| 202605M124 | Reliance Syngas Jamnagar IT Services | 1 |
| 202605M127 | Intas Pharma Ahmedabad Networking | 6 |
| 202605M137 | Amneal Pharma Ahmedabad IT Services (Matoda-OSD) | 2 |
| 202605M138 | Amneal Pharma Ahmedabad IT Services_(Rajoda-Shailesh) | 3 |
| 202605M140 | Amneal Pharma Ahmedabad IT Services (W1) | 4 |
| 202605M146 | Finecure Pharma Changodar Networking & ELV | 10 |
| 202605M149 | GMM Pfaudler Ahmedabad IT Services | 14 |
| 202605M151 | Amneal Pharma Kadi Networking | 22 |
| 202605M153 | Polycab India Vadodara Networking & Collaboration | 6 |
| 202605M158 | Reliance Industries Vadodara Implementation | 168 |
| 202605M168 | Torrent Power Ahmedabad Networking & ELV | 39 |
| 202605M172 | GSFC Ahmedabad Collaboration | 4 |
| 202605M99 | HPA Design Ahmedabad System Infra service & IT Service | 1 |
| 202606M174 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 274 |
| 202606M182 | M2NXT Solutions Bangalore Networking, ELV, Collaboration, System Infra, & Security | 11 |
| 202606M192 | Gujarat Energy Gandhinagar Networking | 2 |
| 202606M200 | Polycab India Halol Networking | 1 |
| 202606M203 | Constera Realty Ahmedabad Implementation | 51 |
| 202606M207 | Finecure Pharma Ahmedabad Networking | 2 |
| 202606M209 | E-Infochips Ahmedabad IT Services | 3 |
| 202606M212 | JK Cement Rajasthan Implementation | 4 |
| 202606M220 | Gujarat State Fertilizers Vadodara IT Services | 30 |
| 202606M221 | TOrrent Power Ahmedabad Implementation | 93 |
| 202606M224 | Intas Pharma Ahmedabad Networking | 129 |
| 202606M227 | Polycab India Halol Networking | 35 |
| 202606M229 | Emcure pharma Mehsana Implementation | 20 |
| 202606M233 | Polycab India Agra Networking | 43 |
| 202606M234 | Intas Pharma Ahmedabad ELV | 4 |
| 202606M235 | Finecure Pharma Changodar Networking & ELV | 18 |
| 202606M241 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 61 |
| 202606M245 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 51 |
| 202606M246 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 144 |
| 202606M249 | Polycab India Daman Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 3 |
| 202606M250 | Polycab India Daman Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 117 |
| 202606M254 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 102 |
| 202606M255 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 47 |
| 202606M256 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 7 |
| 202606M257 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 1 |
| 202606M258 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 62 |
| 202606M259 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 1 |
| 202606M260 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 9 |
| 202606M264 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 10 |
| 202606M265 | Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 9 |
| 202606M273 | Reliance Industries Jamnagar jamnagar | 43 |
| 202606M276 | MICA Foundation Ahmedabad IT Services | 48 |
| 202606M283 | Sterling Biotech Vadodara Implementation | 11 |
| 202606M285 | Reliance BP West India Automation | 63 |
| 202606M290 | Intas Pharma Ahmedabad Networking | 1 |
| 202606M292 | Polycab India Halol Networking & Collaboration | 35 |
| 202606M293 | Eleshwar Ahmedabad Networking & ELV | 7 |
| 202607M295 | Reliance Bp Jamnagar Automation | 47 |
| 202607M296 | M2NXT Bangalore Implementation & System Infra service | 44 |
| 202607M298 | Intas Pharma Matoda IT Services | 6 |
| 202607M326 | Polycab India Valsad Networking | 2 |
| 202607M331 | Intas Pharma Moraiya IT Services | 20 |
| 202607M332 | Nirma Limited Bhavnagar Networking, ELV, Collaboration | 15 |
| 202607M339 | Alembic Pharma Vadodara Networking | 7 |
| 202607M342 | Polycab India Haryana Networking | 3 |
| 202607M343 | Greenwave Food Unjha Networking, ELV & Collaboration | 4 |
| 202607M344 | IAR Gandhinagar Networking | 18 |
| 202607M345 | GMM PFaudler Ahmedabad Implementation | 6 |
| 202607M347 | Honeywell Automation Pune Implementation | 2 |
| 202607M363 | Sisecam Flat Glass Baroda Networking | 63 |
| 202607M389 | Reliance Industries Jamnagar IT Services | 151 |
| 202608M403 | Dalmia Daughters Baroda Implementation | 3 |
| 202608M405 | Polycab Halol Networking | 14 |
| 202608M418 | Polycab Halol Networking | 2 |
| 202608M426 | Otsuka Pharma Sanand Implementation | 42 |
| 202608M427 | Reliance Industries Silvassa IT Services & Automation | 18 |
| 202608M428 | Avacend Solutions Mumbai Implementation | 22 |

## 2. Project Name — ambiguous (same Project ID, more than one name on record)

**39 expenses** fall under a Project ID where more than one name has genuinely been recorded. I did **not** silently pick one — these need your judgment.

### Project ID `197001M3` — 37 affected expenses

Evidence: `project_id 197001M3 has MULTIPLE recorded names: [('Support', 24), ('Training', 9)] -- using majority (24/33)`

My tentative pick (majority): **Support** — please confirm or correct.

### Project ID `202608M441` — 2 affected expenses

Evidence: `project_id 202608M441 has MULTIPLE recorded names: [('202608M441', 1), ('New Age Education Gandhinagar IT Service', 1)] -- using majority (1/2)`

My tentative pick (majority): **202608M441** — please confirm or correct.

## 3. Project Name — genuinely unresolvable (flagged, no value predicted)

**153 expenses.** No canonical value exists anywhere for this Project ID (nobody has ever recorded its name), and no same-employee neighbor evidence exists either. I did **not** guess. Listed by transaction so you can look each one up if the name matters:

| Voucher No | Employee | Employee Code | Date | Project ID |
|---|---|---|---|---|
| 14780 | Abdullah Abdul Basir Shaikh | 6849 | 2007-11-09 | (also blank) |
| 14781 | Abhishek Chunnilal Shende | 2423 | 2007-11-09 | (also blank) |
| 14782 | Abhishek Kumar | 6855 | 2007-11-09 | (also blank) |
| 14783 | Abhishek Sharma | 6349 | 2007-11-09 | (also blank) |
| 14784 | Abhishek Yadav | 6938 | 2007-11-09 | (also blank) |
| 14785 | Adil Afshan | 6236 | 2007-11-09 | (also blank) |
| 14786 | Aditya Mahendrakumar Parmar | 4101 | 2007-11-09 | (also blank) |
| 14787 | Adnan Qureshi | 4003 | 2007-11-09 | (also blank) |
| 14788 | Ajay Chaudhary | 6754 | 2007-11-09 | (also blank) |
| Cctv maintenance | Ajay Chaudhary | 6754 | 2026-08-03 | (also blank) |
| 14789 | Ajay Kumar | 6928 | 2007-11-09 | (also blank) |
| Network Implementation | Alok Kumar Chand | 6765 | 2026-08-11 | (also blank) |
| 00517 | Aman Jaiswal | 6826 | 2026-07-01 | (also blank) |
| 00516 | Aman Jaiswal | 6826 | 2026-07-01 | (also blank) |
| 00780 | Aman Jaiswal | 6826 | 2026-07-02 | (also blank) |
| 00779 | Aman Jaiswal | 6826 | 2026-07-02 | (also blank) |
| 04611 | Amit Pathak | 6380 | 2026-07-17 | (also blank) |
| 04777 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 04778 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 04776 | Amit Pathak | 6380 | 2026-07-18 | (also blank) |
| 05926 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 05928 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 05927 | Amit Pathak | 6380 | 2026-07-22 | (also blank) |
| 08483 | Amit Pathak | 6380 | 2026-07-31 | (also blank) |
| 12502 | Amit Pathak | 6380 | 2026-08-17 | (also blank) |
| 12909 | Amit Pathak | 6380 | 2026-08-18 | (also blank) |
| 12908 | Amit Pathak | 6380 | 2026-08-18 | (also blank) |
| Cctv mantince | Ankit Dixit | 6634 | 2026-08-03 | (also blank) |
| 00404 | Arunbhai Prakashkumar Gupta | 6942 | 2026-07-01 | 202606M277 |
| 01168 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01166 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01169 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01165 | Aswinkumar | 6546 | 2026-07-01 | (also blank) |
| 01177 | Aswinkumar | 6546 | 2026-07-03 | (also blank) |
| NRO | Audumbar Nagnath Gaikwad | 6688 | 2026-07-15 | (also blank) |
| 05178 | Bhavesh Hirabhai Prajapati | 6842 | 2026-07-21 | (also blank) |
| 02184 | Chintukumar Rupeshkumar Choursiya | 6541 | 2026-07-08 | (also blank) |
| CCTV camera Installation | Dinesh Chandra Patel | 6432 | 2026-07-23 | (also blank) |
| 12263 | Eshwer Balabattini | 6333 | 2026-07-31 | (also blank) |
| 12985 | Gajanand Matre | 6860 | 2026-08-13 | (also blank) |
| 00472 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00479 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00477 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00474 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00476 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00478 | Gautam Meena | 6815 | 2026-07-01 | (also blank) |
| 00726 | Gautam Meena | 6815 | 2026-07-02 | (also blank) |
| 00727 | Gautam Meena | 6815 | 2026-07-02 | (also blank) |
| 00940 | Gautam Meena | 6815 | 2026-07-03 | (also blank) |
| 00939 | Gautam Meena | 6815 | 2026-07-03 | (also blank) |
| 01213 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| 01214 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| 01212 | Gautam Meena | 6815 | 2026-07-04 | (also blank) |
| Nro | Gautam Meena | 6815 | 2026-07-16 | (also blank) |
| Nro | Gautam Meena | 6815 | 2026-08-07 | (also blank) |
| Nro | Gautam Meena | 6815 | 2026-08-12 | (also blank) |
| 06922 | Jayesh Patel | 6101 | 2026-07-27 | (also blank) |
| 06921 | Jayesh Patel | 6101 | 2026-07-27 | (also blank) |
| 07773 | Jayesh Patel | 6101 | 2026-07-31 | (also blank) |
| 07772 | Jayesh Patel | 6101 | 2026-07-31 | (also blank) |
| 01110 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01112 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01114 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01113 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01115 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01111 | K. Ramesh Babu | 5437 | 2026-07-02 | (also blank) |
| 01117 | K. Ramesh Babu | 5437 | 2026-07-03 | (also blank) |
| 01118 | K. Ramesh Babu | 5437 | 2026-07-03 | (also blank) |
| 01144 | K. Ramesh Babu | 5437 | 2026-07-04 | (also blank) |
| Jamnagar afs | Katheria Arun Amrutbhai | 6557 | 2026-07-30 | (also blank) |
| 00937 | Krishna Kumar Rajak | 6664 | 2026-07-03 | (also blank) |
| 00938 | Krishna Kumar Rajak | 6664 | 2026-07-03 | (also blank) |
| 00530 | Kuldeep Patel | 6223 | 2026-07-01 | (also blank) |
| 00532 | Kuldeep Patel | 6223 | 2026-07-01 | (also blank) |
| 00768 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00805 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00806 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 00767 | Kuldeep Patel | 6223 | 2026-07-02 | (also blank) |
| 01068 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01067 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01064 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01063 | Kuldeep Patel | 6223 | 2026-07-03 | (also blank) |
| 01497 | Kuldeep Patel | 6223 | 2026-07-06 | 202605M126 |
| 01453 | Kuldeep Patel | 6223 | 2026-07-06 | (also blank) |
| 01498 | Kuldeep Patel | 6223 | 2026-07-06 | 202605M126 |
| 01454 | Kuldeep Patel | 6223 | 2026-07-06 | (also blank) |
| 00531 | Kunal Singh Kori | 6920 | 2026-07-01 | (also blank) |
| 00533 | Kunal Singh Kori | 6920 | 2026-07-01 | (also blank) |
| 00782 | Kunal Singh Kori | 6920 | 2026-07-02 | (also blank) |
| 00781 | Kunal Singh Kori | 6920 | 2026-07-02 | (also blank) |
| 01082 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01081 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01083 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| 01080 | Kunal Singh Kori | 6920 | 2026-07-04 | (also blank) |
| It work | Kunal Singh Kori | 6920 | 2026-07-07 | (also blank) |
| IT work | Kunal Singh Kori | 6920 | 2026-08-01 | (also blank) |
| Engineer visit to locking system installation | Manohar Kumar | 6490 | 2026-07-09 | (also blank) |
| Atg interlock work | Manohar Kumar | 6490 | 2026-07-20 | (also blank) |
| 01078 | Mayur Patel | 5740 | 2026-07-03 | 202606M231 |
| 00772 | Nand Lal Paswan | 5944 | 2026-07-02 | (also blank) |
| 00771 | Nand Lal Paswan | 5944 | 2026-07-02 | (also blank) |
| 02859 | Nilesh Ramshi Vaghela | 6840 | 2026-07-11 | (also blank) |
| 07068 | Pavankumar Prahladbhai Ramchandani | 6887 | 2026-07-22 | (also blank) |
| Bio Metric Issue | Pratham Chokshi | 6883 | 2026-07-28 | (also blank) |
| CCTV | Pravin Gaund | 6828 | 2026-07-29 | (also blank) |
| 02563 | Rajat Shakyawar | 5476 | 2026-07-01 | (also blank) |
| 02564 | Rajat Shakyawar | 5476 | 2026-07-03 | (also blank) |
| 10683 | Rajeshkumar Chauhan | 3702 | 2026-08-10 | (also blank) |
| 00554 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00549 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00547 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00553 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00552 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00548 | Rajput Niki | 6833 | 2026-07-01 | (also blank) |
| 00774 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00775 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00773 | Rajput Niki | 6833 | 2026-07-02 | (also blank) |
| 00573 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00572 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00575 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00574 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 00576 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | (also blank) |
| 06832 | Sagar Nareshbhai Koshti | 3890 | 2026-07-27 | (also blank) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-08 | (also blank) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-30 | (also blank) |
| 10400 | Shanis Parmanand Gupta | 6444 | 2026-08-01 | (also blank) |
| 03515 | Vipin Kumar Kumhar | 6215 | 2026-07-14 | (also blank) |
| 00800 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00799 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00801 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 00802 | Virendrasinh Mahida | 6118 | 2026-07-02 | (also blank) |
| 01015 | Virendrasinh Mahida | 6118 | 2026-07-03 | (also blank) |
| It work | Virendrasinh Mahida | 6118 | 2026-08-01 | (also blank) |
| 00487 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00488 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00486 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00484 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00483 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00482 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00485 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00489 | Yuvraj Ratan | 6805 | 2026-07-01 | (also blank) |
| 00748 | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| 00749 | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| Nro | Yuvraj Ratan | 6805 | 2026-07-02 | (also blank) |
| 00947 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00941 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00946 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00944 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00942 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00948 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00945 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| 00943 | Yuvraj Ratan | 6805 | 2026-07-03 | (also blank) |
| Opt | Yuvraj Ratan | 6805 | 2026-07-06 | (also blank) |

## 4. Project ID — same-employee neighbor prediction (HIGH confidence)

**88 expenses.** Project ID has no deterministic source (it's the top-level free-choice field, not derived from anything else), so this uses the method you described: looking at that same employee's nearest expenses before and after the blank one. HIGH = every neighbor checked (up to 5 before + 5 after) agrees on the same value.

| Voucher No | Employee | Employee Code | Date | Predicted Project ID | Evidence |
|---|---|---|---|---|---|
| 14780 | Abdullah Abdul Basir Shaikh | 6849 | 2007-11-09 | 202606M174 | 5/5 neighbors agree (after only) |
| 14781 | Abhishek Chunnilal Shende | 2423 | 2007-11-09 | 202603M868 | 5/5 neighbors agree (after only) |
| 14783 | Abhishek Sharma | 6349 | 2007-11-09 | 202508M327 | 5/5 neighbors agree (after only) |
| 14788 | Ajay Chaudhary | 6754 | 2007-11-09 | 202508M327 | 5/5 neighbors agree (after only) |
| Network Implementation | Alok Kumar Chand | 6765 | 2026-08-11 | 202508M355 | 10/10 neighbors agree (both sides) |
| 04611 | Amit Pathak | 6380 | 2026-07-17 | 202508M349 | 10/10 neighbors agree (both sides) |
| 04777 | Amit Pathak | 6380 | 2026-07-18 | 202508M349 | 10/10 neighbors agree (both sides) |
| 04778 | Amit Pathak | 6380 | 2026-07-18 | 202508M349 | 10/10 neighbors agree (both sides) |
| 04776 | Amit Pathak | 6380 | 2026-07-18 | 202508M349 | 10/10 neighbors agree (both sides) |
| 05926 | Amit Pathak | 6380 | 2026-07-22 | 202508M349 | 10/10 neighbors agree (both sides) |
| 05928 | Amit Pathak | 6380 | 2026-07-22 | 202508M349 | 10/10 neighbors agree (both sides) |
| 05927 | Amit Pathak | 6380 | 2026-07-22 | 202508M349 | 10/10 neighbors agree (both sides) |
| 08483 | Amit Pathak | 6380 | 2026-07-31 | 202508M349 | 10/10 neighbors agree (both sides) |
| 12502 | Amit Pathak | 6380 | 2026-08-17 | 202508M349 | 8/8 neighbors agree (both sides) |
| 12909 | Amit Pathak | 6380 | 2026-08-18 | 202508M349 | 7/7 neighbors agree (both sides) |
| 12908 | Amit Pathak | 6380 | 2026-08-18 | 202508M349 | 7/7 neighbors agree (both sides) |
| Cctv mantince | Ankit Dixit | 6634 | 2026-08-03 | 202508M327 | 10/10 neighbors agree (both sides) |
| 01177 | Aswinkumar | 6546 | 2026-07-03 | 202508M328 | 10/10 neighbors agree (both sides) |
| 02184 | Chintukumar Rupeshkumar Choursiya | 6541 | 2026-07-08 | 202508M348 | 10/10 neighbors agree (both sides) |
| CCTV camera Installation | Dinesh Chandra Patel | 6432 | 2026-07-23 | 202412M758 | 10/10 neighbors agree (both sides) |
| 12985 | Gajanand Matre | 6860 | 2026-08-13 | 202602M729 | 5/5 neighbors agree (before only) |
| 00472 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00479 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00477 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00474 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00476 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00478 | Gautam Meena | 6815 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00726 | Gautam Meena | 6815 | 2026-07-02 | 202310M567 | 5/5 neighbors agree (after only) |
| 00727 | Gautam Meena | 6815 | 2026-07-02 | 202310M567 | 5/5 neighbors agree (after only) |
| 00940 | Gautam Meena | 6815 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00939 | Gautam Meena | 6815 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 01213 | Gautam Meena | 6815 | 2026-07-04 | 202310M567 | 6/6 neighbors agree (both sides) |
| 01214 | Gautam Meena | 6815 | 2026-07-04 | 202310M567 | 6/6 neighbors agree (both sides) |
| 01212 | Gautam Meena | 6815 | 2026-07-04 | 202310M567 | 8/8 neighbors agree (both sides) |
| Nro | Gautam Meena | 6815 | 2026-07-16 | 202310M567 | 10/10 neighbors agree (both sides) |
| Nro | Gautam Meena | 6815 | 2026-08-07 | 202310M567 | 10/10 neighbors agree (both sides) |
| Nro | Gautam Meena | 6815 | 2026-08-12 | 202310M567 | 10/10 neighbors agree (both sides) |
| 06922 | Jayesh Patel | 6101 | 2026-07-27 | 202510M452 | 10/10 neighbors agree (both sides) |
| 06921 | Jayesh Patel | 6101 | 2026-07-27 | 202510M452 | 10/10 neighbors agree (both sides) |
| Jamnagar afs | Katheria Arun Amrutbhai | 6557 | 2026-07-30 | 202607M295 | 10/10 neighbors agree (both sides) |
| 00937 | Krishna Kumar Rajak | 6664 | 2026-07-03 | 202508M327 | 10/10 neighbors agree (both sides) |
| 00938 | Krishna Kumar Rajak | 6664 | 2026-07-03 | 202508M327 | 10/10 neighbors agree (both sides) |
| IT work | Kunal Singh Kori | 6920 | 2026-08-01 | 202310M567 | 10/10 neighbors agree (both sides) |
| Engineer visit to locking system installation | Manohar Kumar | 6490 | 2026-07-09 | 202508M328 | 10/10 neighbors agree (both sides) |
| CCTV | Pravin Gaund | 6828 | 2026-07-29 | 202508M355 | 10/10 neighbors agree (both sides) |
| 02563 | Rajat Shakyawar | 5476 | 2026-07-01 | 202603M797 | 8/8 neighbors agree (both sides) |
| 02564 | Rajat Shakyawar | 5476 | 2026-07-03 | 202603M797 | 10/10 neighbors agree (both sides) |
| 10683 | Rajeshkumar Chauhan | 3702 | 2026-08-10 | 202604M31 | 10/10 neighbors agree (both sides) |
| 00554 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 5/5 neighbors agree (after only) |
| 00549 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 7/7 neighbors agree (both sides) |
| 00547 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 7/7 neighbors agree (both sides) |
| 00553 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 7/7 neighbors agree (both sides) |
| 00552 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 7/7 neighbors agree (both sides) |
| 00548 | Rajput Niki | 6833 | 2026-07-01 | 202310M551 | 7/7 neighbors agree (both sides) |
| 00774 | Rajput Niki | 6833 | 2026-07-02 | 202310M551 | 8/8 neighbors agree (both sides) |
| 00775 | Rajput Niki | 6833 | 2026-07-02 | 202310M551 | 8/8 neighbors agree (both sides) |
| 00773 | Rajput Niki | 6833 | 2026-07-02 | 202310M551 | 9/9 neighbors agree (both sides) |
| 00573 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00572 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00575 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00574 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00576 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 06832 | Sagar Nareshbhai Koshti | 3890 | 2026-07-27 | 202406M232 | 10/10 neighbors agree (both sides) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-08 | 202508M355 | 10/10 neighbors agree (both sides) |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-30 | 202508M355 | 9/9 neighbors agree (both sides) |
| 10400 | Shanis Parmanand Gupta | 6444 | 2026-08-01 | 202508M327 | 10/10 neighbors agree (both sides) |
| 03515 | Vipin Kumar Kumhar | 6215 | 2026-07-14 | 202604M43 | 10/10 neighbors agree (both sides) |
| It work | Virendrasinh Mahida | 6118 | 2026-08-01 | 202310M567 | 5/5 neighbors agree (before only) |
| 00487 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00488 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00486 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00484 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00483 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00482 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00485 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00489 | Yuvraj Ratan | 6805 | 2026-07-01 | 202310M567 | 5/5 neighbors agree (after only) |
| 00748 | Yuvraj Ratan | 6805 | 2026-07-02 | 202310M567 | 5/5 neighbors agree (after only) |
| 00749 | Yuvraj Ratan | 6805 | 2026-07-02 | 202310M567 | 5/5 neighbors agree (after only) |
| Nro | Yuvraj Ratan | 6805 | 2026-07-02 | 202310M567 | 5/5 neighbors agree (after only) |
| 00947 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00941 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00946 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00944 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00942 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00948 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00945 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| 00943 | Yuvraj Ratan | 6805 | 2026-07-03 | 202310M567 | 5/5 neighbors agree (after only) |
| Opt | Yuvraj Ratan | 6805 | 2026-07-06 | 202310M567 | 10/10 neighbors agree (both sides) |

## 5. Project ID — same-employee neighbor prediction (MEDIUM confidence, majority only)

**17 expenses.** Neighbors disagree, but one value has a >=75% majority among 3+ neighbors. Lower confidence than Section 4 — worth a glance before trusting.

| Voucher No | Employee | Employee Code | Date | Predicted Project ID | Evidence |
|---|---|---|---|---|---|
| 14784 | Abhishek Yadav | 6938 | 2007-11-09 | 202303M1249 | 4/5 neighbors agree; minority: {'201904M522': 1} |
| 01168 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01166 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01169 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| 01165 | Aswinkumar | 6546 | 2026-07-01 | 202508M328 | 4/5 neighbors agree; minority: {'202508M327': 1} |
| NRO | Audumbar Nagnath Gaikwad | 6688 | 2026-07-15 | 202310M551 | 8/10 neighbors agree; minority: {'202508M328': 2} |
| 05178 | Bhavesh Hirabhai Prajapati | 6842 | 2026-07-21 | 202510M515 | 9/10 neighbors agree; minority: {'202606M229': 1} |
| 01110 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01112 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01114 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01113 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01115 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01111 | K. Ramesh Babu | 5437 | 2026-07-02 | 202508M328 | 7/8 neighbors agree; minority: {'202508M327': 1} |
| 01117 | K. Ramesh Babu | 5437 | 2026-07-03 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| 01118 | K. Ramesh Babu | 5437 | 2026-07-03 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| 01144 | K. Ramesh Babu | 5437 | 2026-07-04 | 202508M328 | 8/10 neighbors agree; minority: {'202508M327': 2} |
| Atg interlock work | Manohar Kumar | 6490 | 2026-07-20 | 202508M327 | 8/10 neighbors agree; minority: {'202508M328': 2} |

## 6. Project ID — genuinely unresolvable (flagged, no value predicted)

**44 expenses.** No same-employee neighbor (before or after) has a Project ID value at all, or the neighbors are split with no majority. Listed by transaction:

| Voucher No | Employee | Employee Code | Date |
|---|---|---|---|
| 14782 | Abhishek Kumar | 6855 | 2007-11-09 |
| 14785 | Adil Afshan | 6236 | 2007-11-09 |
| 14786 | Aditya Mahendrakumar Parmar | 4101 | 2007-11-09 |
| 14787 | Adnan Qureshi | 4003 | 2007-11-09 |
| Cctv maintenance | Ajay Chaudhary | 6754 | 2026-08-03 |
| 14789 | Ajay Kumar | 6928 | 2007-11-09 |
| 00517 | Aman Jaiswal | 6826 | 2026-07-01 |
| 00516 | Aman Jaiswal | 6826 | 2026-07-01 |
| 00780 | Aman Jaiswal | 6826 | 2026-07-02 |
| 00779 | Aman Jaiswal | 6826 | 2026-07-02 |
| 12263 | Eshwer Balabattini | 6333 | 2026-07-31 |
| 07773 | Jayesh Patel | 6101 | 2026-07-31 |
| 07772 | Jayesh Patel | 6101 | 2026-07-31 |
| 00530 | Kuldeep Patel | 6223 | 2026-07-01 |
| 00532 | Kuldeep Patel | 6223 | 2026-07-01 |
| 00768 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00805 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00806 | Kuldeep Patel | 6223 | 2026-07-02 |
| 00767 | Kuldeep Patel | 6223 | 2026-07-02 |
| 01068 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01067 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01064 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01063 | Kuldeep Patel | 6223 | 2026-07-03 |
| 01453 | Kuldeep Patel | 6223 | 2026-07-06 |
| 01454 | Kuldeep Patel | 6223 | 2026-07-06 |
| 00531 | Kunal Singh Kori | 6920 | 2026-07-01 |
| 00533 | Kunal Singh Kori | 6920 | 2026-07-01 |
| 00782 | Kunal Singh Kori | 6920 | 2026-07-02 |
| 00781 | Kunal Singh Kori | 6920 | 2026-07-02 |
| 01082 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01081 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01083 | Kunal Singh Kori | 6920 | 2026-07-04 |
| 01080 | Kunal Singh Kori | 6920 | 2026-07-04 |
| It work | Kunal Singh Kori | 6920 | 2026-07-07 |
| 00772 | Nand Lal Paswan | 5944 | 2026-07-02 |
| 00771 | Nand Lal Paswan | 5944 | 2026-07-02 |
| 02859 | Nilesh Ramshi Vaghela | 6840 | 2026-07-11 |
| 07068 | Pavankumar Prahladbhai Ramchandani | 6887 | 2026-07-22 |
| Bio Metric Issue | Pratham Chokshi | 6883 | 2026-07-28 |
| 00800 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00799 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00801 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 00802 | Virendrasinh Mahida | 6118 | 2026-07-02 |
| 01015 | Virendrasinh Mahida | 6118 | 2026-07-03 |

## Summary

| Category | Count | Confidence |
|---|---|---|
| Project Name — deterministic recovery | 12754 | Very high (real recorded data) |
| Project Name — ambiguous, majority pick | 39 | Needs your confirmation |
| Project Name — flagged, unresolvable | 153 | N/A — no prediction made |
| Project ID — neighbor prediction, HIGH | 88 | High (unanimous neighbors) |
| Project ID — neighbor prediction, MEDIUM | 17 | Medium (majority neighbors) |
| Project ID — flagged, unresolvable | 44 | N/A — no prediction made |

**Nothing above has been written to the database.** This file is for your review. Once you confirm which sections to apply (and what to do about the 2 ambiguous Project IDs and the root-cause field-mapping bug), I'll write the actual update — as its own reviewable step, not bundled into this analysis.
