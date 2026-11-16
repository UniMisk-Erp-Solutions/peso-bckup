# Phase 11 — Frontend UX (design only)

No routes or queries changed in this release.

## Proposed navigation

- **Expenses:** tabs `Current` | `Archived (slow)`  
- **Reports:** `Current period` | `Historical archive`  

## Behaviour

- Default lists use existing hot queries (`ExpenseService`, etc.).  
- **Archived** tab calls `get_archived_expenses_v1` via `src/lib/archive/historicalRead.ts`.  
- Banner: *"Archived data may load more slowly."*  
- No mixing archive rows into dashboard stats or approval queues.

## Attachments

Use `getAttachmentUrl()` when cold catalog populated; until then hot signed URLs only.
