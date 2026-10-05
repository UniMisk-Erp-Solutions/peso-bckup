import { useEffect, useId, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const INITIAL_VISIBLE_COUNT = 8;

export type RecentValueTextInputProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Recently-used values for this field/context, most-recent first, already
   *  capped at 25 server-side. Pass [] (or omit) to render a plain input with
   *  zero visible difference -- feature-off / no-data / fetch-error all look
   *  identical to today's control. */
  recentValues?: string[];
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  className?: string;
};

/**
 * A free-text input that always behaves like a normal <Input>/<Textarea> --
 * typing any value is always allowed -- plus an optional "Recent" suggestion
 * list shown on focus, filtered as the user types. Selecting a suggestion is
 * equivalent to typing it manually (no hidden semantic difference, DOC-130
 * section 25). Implements the ARIA combobox pattern (arrow keys, Enter,
 * Escape) rather than mouse-only selection.
 *
 * Browser-native autofill suppression: Chromium/Edge can still show its own
 * form-history dropdown over a field whose `id`/label reads like an address
 * or location, even with autoComplete="off" -- that attribute alone is a
 * hint, not an enforced contract. Pairing it with a `name` that does not
 * pattern-match address/location heuristics (browsers group and predict
 * autofill primarily by `name`, separately from the `id` used for label
 * association/accessibility) closes that gap without touching `id` or
 * breaking anything else -- scoped to only these memory-enabled inputs.
 */
export function RecentValueTextInput({
  id,
  value,
  onChange,
  recentValues = [],
  placeholder,
  required,
  multiline = false,
  rows,
  className,
}: RecentValueTextInputProps) {
  const { t } = useTranslation("expenses");
  const [focused, setFocused] = useState(false);
  const [justSelected, setJustSelected] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const reactId = useId();
  const listboxId = `pw-recent-listbox-${reactId}`;
  const optionIdPrefix = `pw-recent-option-${reactId}-`;

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    const source = query
      ? recentValues.filter((v) => v.toLowerCase().includes(query) && v !== value)
      : recentValues;
    return source.slice(0, query ? 25 : INITIAL_VISIBLE_COUNT);
  }, [recentValues, value]);

  const showSuggestions = focused && !justSelected && filtered.length > 0;

  // Keep the highlight in range whenever the filtered list itself changes
  // (typing narrows it) -- never point at an index that no longer exists.
  useEffect(() => {
    if (!showSuggestions) {
      setHighlightedIndex(-1);
      return;
    }
    setHighlightedIndex((prev) => (prev >= 0 && prev < filtered.length ? prev : -1));
  }, [showSuggestions, filtered.length]);

  const handleSelect = (v: string) => {
    onChange(v);
    setJustSelected(true);
    setHighlightedIndex(-1);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setJustSelected(false);
    onChange(e.target.value);
  };
  const handleFocus = () => setFocused(true);
  const handleBlur = () => {
    // Delay so a click on a suggestion registers before the list unmounts.
    setTimeout(() => setFocused(false), 150);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1 >= filtered.length ? 0 : prev + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
    } else if (e.key === "Enter") {
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        e.preventDefault();
        handleSelect(filtered[highlightedIndex]);
      }
    } else if (e.key === "Escape") {
      setFocused(false);
      setHighlightedIndex(-1);
    }
  };

  // ARIA combobox semantics only apply once there is at least one real
  // suggestion this field could ever show -- recentValues.length > 0, not
  // merely "focused". A field with no history (feature off, brand new
  // employee, fetch error) stays a plain textbox: presenting it as a
  // combobox with a popup that can never appear would mislead a screen
  // reader user, and every other render-path test in this codebase already
  // assumes "no data" renders as an ordinary <input>/<textarea>.
  const hasAnySuggestions = recentValues.length > 0;
  const comboboxProps = hasAnySuggestions
    ? {
        role: "combobox" as const,
        "aria-expanded": showSuggestions,
        "aria-controls": listboxId,
        "aria-autocomplete": "list" as const,
        "aria-activedescendant":
          showSuggestions && highlightedIndex >= 0 ? `${optionIdPrefix}${highlightedIndex}` : undefined,
      }
    : {};
  const autofillSuppressionProps = {
    // A non-address-pattern-matching name, scoped to this field only, so
    // Chromium/Edge's own form-history heuristics do not treat it as an
    // address/location field despite autoComplete="off" -- id (label
    // association) and all other accessibility wiring are untouched. Kept
    // regardless of hasAnySuggestions -- harmless, and avoids native
    // autofill even before this field's own memory data has loaded.
    name: `pw-recent-${reactId}`,
    autoComplete: "off",
  };

  return (
    <div className="relative">
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          rows={rows}
          className={className}
          {...autofillSuppressionProps}
          {...comboboxProps}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          className={className}
          {...autofillSuppressionProps}
          {...comboboxProps}
        />
      )}
      {showSuggestions && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t("form.recentValues.heading", { defaultValue: "Recent" })}
          className={cn(
            "absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
          )}
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("form.recentValues.heading", { defaultValue: "Recent" })}
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.map((v, i) => (
              <button
                type="button"
                id={`${optionIdPrefix}${i}`}
                role="option"
                aria-selected={i === highlightedIndex}
                key={v}
                className={cn(
                  "block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                  i === highlightedIndex && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => setHighlightedIndex(i)}
                onMouseDown={(e) => {
                  // onMouseDown (not onClick) fires before the input's onBlur.
                  e.preventDefault();
                  handleSelect(v);
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
