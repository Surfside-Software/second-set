# Muse Spark Open reviews

Muse Spark Open is Meta's open-weight model. Moke runs it through Baseten as
`meta-models/muse-spark-open-1026`.

## Completed reviews

Two fire-alarm discipline reviews of a supplied three-sheet set ran to completion
in the cloud on Muse Spark Open during desktop acceptance runs on October 29, 2026.

| Run     | Calls | Passes recorded | Findings | Elapsed  | Notes                                                                                                                           |
| ------- | ----: | --------------: | -------: | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Earlier |    30 |         12 / 12 |        7 | Not kept | Recognized the supplied 8.90 Ah battery requirement, NAC tables and matrix.                                                     |
| Later   |    36 |       132 / 132 |       11 | 13:04    | The app restarted while the job ran. It uploaded 311.7 MiB (191 files) and synced back 340.5 MiB, with no sandbox left running. |

## Limits

These are small discipline reviews. A 29-sheet Initial Review on Spark Open paused at
its budget instead of finishing; see
[Baseten rate limits and caching](baseten-rate-limits.md). The raw receipts stayed
local. These runs predate later prompt versions and are not a benchmark for unseen
drawings.
