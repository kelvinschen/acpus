import * as React from "react";
import { cn } from "../../lib/utils.js";

export interface ListProps extends React.HTMLAttributes<HTMLDivElement> {}

export const List = React.forwardRef<HTMLDivElement, ListProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("ui-list", className)} {...props} />
  ),
);
List.displayName = "List";

export interface ListRowProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const ListRow = React.forwardRef<HTMLButtonElement, ListRowProps>(
  ({ className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn("ui-list-row", className)} {...props} />
  ),
);
ListRow.displayName = "ListRow";
