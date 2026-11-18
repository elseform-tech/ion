# @ion/design-system

ion's look, from `docs/design/ion-design-lab.html`: the dark tokens as CSS variables (`@ion/design-system/tokens.css`:
surfaces, text, accent, status colours, radii, Sora, Inter and JetBrains Mono), `Button` (`primary` or `ghost`),
`Spinner`, and the Lucide icons the app uses, re-exported by name. Status colours only ever mean status.

- `lab.css` is the lab's app-window CSS, copied verbatim by `scripts/copy-lab.mjs` from fixed line ranges (run it
  after changing the lab; a test checks every rule is still the lab's). The app's own few additions sit at the end,
  after `/* app: not in the lab */`.
- `Avatar` draws a harness's avatar as the lab does (`bots.ts`: shape and colour per harness, eyes that blink and
  look around; an unknown harness is a plain orb); it holds still with reduced motion.
