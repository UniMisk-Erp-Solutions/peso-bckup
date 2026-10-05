import { useCallback, useRef, useState } from "react";

/**
 * Resizable table columns with localStorage persistence.
 *
 * Usage:
 *   const { colWidth, startResize } = useResizableColumns("my_table", { name: 160, amount: 100 });
 *
 * On each <th>:
 *   <th style={{ width: colWidth("name"), minWidth: colWidth("name") }} className="relative group/th">
 *     {label}
 *     <div className={resizeHandleClass} onMouseDown={(e) => startResize("name", e)} />
 *   </th>
 */
export const resizeHandleClass =
  "absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none " +
  "opacity-0 group-hover/th:opacity-100 hover:!opacity-100 " +
  "bg-border hover:bg-primary/40 transition-opacity z-10";

/**
 * A persisted width from an earlier session (possibly dragged against much
 * larger old defaults, or just an unusually wide manual drag) could exceed
 * a viewport that now needs to fit more/denser columns, permanently forcing
 * horizontal scroll for that one user with no way back short of clearing
 * localStorage by hand. Clamping restored values to a generous multiple of
 * the column's own current default keeps real customization intact (a
 * reviewer who genuinely wants Employee wider still gets meaningfully more
 * room than default) while capping runaway values. This only applies when
 * LOADING a persisted width -- an active drag (startResize below) is
 * intentional and is not clamped, matching the "manual overflow is
 * acceptable" rule for in-session resizing.
 */
const RESTORED_WIDTH_MAX_MULTIPLIER = 3;

function loadWidths(key: string, defaults: Record<string, number>): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      const clamped: Record<string, number> = {};
      for (const [col, value] of Object.entries(parsed)) {
        const columnDefault = defaults[col];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        clamped[col] = columnDefault
          ? Math.min(value, columnDefault * RESTORED_WIDTH_MAX_MULTIPLIER)
          : value;
      }
      return { ...defaults, ...clamped };
    }
  } catch {
    // ignore corrupt storage
  }
  return defaults;
}

export function useResizableColumns(
  storageKey: string,
  defaults: Record<string, number>,
) {
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    loadWidths(storageKey, defaults),
  );
  const dragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = {
        key,
        startX: e.clientX,
        startWidth: widths[key] ?? defaults[key] ?? 100,
      };

      const onMove = (mv: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = mv.clientX - dragRef.current.startX;
        const next = Math.max(60, dragRef.current.startWidth + delta);
        setWidths((prev) => {
          const updated = { ...prev, [dragRef.current!.key]: next };
          try { localStorage.setItem(storageKey, JSON.stringify(updated)); } catch { /* quota */ }
          return updated;
        });
      };

      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [widths, defaults, storageKey],
  );

  const colWidth = useCallback(
    (key: string) => widths[key] ?? defaults[key] ?? 100,
    [widths, defaults],
  );

  return { widths, colWidth, startResize };
}
