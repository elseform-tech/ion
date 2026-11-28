import { ChevronDown, ChevronUp } from "@ion/design-system";

/** The lab's More: a quiet line that opens a page's advanced parts (Plan 21 Task 4: they show once used). */
export function More({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <button className="more" type="button" aria-expanded={open} onClick={() => onOpen(!open)}>
      More
      {open ? <ChevronUp /> : <ChevronDown />}
    </button>
  );
}
