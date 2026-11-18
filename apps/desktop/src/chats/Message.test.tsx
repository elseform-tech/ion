// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Message.js";

afterEach(cleanup);

// Review Focus 3: an agent's text never runs as HTML, and its links never run script or navigate the app.
describe("Markdown", () => {
  it("shows HTML as text and makes javascript: links inert", () => {
    const { container } = render(
      <Markdown text={'Hi <img src=x onerror="alert(1)"> and [x](javascript:alert(1)) and **bold**'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    const a = container.querySelector("a");
    expect(a?.getAttribute("href") ?? "").not.toMatch(/javascript/i);
  });

  it("renders code and tables", () => {
    const { container } = render(<Markdown text={"`x` and\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector("code")?.textContent).toBe("x");
    expect(container.querySelector("table")).not.toBeNull();
  });
});
