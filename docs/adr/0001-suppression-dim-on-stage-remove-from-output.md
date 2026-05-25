# Suppression dims on Stage, removes from Preview and Export

When a user suppresses a Chart Decoration, the Stage dims it to 0.15 opacity rather than hiding it completely. Preview and all export formats (SVG, GIF, MOV) remove it entirely.

This is intentional. The Stage's dimming serves as a built-in "peek" affordance — the user can see what lies underneath a suppressed element without needing a separate inspect mode. Preview is the authoritative clean view that shows exactly what will be exported.

## Considered options

- **Full invisibility on Stage** — suppressed elements disappear immediately. Rejected because users need to verify their suppression decision (e.g. "does hiding the axis labels reveal the data I want?") without having to restore and re-suppress.
- **Two-mode system (peek vs. suppress)** — a separate toggle between "hide to inspect" and "hide for export." Rejected because the dim affordance makes this redundant; it adds UI complexity for no additional capability.
