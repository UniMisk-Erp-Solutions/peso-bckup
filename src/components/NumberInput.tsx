import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type NumberInputProps = React.ComponentProps<typeof Input>;

/** Number input without mouse-wheel value changes while focused. */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, onWheel, ...props }, ref) => (
    <Input
      ref={ref}
      type="number"
      className={cn(className)}
      onWheel={(e) => {
        e.currentTarget.blur();
        onWheel?.(e);
      }}
      {...props}
    />
  ),
);
NumberInput.displayName = "NumberInput";
