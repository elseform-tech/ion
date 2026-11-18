import type { ButtonHTMLAttributes } from "react";

/** A button in ion's style: "primary" (light, for the one main action) or "ghost" (outlined). */
export function Button({
  variant = "ghost",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const cls = ["ion-button", variant === "primary" ? "ion-button--primary" : "", className ?? ""];
  return <button type="button" className={cls.filter(Boolean).join(" ")} {...rest} />;
}
