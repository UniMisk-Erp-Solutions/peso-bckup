/**
 * Debug employee search (DOC-080). Alias over the shared submit-driven hook, so
 * the "typing issues zero requests" guarantee has exactly one implementation.
 */

export {
  useEmployeeSearch as useDebugEmployeeSearch,
  toSelectedEmployee,
} from "@/features/reviewQueueServer/hooks/useEmployeeSearch";
export type { EmployeeSearchState } from "@/features/reviewQueueServer/hooks/useEmployeeSearch";
