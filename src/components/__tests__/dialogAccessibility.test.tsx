/**
 * Console audit 2026-10-16 -- "Missing `Description` or `aria-describedby={undefined}` for
 * {DialogContent}". Radix warns for every dialog/sheet that has neither. This suite
 *   1. proves the warning really fires for a bare dialog (control) and not for the fixed shapes;
 *   2. scans the whole source tree so a new description-less dialog cannot be added unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CommandDialog, CommandInput } from "@/components/ui/command";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const missingDescriptionWarnings = () =>
  warn.mock.calls.filter((c) => String(c[0]).includes("Missing `Description` or `aria-describedby={undefined}`"));

describe("Radix description warning", () => {
  it("control: a dialog with a title but no description warns", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader><DialogTitle>Title</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(missingDescriptionWarnings().length).toBeGreaterThan(0);
  });

  it("a dialog with a DialogDescription does not warn", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Real description</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(missingDescriptionWarnings()).toHaveLength(0);
  });

  it("an intentionally description-less dialog (aria-describedby={undefined}) does not warn", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Add category</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(missingDescriptionWarnings()).toHaveLength(0);
  });

  it("the command palette dialog does not warn", () => {
    render(
      <CommandDialog open>
        <CommandInput placeholder="Search" />
      </CommandDialog>,
    );
    expect(missingDescriptionWarnings()).toHaveLength(0);
  });

  it("a sheet with a SheetDescription does not warn", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription className="sr-only">Filters</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );
    expect(missingDescriptionWarnings()).toHaveLength(0);
  });
});

describe("no description-less dialog/sheet exists anywhere in src/", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(p, out);
      } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(p);
    }
    return out;
  }

  it("every DialogContent / AlertDialogContent / SheetContent has a Description or aria-describedby", () => {
    const pairs: Record<string, string> = {
      DialogContent: "DialogDescription",
      AlertDialogContent: "AlertDialogDescription",
      SheetContent: "SheetDescription",
    };
    const offenders: string[] = [];
    for (const f of walk(resolve(process.cwd(), "src"))) {
      const s = readFileSync(f, "utf-8");
      for (const m of s.matchAll(/<(DialogContent|AlertDialogContent|SheetContent)\b([^>]*)>/g)) {
        const tag = m[1];
        const end = s.indexOf(`</${tag}>`, m.index! + m[0].length);
        const body = s.slice(m.index! + m[0].length, end > 0 ? end : m.index! + 6000);
        if (body.includes(pairs[tag]) || m[2].includes("aria-describedby")) continue;
        offenders.push(`${f.replace(/\\/g, "/").split("/src/")[1]}:${s.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
