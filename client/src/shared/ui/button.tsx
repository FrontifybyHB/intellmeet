import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib/utils";
import { buttonVariants } from "@/shared/ui/button-variants";
import { Slot } from "radix-ui";


export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

// forwardRef (not ref-as-prop) because the project runs React 18; Radix Slot
// relies on the ref to anchor menus, dialogs and tooltips to their trigger.
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : "button";

    return (
      <Comp
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button };
