// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openSettings, useSettingsAt } from "./goto.js";
import { Settings } from "./settings/Settings.js";
import { openPage, settingsClient } from "./settings/testing.js";

afterEach(cleanup);

/** The window's Settings as App draws it: keyed by where a link opened it. */
function Host() {
  const [at, key] = useSettingsAt("settings", () => {});
  return <Settings key={key} client={settingsClient()} onOpenIon={() => {}} at={at} />;
}

const onPage = () =>
  within(screen.getByRole("navigation", { name: "Settings" }))
    .getAllByRole("button")
    .find((b) => b.className.includes("on"))?.textContent;

// Review of Plan 21 Task 4 (2026-11-28): Search → Notifications, then Agents in the sidebar, then Search → Notifications again did
// nothing: the same place gave Settings the same key, and it reads where to open only when it mounts.
describe("opening Settings at a page", () => {
  it("opens the page each time you ask, even the same one twice", async () => {
    render(<Host />);
    act(() => openSettings("notifications"));
    await screen.findByRole("navigation", { name: "Settings" });
    expect(onPage()).toBe("Notifications");
    await openPage("Agents");
    expect(onPage()).toBe("Agents");
    act(() => openSettings("notifications"));
    expect(onPage()).toBe("Notifications");
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onPage()).toBe("General");
  });
});
