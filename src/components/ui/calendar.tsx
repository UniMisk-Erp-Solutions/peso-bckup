import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button as DayPickerButton, DayPicker, type DayProps, useDayRender } from "react-day-picker";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type CalendarProps = React.ComponentProps<typeof DayPicker> & {
  /**
   * Returns a user-facing explanation for why `date` is unselectable, for a
   * reason the caller wants EXPLAINED to the user (e.g. an admin-imposed
   * expense date lock) -- distinct from the plain `disabled` matcher
   * (future dates, etc.), which gets no tooltip/aria explanation at all.
   * A day this returns non-null for is rendered as visually
   * disabled-looking (muted, "not-allowed" cursor) but deliberately does
   * NOT get the HTML `disabled` attribute: a real disabled button blocks
   * hover/focus/click at the browser level, which would make it impossible
   * to show a tooltip on hover/focus or a tap-to-explain message on
   * mobile. The caller's `onDayClick`/`onSelect` is responsible for
   * refusing to actually select a day this returns a reason for.
   */
  getLockedDayReason?: (date: Date) => string | null;
};

/** Wraps react-day-picker's own default `Day` rendering (see its
 *  `useDayRender` docs) to add a tooltip + accessible explanation for a day
 *  `getLockedDayReason` flags, without altering any other day's behavior. */
function LockAwareDay(props: DayProps & { getLockedDayReason?: CalendarProps["getLockedDayReason"] }) {
  const { getLockedDayReason, ...dayProps } = props;
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const dayRender = useDayRender(dayProps.date, dayProps.displayMonth, buttonRef);

  if (dayRender.isHidden) {
    return <div role="gridcell" />;
  }
  if (!dayRender.isButton) {
    return <div {...dayRender.divProps} />;
  }

  const reason = getLockedDayReason?.(dayProps.date) ?? null;
  if (!reason) {
    return <DayPickerButton name="day" ref={buttonRef} {...dayRender.buttonProps} />;
  }

  const dateLabel = dayProps.date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const button = (
    <DayPickerButton
      name="day"
      ref={buttonRef}
      {...dayRender.buttonProps}
      className={cn(dayRender.buttonProps.className, "opacity-50 cursor-not-allowed")}
      aria-label={`${dateLabel} — ${reason}`}
      title={reason}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

function Calendar({ className, classNames, showOutsideDays = true, getLockedDayReason, components, ...props }: CalendarProps) {
  return (
    <TooltipProvider>
      <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
        month: "space-y-4",
        caption: "flex justify-center pt-1 relative items-center",
        caption_label: "text-sm font-medium",
        nav: "space-x-1 flex items-center",
        nav_button: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        nav_button_previous: "absolute left-1",
        nav_button_next: "absolute right-1",
        table: "w-full border-collapse space-y-1",
        head_row: "flex",
        head_cell: "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        row: "flex w-full mt-2",
        cell: "h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20",
        day: cn(buttonVariants({ variant: "ghost" }), "h-9 w-9 p-0 font-normal aria-selected:opacity-100"),
        day_range_end: "day-range-end",
        day_selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        day_today: "bg-accent text-accent-foreground",
        day_outside:
          "day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        day_disabled: "text-muted-foreground opacity-50",
        day_range_middle: "aria-selected:bg-accent aria-selected:text-accent-foreground",
        day_hidden: "invisible",
        ...classNames,
      }}
      components={{
        IconLeft: ({ ..._props }) => <ChevronLeft className="h-4 w-4" />,
        IconRight: ({ ..._props }) => <ChevronRight className="h-4 w-4" />,
        Day: (dayProps) => <LockAwareDay {...dayProps} getLockedDayReason={getLockedDayReason} />,
        ...components,
      }}
        {...props}
      />
    </TooltipProvider>
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
