import { Avatar } from "@ion/design-system";
import type { IonInfo } from "@ion/schema";

/** An ion's avatar: ion chief's orbit bot, or its project's colour on its agent's shape. */
export const IonAvatar = ({ ion }: { ion: IonInfo }) => (
  <Avatar ion={ion.ionId === "chief" ? "chief" : { harness: ion.harness, color: ion.color }} />
);

/** ion chief's name is the wordmark. */
export const IonName = ({ ion, className }: { ion: IonInfo; className: string }) =>
  ion.ionId === "chief" ? (
    <span className={`brand ${className}`} aria-label="ion">
      i<i>o</i>n
    </span>
  ) : (
    <span className={className}>{ion.name}</span>
  );
