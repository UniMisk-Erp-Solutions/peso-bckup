import { useId, useMemo, useState } from "react";
import { CheckCircle, History } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import {
  DEMO_CATEGORIES,
  DEMO_CLIENTS,
  DEMO_DEPARTMENTS,
  DEMO_PROJECTS,
  DEMO_TRAVEL_TYPES,
  RECENT_LOCATIONS,
  type DemoCategory,
} from "./demoData";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Filters the recent list by what the user has typed (case-insensitive contains); never blocks free typing. */
export function filterRecentValues(all: string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  if (!q) return all;
  return all.filter((v) => v.toLowerCase().includes(q));
}

/**
 * Recent values combobox: a personal shortlist that helps repeat entry but
 * never restricts what can be typed. WAI-ARIA combobox + listbox semantics.
 */
function RecentValuesInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = useMemo(() => filterRecentValues(RECENT_LOCATIONS, value), [value]);
  const showList = open && options.length > 0;

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        placeholder="e.g. Ahmedabad Office"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && showList) {
            e.preventDefault();
            choose(options[active] ?? options[0]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList ? (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <p className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <History className="h-3 w-3" aria-hidden /> Recent
          </p>
          <ul id={listId} role="listbox" aria-label="Recent values">
            {options.map((o, i) => (
              <li
                key={o}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm text-foreground",
                  i === active ? "bg-accent/15" : "hover:bg-muted",
                )}
              >
                {o}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A playable version of the PesoWise expense form: category-specific fields,
 * conditional fields, project fields that fill together, and personal Recent
 * values. Local state only.
 */
export function InteractiveExpenseFormPreview({ className }: { className?: string }) {
  const uid = useId();
  const [category, setCategory] = useState<DemoCategory>("Travel");
  const [title, setTitle] = useState("Site visit");
  const [location, setLocation] = useState("");
  const [date, setDate] = useState("2026-09-18");
  const [purpose, setPurpose] = useState("");
  const [amount, setAmount] = useState("4850");
  // category-specific
  const [fromLoc, setFromLoc] = useState("");
  const [toLoc, setToLoc] = useState("");
  const [travelType, setTravelType] = useState<(typeof DEMO_TRAVEL_TYPES)[number]>("Project Visit");
  const [projectUid, setProjectUid] = useState(DEMO_PROJECTS[0].uniqueId);
  const [destination, setDestination] = useState("");
  const [client, setClient] = useState(DEMO_CLIENTS[0]);
  const [meetingLocation, setMeetingLocation] = useState("");
  const [vehicle, setVehicle] = useState("GJ-01-AB-1234");
  const [odometer, setOdometer] = useState("48210");
  const [department, setDepartment] = useState(DEMO_DEPARTMENTS[0]);
  const [vendor, setVendor] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const project = DEMO_PROJECTS.find((p) => p.uniqueId === projectUid) ?? DEMO_PROJECTS[0];
  const id = (n: string) => `${uid}-${n}`;

  const projectPicker = (
    <>
      <Field label="Project Unique ID" htmlFor={id("puid")}>
        <select id={id("puid")} className={selectClass} value={projectUid} onChange={(e) => setProjectUid(e.target.value)}>
          {DEMO_PROJECTS.map((p) => (
            <option key={p.uniqueId} value={p.uniqueId}>
              {p.uniqueId}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Project ID" htmlFor={id("pid")}>
          <Input id={id("pid")} readOnly value={project.projectId} className="bg-muted/50" />
        </Field>
        <Field label="Project Name" htmlFor={id("pname")}>
          <Input id={id("pname")} readOnly value={project.name} className="bg-muted/50" />
        </Field>
      </div>
    </>
  );

  if (submitted) {
    return (
      <ProductPreviewShell title="New expense" className={className}>
        <div className="flex flex-col items-center gap-3 py-10 text-center" role="status">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
            <CheckCircle className="h-6 w-6 text-success" aria-hidden />
          </span>
          <h3 className="text-base font-semibold text-foreground">Expense submitted</h3>
          <p className="max-w-xs text-sm text-muted-foreground">
            In PesoWise this goes to your approval path. This is a preview, so nothing was saved.
          </p>
          <Button variant="outline" size="sm" onClick={() => setSubmitted(false)}>
            Start over
          </Button>
        </div>
      </ProductPreviewShell>
    );
  }

  return (
    <ProductPreviewShell
      title="New expense"
      className={className}
      caption="Recent values are personal to each employee. Free typing always works."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" htmlFor={id("category")}>
            <select
              id={id("category")}
              className={selectClass}
              value={category}
              onChange={(e) => setCategory(e.target.value as DemoCategory)}
            >
              {DEMO_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" htmlFor={id("title")}>
            <Input id={id("title")} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Vendor / Location" htmlFor={id("location")}>
            <RecentValuesInput id={id("location")} value={location} onChange={setLocation} />
          </Field>
          <Field label="Expense Date" htmlFor={id("date")}>
            <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Purpose" htmlFor={id("purpose")}>
            <Input id={id("purpose")} value={purpose} placeholder="Why was this spent?" onChange={(e) => setPurpose(e.target.value)} />
          </Field>
          <Field label="Amount (₹)" htmlFor={id("amount")}>
            <Input id={id("amount")} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          </Field>
        </div>

        <div
          className="space-y-3 rounded-xl border border-dashed border-border bg-muted/20 p-3.5"
          data-testid="demo-custom-fields"
          aria-label={`${category} details`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{category} details</p>

          {category === "Travel" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From Location" htmlFor={id("from")}>
                  <Input id={id("from")} value={fromLoc} onChange={(e) => setFromLoc(e.target.value)} placeholder="Start" />
                </Field>
                <Field label="To Location" htmlFor={id("to")}>
                  <Input id={id("to")} value={toLoc} onChange={(e) => setToLoc(e.target.value)} placeholder="End" />
                </Field>
              </div>
              <Field label="Travel Type" htmlFor={id("ttype")}>
                <select
                  id={id("ttype")}
                  className={selectClass}
                  value={travelType}
                  onChange={(e) => setTravelType(e.target.value as (typeof DEMO_TRAVEL_TYPES)[number])}
                >
                  {DEMO_TRAVEL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              {travelType === "Project Visit" ? (
                <div data-testid="demo-conditional-project" className="space-y-3">
                  {projectPicker}
                  <Field label="Destination" htmlFor={id("dest")}>
                    <Input id={id("dest")} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Site or plant" />
                  </Field>
                </div>
              ) : (
                <div data-testid="demo-conditional-client" className="grid gap-3 sm:grid-cols-2">
                  <Field label="Client" htmlFor={id("client")}>
                    <select id={id("client")} className={selectClass} value={client} onChange={(e) => setClient(e.target.value)}>
                      {DEMO_CLIENTS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Meeting Location" htmlFor={id("mloc")}>
                    <Input id={id("mloc")} value={meetingLocation} onChange={(e) => setMeetingLocation(e.target.value)} />
                  </Field>
                </div>
              )}
            </>
          )}

          {category === "Fuel" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Vehicle Number" htmlFor={id("veh")}>
                  <Input id={id("veh")} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
                </Field>
                <Field label="Odometer" htmlFor={id("odo")}>
                  <Input id={id("odo")} inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
                </Field>
              </div>
              {projectPicker}
            </>
          )}

          {category === "Site Purchase" && (
            <>
              {projectPicker}
              <Field label="Site Vendor" htmlFor={id("svendor")}>
                <Input id={id("svendor")} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier name" />
              </Field>
            </>
          )}

          {category === "Office Expense" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Vendor" htmlFor={id("ovendor")}>
                <Input id={id("ovendor")} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier name" />
              </Field>
              <Field label="Department" htmlFor={id("dept")}>
                <select id={id("dept")} className={selectClass} value={department} onChange={(e) => setDepartment(e.target.value)}>
                  {DEMO_DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button type="submit" size="sm">
            Submit expense
          </Button>
        </div>
      </form>
    </ProductPreviewShell>
  );
}
