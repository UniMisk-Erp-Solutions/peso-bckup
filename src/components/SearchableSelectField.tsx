import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { RECENT_FORM_FIELD_OPTIONS_LIMIT } from "@/lib/recommendedFormFieldOptions";

export type SearchableSelectFieldProps = {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  /** Usage-based recents (shown at top of list, max 4). */
  recentOptions?: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export function SearchableSelectField({
  id,
  value,
  onValueChange,
  options,
  recentOptions = [],
  placeholder,
  disabled = false,
  className,
}: SearchableSelectFieldProps) {
  const { t } = useTranslation("expenses");
  const [open, setOpen] = useState(false);

  const { recents, otherOptions } = useMemo(() => {
    const validRecents = recentOptions
      .filter((option) => options.includes(option))
      .slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT);
    const recentSet = new Set(validRecents);
    return {
      recents: validRecents,
      otherOptions: options.filter((option) => !recentSet.has(option)),
    };
  }, [options, recentOptions]);

  const displayPlaceholder = placeholder || t("form.customFields.selectOption");

  const renderOption = (option: string, keyPrefix: string) => (
    <CommandItem
      key={`${keyPrefix}-${option}`}
      value={option}
      onSelect={() => {
        onValueChange(option);
        setOpen(false);
      }}
    >
      <Check
        className={cn("mr-2 h-4 w-4 shrink-0", value === option ? "opacity-100" : "opacity-0")}
      />
      <span className="truncate">{option}</span>
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || options.length === 0}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate text-left">
            {value || displayPlaceholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("form.customFields.searchOptions")} />
          <CommandList>
            <CommandEmpty>{t("form.customFields.noOptionsFound")}</CommandEmpty>
            {recents.length > 0 ? (
              <>
                <CommandGroup heading={t("form.customFields.recentOptions")}>
                  {recents.map((option) => renderOption(option, "recent"))}
                </CommandGroup>
                {otherOptions.length > 0 ? (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading={t("form.customFields.allOptions")}>
                      {otherOptions.map((option) => renderOption(option, "all"))}
                    </CommandGroup>
                  </>
                ) : null}
              </>
            ) : (
              <CommandGroup>
                {options.map((option) => renderOption(option, "opt"))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
