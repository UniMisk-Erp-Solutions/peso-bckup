# Full recovery detail — every transaction, recovered and pending — 2026-08-26

**Doc ID:** DOC-141 detail companion (formerly DOC-114) (renumbered on the 2026-10-05 upstream sync — see DOC-143; the pre-sync `peso-bckup` index gave this a different ID than upstream's independently-numbered catalog)
**Scope:** MicroLink, all 12,946 expenses, all statuses.
**Total recovered this session:** 1095 field values, across 505 distinct expenses.
**Total still pending:** 65 field gaps (60 expenses with no Project Unique ID at all, 5 with a known Project Unique ID but a genuinely ambiguous or unconfigured dependent field).

Every row below is identified by **Voucher No** — the same identifier shown in the app and in the exported report. Nothing in this document has been fabricated: every recovered value is data that genuinely existed elsewhere in the database (the same project's real, submitted value), and every pending row is pending because no such value exists anywhere to recover.

## Part 1 — Recovered

### 1a. Project Unique ID — 89 transactions (two methods)

**73 via same-employee nearest-neighbor prediction** (original DOC-113 pass, approved expenses only): unanimous agreement among up to 10 nearest same-employee expenses, 5 before and 5 after.

| Voucher No | Employee | Employee Code | Date | Status | Recovered Value |
|---|---|---|---|---|---|
| 04611 | Amit Pathak | 6380 | 2026-07-17 | approved | 202508M349 |
| 04778 | Amit Pathak | 6380 | 2026-07-18 | approved | 202508M349 |
| 04776 | Amit Pathak | 6380 | 2026-07-18 | approved | 202508M349 |
| 04777 | Amit Pathak | 6380 | 2026-07-18 | approved | 202508M349 |
| 05928 | Amit Pathak | 6380 | 2026-07-22 | approved | 202508M349 |
| 05927 | Amit Pathak | 6380 | 2026-07-22 | approved | 202508M349 |
| 05926 | Amit Pathak | 6380 | 2026-07-22 | approved | 202508M349 |
| 08483 | Amit Pathak | 6380 | 2026-07-31 | approved | 202508M349 |
| Cctv mantince | Ankit Dixit | 6634 | 2026-08-03 | approved | 202508M327 |
| 02184 | Chintukumar Rupeshkumar Choursiya | 6541 | 2026-07-08 | approved | 202508M348 |
| CCTV camera Installation | Dinesh Chandra Patel | 6432 | 2026-07-23 | approved | 202412M758 |
| 00478 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00479 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00476 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00472 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00474 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00477 | Gautam Meena | 6815 | 2026-07-01 | approved | 202310M567 |
| 00727 | Gautam Meena | 6815 | 2026-07-02 | approved | 202310M567 |
| 00726 | Gautam Meena | 6815 | 2026-07-02 | approved | 202310M567 |
| 00939 | Gautam Meena | 6815 | 2026-07-03 | approved | 202310M567 |
| 00940 | Gautam Meena | 6815 | 2026-07-03 | approved | 202310M567 |
| 01212 | Gautam Meena | 6815 | 2026-07-04 | approved | 202310M567 |
| 01213 | Gautam Meena | 6815 | 2026-07-04 | approved | 202310M567 |
| 01214 | Gautam Meena | 6815 | 2026-07-04 | approved | 202310M567 |
| 06922 | Jayesh Patel | 6101 | 2026-07-27 | approved | 202510M452 |
| 06921 | Jayesh Patel | 6101 | 2026-07-27 | approved | 202510M452 |
| 00937 | Krishna Kumar Rajak | 6664 | 2026-07-03 | approved | 202508M327 |
| 00938 | Krishna Kumar Rajak | 6664 | 2026-07-03 | approved | 202508M327 |
| Engineer visit to locking system installation | Manohar Kumar | 6490 | 2026-07-09 | approved | 202508M328 |
| CCTV | Pravin Gaund | 6828 | 2026-07-29 | approved | 202508M355 |
| 02563 | Rajat Shakyawar | 5476 | 2026-07-01 | approved | 202603M797 |
| 02564 | Rajat Shakyawar | 5476 | 2026-07-03 | approved | 202603M797 |
| 10683 | Rajeshkumar Chauhan | 3702 | 2026-08-10 | approved | 202604M31 |
| 00548 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00549 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00554 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00553 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00547 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00552 | Rajput Niki | 6833 | 2026-07-01 | approved | 202310M551 |
| 00773 | Rajput Niki | 6833 | 2026-07-02 | approved | 202310M551 |
| 00774 | Rajput Niki | 6833 | 2026-07-02 | approved | 202310M551 |
| 00775 | Rajput Niki | 6833 | 2026-07-02 | approved | 202310M551 |
| 00574 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | approved | 202310M567 |
| 00576 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | approved | 202310M567 |
| 00573 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | approved | 202310M567 |
| 00575 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | approved | 202310M567 |
| 00572 | Ramchandra Jageshwar Ghosekar | 6595 | 2026-07-01 | approved | 202310M567 |
| 06832 | Sagar Nareshbhai Koshti | 3890 | 2026-07-27 | approved | 202406M232 |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-08 | approved | 202508M355 |
| CCTV | Sahilkumar Baldevbhai Paramar | 6721 | 2026-07-30 | approved | 202508M355 |
| 10400 | Shanis Parmanand Gupta | 6444 | 2026-08-01 | approved | 202508M327 |
| 03515 | Vipin Kumar Kumhar | 6215 | 2026-07-14 | approved | 202604M43 |
| It work | Virendrasinh Mahida | 6118 | 2026-08-01 | approved | 202310M567 |
| 00488 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00485 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00487 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00483 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00486 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00489 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00484 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00482 | Yuvraj Ratan | 6805 | 2026-07-01 | approved | 202310M567 |
| 00748 | Yuvraj Ratan | 6805 | 2026-07-02 | approved | 202310M567 |
| 00749 | Yuvraj Ratan | 6805 | 2026-07-02 | approved | 202310M567 |
| Nro | Yuvraj Ratan | 6805 | 2026-07-02 | approved | 202310M567 |
| 00945 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00942 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00943 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00941 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00946 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00947 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00948 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| 00944 | Yuvraj Ratan | 6805 | 2026-07-03 | approved | 202310M567 |
| Opt | Yuvraj Ratan | 6805 | 2026-07-06 | approved | 202310M567 |

**16 via batch-sibling inference** (DOC-114 follow-up, all statuses): every other line in the same submission batch agreed unanimously.

| Voucher No | Employee | Employee Code | Date | Status | Recovered Value |
|---|---|---|---|---|---|
| Cctv maintenance | Ajay Chaudhary | 6754 | 2026-08-03 | draft | 202508M327 |
| Network Implementation | Alok Kumar Chand | 6765 | 2026-08-11 | draft | 202508M355 |
| 12502 | Amit Pathak | 6380 | 2026-08-17 | level_2_verified | 202508M349 |
| 12909 | Amit Pathak | 6380 | 2026-08-18 | level_2_verified | 202508M349 |
| 12908 | Amit Pathak | 6380 | 2026-08-18 | level_2_verified | 202508M349 |
| 01168 | Aswinkumar | 6546 | 2026-07-01 | approved | 202508M327 |
| 01166 | Aswinkumar | 6546 | 2026-07-01 | approved | 202508M327 |
| 01165 | Aswinkumar | 6546 | 2026-07-01 | approved | 202508M327 |
| 01169 | Aswinkumar | 6546 | 2026-07-01 | approved | 202508M327 |
| 01177 | Aswinkumar | 6546 | 2026-07-03 | approved | 202508M328 |
| NRO | Audumbar Nagnath Gaikwad | 6688 | 2026-07-15 | approved | 202310M551 |
| 01144 | K. Ramesh Babu | 5437 | 2026-07-04 | approved | 202508M327 |
| It work | Kunal Singh Kori | 6920 | 2026-07-07 | approved | 201904M523 |
| Atg interlock work | Manohar Kumar | 6490 | 2026-07-20 | approved | 202508M327 |
| Bio Metric Issue | Pratham Chokshi | 6883 | 2026-07-28 | approved | 202505M105 |
| 01015 | Virendrasinh Mahida | 6118 | 2026-07-03 | approved | 199601M1 |

### 1b. Project ID — 501 transactions, deterministic recovery

Each value is the real Project ID for that project — either the one value everyone else who used this project actually submitted, or (for 3 of these transactions) the field's own single admin-configured option when nobody had ever submitted a value at all. Grouped by value since many transactions share one project. Every voucher number is listed.

| Recovered Project ID | Transactions | Voucher Numbers |
|---|---|---|
| 12926 | 12 | 00878, 00879, 00880, 00882, 00883, 00884, 00885, 01699, 01700, 01701, 01702, 01703 |
| 13185 | 1 | 01505 |
| 13231 | 18 | 00547, 00548, 00549, 00550, 00551, 00552, 00553, 00554, 00773, 00774, 00775, 00776, 00777, 01021, 01022, 01681, 01682, NRO |
| 13257 | 73 | 00472, 00474, 00476, 00477, 00478, 00479, 00482, 00483, 00484, 00485, 00486, 00487, 00488, 00489, 00572, 00573, 00574, 00575, 00576, 00726, 00727, 00748, 00749, 00939, 00940, 00941, 00942, 00943, 00944, 00945, 00946, 00947, 00948, 01212, 01213, 01214, 01255, 01256, 01257, 01344, 01345, 01346, 01347, 01348, 01349, 01350, 01351, 01355, 01356, 01357, 01358, 01627, 01628, 01629, 01630, 01631, 01632, 01633, 01634, 01635, 01637, 01638, 01639, 01640, 01641, 01642, 01643, 01644, 01645, 01683, It work, Nro, Opt |
| 14231 | 1 | 06832 |
| 14835 | 20 | 00422, 00423, 00427, 00428, 00679, 00683, 00686, 00687, 00904, 00907, 00908, 00909, 01152, 01153, 01156, 01157, 01159, 01460, 01529, 01530 |
| 15130 | 1 | CCTV camera Installation |
| 15148 | 3 | 00509, 00745, 01013 |
| 15151 | 2 | 00842, 01044 |
| 15680 | 1 | Bio Metric Issue |
| 15701 | 2 | 00862, 00863 |
| 16054 | 38 | 00829, 00830, 00831, 00832, 00833, 00834, 00935, 00936, 00937, 00938, 01121, 01122, 01123, 01124, 01125, 01126, 01127, 01144, 01164, 01165, 01166, 01168, 01169, 01200, 01241, 01597, 01598, 01599, 01600, 01601, 01602, 01603, 01604, 01605, 10400, Atg interlock work, Cctv maintenance, Cctv mantince |
| 16055 | 56 | 00580, 00581, 00617, 00698, 01105, 01107, 01109, 01119, 01140, 01141, 01143, 01171, 01172, 01176, 01177, 01178, 01179, 01180, 01181, 01295, 01296, 01297, 01298, 01299, 01300, 01301, 01302, 01303, 01341, 01402, 01403, 01404, 01405, 01406, 01619, 01620, 01621, 01622, 01623, 01624, 01625, 01626, 01720, 01721, 01722, 01723, 01724, 01725, 01726, 01727, 01728, 01729, 01730, 01731, 01732, Engineer visit to locking system installation |
| 16090 | 48 | 00458, 00459, 00460, 00464, 00490, 00592, 00593, 00594, 00728, 00746, 00860, 00861, 00965, 00966, 00980, 00981, 00982, 00984, 00987, 00988, 00989, 01191, 01192, 01193, 01194, 01217, 01260, 01261, 01342, 01410, 01411, 01427, 01496, 01518, 01554, 01555, 01558, 01560, 01561, 01562, 01563, 01564, 01581, 01582, 01583, 01584, 01650, 01652 |
| 16094 | 4 | 00499, 00500, 00795, 00796 |
| 16097 | 23 | 00506, 00537, 00538, 00539, 00788, 00995, 00998, 00999, 01001, 01002, 01184, 01185, 01273, 01274, 01338, 01339, 01412, 01413, 01506, 01507, 01579, 01580, 02184 |
| 16098 | 7 | 01158, 01343, 01354, 01672, 01673, 01675, 01676 |
| 16100 | 20 | 00461, 00750, 00871, 00902, 00996, 00997, 01000, 01195, 01674, 04611, 04776, 04777, 04778, 05926, 05927, 05928, 08483, 12502, 12908, 12909 |
| 16102 | 4 | CCTV, CCTV, CCTV, Network Implementation |
| 16105 | 2 | 01685, 01688 |
| 16240 | 6 | 01352, 01353, 01387, 01388, 01455, 01456 |
| 16278 | 2 | 06921, 06922 |
| 16284 | 2 | 01086, 01428 |
| 16377 | 6 | 01162, 01163, 01430, 01431, 01433, 01434 |
| 16398 | 5 | 00690, 00691, 01054, 01272, 01666 |
| 16484 | 1 | 00638 |
| 16488 | 1 | 00401 |
| 16663 | 11 | 00398, 00582, 00583, 00804, 00859, 00869, 01079, 01175, 01432, 01547, 01698 |
| 16679 | 2 | 00400, 00648 |
| 16769 | 7 | 00875, 01568, 01569, 01572, 01573, 01617, 01618 |
| 16775 | 7 | 01090, 01091, 01415, 01416, 01420, 01421, 01678 |
| 16883 | 1 | 00621 |
| 16904 | 2 | 02563, 02564 |
| 16944 | 6 | 00402, 00760, 00761, 01008, 01009, 01150 |
| 16986 | 2 | 01520, 01521 |
| 17031 | 2 | 00619, 00620 |
| 17069 | 2 | 00874, 00876 |
| 17070 | 1 | 10683 |
| 17093 | 4 | 00392, 00393, 00394, 03515 |
| 17227 | 2 | 01497, 01498 |
| 17283 | 15 | 00399, 00637, 00639, 00719, 00720, 00856, 00857, 00858, 01135, 01138, 01142, 01444, 01445, 01514, 01677 |
| 17303 | 22 | 00496, 00535, 00536, 00631, 00634, 00677, 00743, 00755, 00787, 00789, 00798, 00803, 00955, 00959, 01045, 01116, 01224, 01294, 01389, 01390, 01391, 01576 |
| 17350 | 3 | 00622, 07072, 07073 |
| 17381 | 8 | 00522, 00527, 00534, 00540, 00541, 00934, 01425, 01426 |
| 17386 | 6 | 01092, 01093, 01094, 01764, 01765, 01766 |
| 17420 | 1 | 00404 |
| 17647 | 13 | 11699, 11706, 11707, 11714, 11715, 11727, 11729, 11731, 11733, 11735, 11738, 11740, 12149 |
| 4175 | 2 | 00520, 00521 |
| 4182 | 8 | 01014, 01015, 01016, 01017, 01018, 01038, 01258, 01259 |
| 4954 | 6 | 01536, 01570, 01571, 01574, 01575, 01585 |
| 4955 | 7 | 01275, 01276, 01368, 01369, 01370, 01371, It work |
| 4957 | 2 | 00518, 00519 |

### 1c. Project Name — 505 transactions, deterministic recovery

Same method as 1b: real recorded data recovered from elsewhere in the org for the vast majority, plus 3 transactions filled from the field's own single configured option where nobody had ever submitted a value.

| Recovered Project Name | Transactions | Voucher Numbers |
|---|---|---|
| Alembic Pharma Vadodara IT Services | 1 | 10683 |
| Amneal Pharma Ahmedabad Services | 2 | 01086, 01428 |
| Amneal Pharma Matoda Networking | 6 | 01352, 01353, 01387, 01388, 01455, 01456 |
| At Office | 8 | 01014, 01015, 01016, 01017, 01018, 01038, 01258, 01259 |
| Constera Realty Ahmedabad Implementation | 3 | 00622, 07072, 07073 |
| Courtesy - SSE 2019-20 | 7 | 01275, 01276, 01368, 01369, 01370, 01371, It work |
| Courtesy - Sales 2019-20 | 6 | 01536, 01570, 01571, 01574, 01575, 01585 |
| Courtesy 2019-20 | 2 | 00518, 00519 |
| Emcure Pharma Sanand Implementation and Service | 1 | 00621 |
| Intas Matoda Networking | 24 | 00422, 00423, 00427, 00428, 00679, 00683, 00686, 00687, 00904, 00907, 00908, 00909, 01152, 01153, 01156, 01157, 01159, 01460, 01529, 01530, 01761, 01762, 01775, 01776 |
| Intas Moraiya Networking | 1 | Bio Metric Issue |
| Intas Pharma Ahmedabad Networking | 6 | 01092, 01093, 01094, 01764, 01765, 01766 |
| Intas Pharma Ahmedabad Networking & Implementation | 6 | 01162, 01163, 01430, 01431, 01433, 01434 |
| Intas Pharma Matoda Networking | 11 | 00398, 00582, 00583, 00804, 00859, 00869, 01079, 01175, 01432, 01547, 01698 |
| Intas Pharma Sanand Networking | 2 | 01685, 01688 |
| JK Cement Bihar Implementation | 5 | 00690, 00691, 01054, 01272, 01666 |
| MAS Financial Ahmedabad Networking, ELV, Collaboration | 2 | 00400, 00648 |
| Neogen Iconics Bharuch Networking | 2 | 01520, 01521 |
| Newzone India Madhya Pradesh Networking, Collaboration, System Infra, Security | 7 | 00875, 01568, 01569, 01572, 01573, 01617, 01618 |
| ONGC Ahmedabad Collaboration | 2 | 00862, 00863 |
| Piramal Pharma Digwal IMPL | 2 | 02563, 02564 |
| Piramal Pharma Pithampur IMPL | 6 | 00402, 00760, 00761, 01008, 01009, 01150 |
| Polycab India Halol Networking, ELV, Collaboration, System Infra, Implementation & IT Service | 22 | 00496, 00535, 00536, 00631, 00634, 00677, 00743, 00755, 00787, 00789, 00798, 00803, 00955, 00959, 01045, 01116, 01224, 01294, 01389, 01390, 01391, 01576 |
| RBEL Kakinada-1 Networking, ELV, Collaboration & System Infra | 3 | 00509, 00745, 01013 |
| RBEL Kakinada-2 Networking, ELV, Collaboration & System Infra | 2 | 00842, 01044 |
| RBML NRO Project. COCO | 18 | 00547, 00548, 00549, 00550, 00551, 00552, 00553, 00554, 00773, 00774, 00775, 00776, 00777, 01021, 01022, 01681, 01682, NRO |
| RBML Solutions CAI services for rebranding With store | 12 | 00878, 00879, 00880, 00882, 00883, 00884, 00885, 01699, 01700, 01701, 01702, 01703 |
| Reliance BP West India Automation | 1 | 00404 |
| Reliance CBG AP State Implementation | 48 | 00458, 00459, 00460, 00464, 00490, 00592, 00593, 00594, 00728, 00746, 00860, 00861, 00965, 00966, 00980, 00981, 00982, 00984, 00987, 00988, 00989, 01191, 01192, 01193, 01194, 01217, 01260, 01261, 01342, 01410, 01411, 01427, 01496, 01518, 01554, 01555, 01558, 01560, 01561, 01562, 01563, 01564, 01581, 01582, 01583, 01584, 01650, 01652 |
| Reliance CBG Jind 1 & 2 Implementation | 23 | 00506, 00537, 00538, 00539, 00788, 00995, 00998, 00999, 01001, 01002, 01184, 01185, 01273, 01274, 01338, 01339, 01412, 01413, 01506, 01507, 01579, 01580, 02184 |
| Reliance CBG MH State Implementation | 20 | 00461, 00750, 00871, 00902, 00996, 00997, 01000, 01195, 01674, 04611, 04776, 04777, 04778, 05926, 05927, 05928, 08483, 12502, 12908, 12909 |
| Reliance CBG Mansa Implementation | 4 | 00499, 00500, 00795, 00796 |
| Reliance CBG OD State Implementation | 7 | 01158, 01343, 01354, 01672, 01673, 01675, 01676 |
| Reliance CBG UP State Implementation | 4 | CCTV, CCTV, CCTV, Network Implementation |
| Reliance Industries Dahej PM FMS Services | 1 | 00401 |
| Reliance Industries Jamnagar IT Services | 13 | 11699, 11706, 11707, 11714, 11715, 11727, 11729, 11731, 11733, 11735, 11738, 11740, 12149 |
| Reliance Industries Vadodara Implementation | 15 | 00399, 00637, 00639, 00719, 00720, 00856, 00857, 00858, 01135, 01138, 01142, 01444, 01445, 01514, 01677 |
| Reliance NRO - DODO | 73 | 00472, 00474, 00476, 00477, 00478, 00479, 00482, 00483, 00484, 00485, 00486, 00487, 00488, 00489, 00572, 00573, 00574, 00575, 00576, 00726, 00727, 00748, 00749, 00939, 00940, 00941, 00942, 00943, 00944, 00945, 00946, 00947, 00948, 01212, 01213, 01214, 01255, 01256, 01257, 01344, 01345, 01346, 01347, 01348, 01349, 01350, 01351, 01355, 01356, 01357, 01358, 01627, 01628, 01629, 01630, 01631, 01632, 01633, 01634, 01635, 01637, 01638, 01639, 01640, 01641, 01642, 01643, 01644, 01645, 01683, It work, Nro, Opt |
| Reliance North, South & West India Automation | 56 | 00580, 00581, 00617, 00698, 01105, 01107, 01109, 01119, 01140, 01141, 01143, 01171, 01172, 01176, 01177, 01178, 01179, 01180, 01181, 01295, 01296, 01297, 01298, 01299, 01300, 01301, 01302, 01303, 01341, 01402, 01403, 01404, 01405, 01406, 01619, 01620, 01621, 01622, 01623, 01624, 01625, 01626, 01720, 01721, 01722, 01723, 01724, 01725, 01726, 01727, 01728, 01729, 01730, 01731, 01732, Engineer visit to locking system installation |
| Reliance North,South & West India Automation | 38 | 00829, 00830, 00831, 00832, 00833, 00834, 00935, 00936, 00937, 00938, 01121, 01122, 01123, 01124, 01125, 01126, 01127, 01144, 01164, 01165, 01166, 01168, 01169, 01200, 01241, 01597, 01598, 01599, 01600, 01601, 01602, 01603, 01604, 01605, 10400, Atg interlock work, Cctv maintenance, Cctv mantince |
| Reliance Prayagraj Networking, ELV, collaboration & System Infra | 1 | CCTV camera Installation |
| SURVEY | 2 | 00520, 00521 |
| Saumya Construction Ahmedabad Networking, ELV, Collaboration | 2 | 06921, 06922 |
| Stallion Labs Ahmedabad Networking, ELV, Collaboration | 2 | 00619, 00620 |
| TORRENT Power Ahmebadad Networking & Implementation | 2 | 00874, 00876 |
| TOrrent Power Ahmedabad Implementation | 8 | 00522, 00527, 00534, 00540, 00541, 00934, 01425, 01426 |
| The Puri Foundation Gandhinagar Networking | 2 | 01497, 01498 |
| The Puri Foundation Gandhinagar Networking, ELV | 7 | 01090, 01091, 01415, 01416, 01420, 01421, 01678 |
| Torrent GAS Multiple Locations CAMC of CCTV system | 1 | 06832 |
| Torrent Power Agra Implementation | 4 | 00392, 00393, 00394, 03515 |
| Troikaa Dahej ELV Project | 1 | 01505 |
| Veer Narmad Surat Networking | 1 | 00638 |

## Part 2 — Still pending (nothing written, nothing guessed)

### 2a. Project Unique ID never selected — 60 transactions

No value was ever chosen at submission, and no batch-sibling signal exists to infer one (either not part of a batch, or every sibling in the batch is also blank/disagrees).

| Voucher No | Employee | Employee Code | Date | Status | Reason |
|---|---|---|---|---|---|
| 14780 | Abdullah Abdul Basir Shaikh | 6849 | 2007-11-09 | submitted | not part of a batch |
| 14781 | Abhishek Chunnilal Shende | 2423 | 2007-11-09 | submitted | not part of a batch |
| 14782 | Abhishek Kumar | 6855 | 2007-11-09 | submitted | not part of a batch |
| 14783 | Abhishek Sharma | 6349 | 2007-11-09 | submitted | not part of a batch |
| 14784 | Abhishek Yadav | 6938 | 2007-11-09 | submitted | not part of a batch |
| 14785 | Adil Afshan | 6236 | 2007-11-09 | submitted | not part of a batch |
| 14786 | Aditya Mahendrakumar Parmar | 4101 | 2007-11-09 | submitted | not part of a batch |
| 14787 | Adnan Qureshi | 4003 | 2007-11-09 | submitted | not part of a batch |
| 14788 | Ajay Chaudhary | 6754 | 2007-11-09 | submitted | not part of a batch |
| 14789 | Ajay Kumar | 6928 | 2007-11-09 | submitted | not part of a batch |
| 00517 | Aman Jaiswal | 6826 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00516 | Aman Jaiswal | 6826 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00780 | Aman Jaiswal | 6826 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00779 | Aman Jaiswal | 6826 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 05178 | Bhavesh Hirabhai Prajapati | 6842 | 2026-07-21 | approved | not part of a batch |
| 12263 | Eshwer Balabattini | 6333 | 2026-07-31 | submitted | not part of a batch |
| 12985 | Gajanand Matre | 6860 | 2026-08-13 | submitted | not part of a batch |
| Nro | Gautam Meena | 6815 | 2026-07-16 | draft | not part of a batch |
| Nro | Gautam Meena | 6815 | 2026-08-07 | draft | has batch, siblings also blank/disagree |
| Nro | Gautam Meena | 6815 | 2026-08-12 | draft | not part of a batch |
| 07772 | Jayesh Patel | 6101 | 2026-07-31 | approved | has batch, siblings also blank/disagree |
| 07773 | Jayesh Patel | 6101 | 2026-07-31 | approved | has batch, siblings also blank/disagree |
| 01110 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01115 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01114 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01113 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01112 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01111 | K. Ramesh Babu | 5437 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01117 | K. Ramesh Babu | 5437 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| 01118 | K. Ramesh Babu | 5437 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| Jamnagar afs | Katheria Arun Amrutbhai | 6557 | 2026-07-30 | draft | has batch, siblings also blank/disagree |
| 00530 | Kuldeep Patel | 6223 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00532 | Kuldeep Patel | 6223 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00767 | Kuldeep Patel | 6223 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00805 | Kuldeep Patel | 6223 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00768 | Kuldeep Patel | 6223 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00806 | Kuldeep Patel | 6223 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01067 | Kuldeep Patel | 6223 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| 01063 | Kuldeep Patel | 6223 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| 01068 | Kuldeep Patel | 6223 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| 01064 | Kuldeep Patel | 6223 | 2026-07-03 | approved | has batch, siblings also blank/disagree |
| 01454 | Kuldeep Patel | 6223 | 2026-07-06 | approved | has batch, siblings also blank/disagree |
| 01453 | Kuldeep Patel | 6223 | 2026-07-06 | approved | has batch, siblings also blank/disagree |
| 00533 | Kunal Singh Kori | 6920 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00531 | Kunal Singh Kori | 6920 | 2026-07-01 | approved | has batch, siblings also blank/disagree |
| 00782 | Kunal Singh Kori | 6920 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00781 | Kunal Singh Kori | 6920 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 01081 | Kunal Singh Kori | 6920 | 2026-07-04 | approved | has batch, siblings also blank/disagree |
| 01082 | Kunal Singh Kori | 6920 | 2026-07-04 | approved | has batch, siblings also blank/disagree |
| 01083 | Kunal Singh Kori | 6920 | 2026-07-04 | approved | has batch, siblings also blank/disagree |
| 01080 | Kunal Singh Kori | 6920 | 2026-07-04 | approved | has batch, siblings also blank/disagree |
| IT work | Kunal Singh Kori | 6920 | 2026-08-01 | draft | not part of a batch |
| 00772 | Nand Lal Paswan | 5944 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00771 | Nand Lal Paswan | 5944 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 02859 | Nilesh Ramshi Vaghela | 6840 | 2026-07-11 | approved | not part of a batch |
| 07068 | Pavankumar Prahladbhai Ramchandani | 6887 | 2026-07-22 | approved | has batch, siblings also blank/disagree |
| 00800 | Virendrasinh Mahida | 6118 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00802 | Virendrasinh Mahida | 6118 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00801 | Virendrasinh Mahida | 6118 | 2026-07-02 | approved | has batch, siblings also blank/disagree |
| 00799 | Virendrasinh Mahida | 6118 | 2026-07-02 | approved | has batch, siblings also blank/disagree |

### 2b. Project ID / Project Name still blank despite a known Project Unique ID — 5 transactions

Every one of these belongs to one of two projects: `197001M3`, which genuinely has two legitimate values on record (Project ID `326`/`506`, Project Name `Training`/`Support`, both actually in use, by the app's own admin-configured options list — picking one would be wrong for a real share of its expenses), or `202606M231`, which has no Project ID/Name field configured for it at all (not merely an unfilled value — the branch definitions themselves don't exist). Both require a human decision, not a script — see `daily-report-project-id-backfill-2026-08-26.md` for the full investigation. (A separate earlier finding — 3 projects with a single admin-configured option but zero submissions — was resolved automatically using that single option as the authoritative value, since a select field constrained to one choice has only one possible correct answer; included in Part 1 above, not repeated here.)

| Voucher No | Employee | Employee Code | Date | Status | Project Unique ID | Missing |
|---|---|---|---|---|---|---|
| 01023 | Aman Jaiswal | 6826 | 2026-07-03 | approved | 197001M3 | Project ID, Project Name |
| 01437 | Gajanand Matre | 6860 | 2026-07-06 | approved | 197001M3 | Project ID, Project Name |
| 01438 | Gajanand Matre | 6860 | 2026-07-06 | approved | 197001M3 | Project ID, Project Name |
| 01069 | Nand Lal Paswan | 5944 | 2026-07-03 | approved | 197001M3 | Project ID, Project Name |
| 01078 | Mayur Patel | 5740 | 2026-07-03 | approved | 202606M231 | Project ID, Project Name |

## Summary

| Category | Count |
|---|---|
| Recovered — Project Unique ID (neighbor prediction) | 73 |
| Recovered — Project Unique ID (batch-sibling inference) | 16 |
| Recovered — Project ID | 501 |
| Recovered — Project Name | 505 |
| **Recovered total** | **1095** |
| Pending — Project Unique ID | 60 |
| Pending — Project ID / Project Name | 5 |
| **Pending total** | **65** |

Backup instance only. NOT applied to Production.