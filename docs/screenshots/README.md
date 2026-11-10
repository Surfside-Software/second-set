# Screenshot sources

The README screenshots are captures of the application at 1600 × 900 and a 1.6 device
scale, which gives 2560 × 1440 frames. They were taken on 2026-11-09 from a copy of a
real review workspace, opened in a private display with providers configured but never
called. The capture adds no cropping or content edits. One empty project in that copy
was renamed before capture.

| Image                            | Content                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [workbench.png](workbench.png)   | Five-sheet civil review with 19 findings, coverage gaps, and findings navigation                                                       |
| [correction.png](correction.png) | Source evidence with a SAM highlight and a saved false-alarm decision explaining that identifying information was removed for the demo |

## Capture the screenshots

`tests/e2e/readme-screenshots.spec.ts` opens the "Single Family Lot Drainage and Grading
Set" review and writes both frames to `test-results/`. It edits the workspace it is given,
so point it at a disposable copy, never at a live data folder. It is skipped unless
`SECOND_SET_SCREENSHOT_WORKSPACE` is set:

```sh
cp -a /path/to/workspace-snapshot /tmp/second-set-screenshots
SECOND_SET_SCREENSHOT_WORKSPACE=/tmp/second-set-screenshots \
  bun scripts/isolated-desktop.ts tests/e2e/readme-screenshots.spec.ts --project=desktop
```

The snapshot needs `app.sqlite`, `artifacts/` and `execution-journals/`. Take the database
with SQLite's backup API so a running application cannot leave it inconsistent.

`bun run test:screenshots` captures the offline synthetic fixture into `test-results/`. It
does not replace these frames.
