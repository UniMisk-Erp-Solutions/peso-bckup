import Reports from "./Reports";

/** Reports limited to employees on teams the current user leads. */
export default function TeamReports() {
  return <Reports teamScoped />;
}
