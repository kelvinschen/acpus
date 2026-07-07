import * as React from "react";
import { cn } from "../../lib/utils.js";

export const Breadcrumb = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <nav ref={ref} className={cn("breadcrumb", className)} {...props} />
  ),
);
Breadcrumb.displayName = "Breadcrumb";

export const BreadcrumbList = React.forwardRef<HTMLOListElement, React.OlHTMLAttributes<HTMLOListElement>>(
  ({ className, ...props }, ref) => (
    <ol ref={ref} className={cn("breadcrumb-list", className)} {...props} />
  ),
);
BreadcrumbList.displayName = "BreadcrumbList";

export const BreadcrumbItem = React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} className={cn("breadcrumb-item", className)} {...props} />
  ),
);
BreadcrumbItem.displayName = "BreadcrumbItem";

export const BreadcrumbButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn("breadcrumb-button", className)} {...props} />
  ),
);
BreadcrumbButton.displayName = "BreadcrumbButton";

export function BreadcrumbSeparator({ children }: { children: React.ReactNode }) {
  return <span className="breadcrumb-separator" aria-hidden="true">{children}</span>;
}
