import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib/utils";
import { badgeVariants } from "@/shared/ui/badge-variants";
import { Slot } from "radix-ui";

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge };
