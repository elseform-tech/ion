// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Message.js";

afterEach(cleanup);

const fence = (lines: number, info = "ts src/cart/money.ts") => {
  const body = Array.from({ length: lines }, (_, i) => "line " + String(i + 1)).join("\n");
  return "```" + info + "\n" + body + "\n```";
};

// Plan 08: code fences as the lab's .cblock.
describe("code blocks", () => {
  it("shows the language and the file name the fence gives, with Copy", () => {
    const { container } = render(<Markdown text={fence(3)} />);
    expect(container.querySelector(".cblock .ch .lang")?.textContent).toBe("ts");
    expect(container.querySelector(".cblock .ch")?.textContent).toContain("src/cart/money.ts");
    expect(container.querySelector(".cblock .ch button[title='Copy']")).not.toBeNull();
    expect(container.querySelector(".cblock .more")).toBeNull();
  });

  it("folds a block over 12 lines: shows 12 and 'Show 8 more lines', then all of it", () => {
    const { container } = render(<Markdown text={fence(20)} />);
    expect(container.querySelector(".cblock pre")?.textContent?.split("\n")).toHaveLength(12);
    const more = container.querySelector(".cblock .more")!;
    expect(more.textContent).toBe("Show 8 more lines");
    fireEvent.click(more);
    expect(container.querySelector(".cblock pre")?.textContent?.split("\n")).toHaveLength(20);
    expect(container.querySelector(".cblock .more")?.textContent).toBe("Show less");
  });

  // Review Focus 2: code is text.
  it("shows HTML inside a fence as text", () => {
    const { container } = render(
      <Markdown text={fence(1, "html").replace("line 1", '<img src=x onerror="alert(1)">')} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".cblock pre")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });
});
