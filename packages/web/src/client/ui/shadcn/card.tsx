import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
}

export const Card = React.forwardRef<HTMLElement, CardProps>(
  ({ className, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "section";
    return <Comp ref={ref} className={cn("ui-card", className)} {...props} />;
  },
);
Card.displayName = "Card";
