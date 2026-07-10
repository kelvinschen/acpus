import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "primary-button",
      icon: "icon-button",
      ghost: "ui-button-ghost",
      tool: "graph-tool-button",
      confirmPrimary: "confirm-primary",
      confirmSecondary: "confirm-secondary",
      tab: "inspector-tab",
    },
    tone: {
      default: "",
      pause: "pause",
      resume: "resume",
      retry: "retry",
      cancel: "cancel",
      destructive: "cancel",
    },
  },
  defaultVariants: {
    variant: "default",
    tone: "default",
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, tone, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, tone }), className)} {...props} />;
  },
);
Button.displayName = "Button";
