"use client"

import { Form as FormPrimitive } from "@base-ui/react/form"

import { cn } from "@/registry/default/lib/utils"

/**
 * A form that validates its `Field`s. Pass server errors as `errors={{ email: "Taken" }}` (keys
 * are field names) and read typed values in `onFormSubmit`.
 */
function Form<Values extends Record<string, any> = Record<string, any>>({
  className,
  ...props
}: FormPrimitive.Props<Values>) {
  return (
    <FormPrimitive<Values>
      data-slot="form"
      className={cn("flex w-full flex-col gap-6", className)}
      {...props}
    />
  )
}

export { Form }
