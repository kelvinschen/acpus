import * as React from "react";
import { cn } from "../../lib/utils.js";

export const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("ui-alert", className)} {...props} />
  ),
);
Alert.displayName = "Alert";
