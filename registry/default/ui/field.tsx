"use client"

import * as React from "react"
import { Field as FieldPrimitive } from "@base-ui/react/field"
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/registry/default/lib/utils"

/** Groups related fields under a legend. */
function FieldSet({ className, ...props }: FieldsetPrimitive.Root.Props) {
  return (
    <FieldsetPrimitive.Root
      data-slot="field-set"
      className={cn("flex flex-col gap-6", className)}
      {...props}
    />
  )
}

function FieldLegend({ className, ...props }: FieldsetPrimitive.Legend.Props) {
  return (
    <FieldsetPrimitive.Legend
      data-slot="field-legend"
      className={cn("mb-3 text-base font-medium", className)}
      {...props}
    />
  )
}

/** Stacks fields with consistent spacing. */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn("group/field-group flex w-full flex-col gap-6", className)}
      {...props}
    />
  )
}

const fieldVariants = cva("group/field flex w-full gap-2", {
  variants: {
    orientation: {
      vertical: "flex-col *:w-full",
      horizontal: "flex-row items-center *:data-[slot=field-label]:flex-auto",
    },
  },
  defaultVariants: {
    orientation: "vertical",
  },
})

/**
 * One form field: a label, a control (`Input`, or anything wrapped in `FieldControl`), a
 * description and errors. `name` ties it to `Form` errors; `validate` adds custom checks.
 */
function Field({
  className,
  orientation = "vertical",
  ...props
}: FieldPrimitive.Root.Props & VariantProps<typeof fieldVariants>) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  )
}

/** Holds a label and description next to a control in a horizontal field. */
function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex flex-1 flex-col gap-1.5 leading-snug", className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm leading-snug font-medium select-none group-data-disabled/field:opacity-50 group-data-invalid/field:text-destructive",
        className
      )}
      {...props}
    />
  )
}

/** Wraps a native control that is not an `Input` so it joins the field's validation. */
function FieldControl({ className, ...props }: FieldPrimitive.Control.Props) {
  return <FieldPrimitive.Control data-slot="field-control" className={className} {...props} />
}

function FieldDescription({ className, ...props }: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn(
        "text-sm leading-normal font-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  )
}

/**
 * Shows the field's validation message. Without `match` it shows whenever the field is invalid,
 * including errors passed to `Form` for the field's `name`; `match="valueMissing"` (or another
 * ValidityState key) shows it only for that problem.
 */
function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn("text-sm font-normal text-destructive", className)}
      {...props}
    />
  )
}

function FieldSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="field-separator"
      className={cn("my-2 h-px w-full bg-border", className)}
      {...props}
    />
  )
}

export {
  Field,
  FieldContent,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
}
