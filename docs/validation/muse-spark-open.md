# Muse Spark Open reviews

Muse Spark Open is one of Meta's open-weight models. Second Set runs it through Baseten as
`meta-models/muse-spark-open-1026`.

## Completed reviews

Two reviews of a supplied three-sheet fire-alarm set ran to completion in the cloud on
Muse Spark Open during desktop acceptance runs on October 29, 2026. The earlier run
covered the fire-alarm discipline. The later run recorded all 132 coverage rows, some of
which can be marked not applicable: 11 disciplines, 4 passes and 3 sheets.

| Run                       | Calls | Passes recorded | Findings | Elapsed  | Notes                                                                                                                           |
| ------------------------- | ----: | --------------: | -------: | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Earlier, fire-alarm scope |    30 |         12 / 12 |        7 | Not kept | Recognized the supplied 8.90 Ah battery requirement, NAC tables and matrix.                                                     |
| Later, every discipline   |    36 |       132 / 132 |       11 | 13:04    | The app restarted while the job ran. It uploaded 311.7 MiB (191 files) and synced back 340.5 MiB, with no sandbox left running. |

## Limits

These reviews cover a small set. A 29-sheet Initial Review on Spark Open paused at its
budget instead of finishing; see
[Baseten rate limits and caching](baseten-rate-limits.md). The raw receipts stayed
local. These runs predate later prompt versions and are not a benchmark for unseen
drawings.
