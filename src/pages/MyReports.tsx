import Reports from "./Reports";

/** Employee self-report: the same Reports page, scope hard-fixed server-side to the caller. */
export default function MyReports() {
  return <Reports teamScoped selfOnly />;
}
