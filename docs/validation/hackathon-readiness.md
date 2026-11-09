# Hackathon rules and repository evidence

Checked November 4, 2026 against the live
[participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details)
using Browser Control. This records repository evidence and verification limits;
it does not certify participant eligibility or guarantee a judging outcome.

| Requirement                                             | Repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address a problem statement and incorporate Meta models | Second Set addresses Build for Your World through engineering drawing review. [Model routes](../../src/lib/review/models.ts) include Muse Spark, Muse Wonder, Muse Spark Open through Baseten, and Muse Spark 1.3 Contributor through OpenCode Go. [SAM evidence](../experiments/adaptive-meta-review.md) documents segmentation.                                                                                                                                                                                         |
| Public repository                                       | GitHub reported `sc-frederick/moke-meta-hackathon`, now `Surfside-Software/second-set`, as public during this check.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Identify work built during the event                    | The application history starts October 27, 2026 at `0c5e8716c`. The [README](../../README.md#hackathon-provenance), [manifest](../../.project-kit/manifest.json), and [prompt provenance](../../backend/review/prompts/README.md) distinguish the new application from the project-kit starter, earlier Moke prompts, the pre-existing [2023 Florida code reference](../../backend/review/code-index/README.md), and dependencies. The code index tooling and additions were introduced in the October 30 implementation. |
| Respect code, data, and asset rights                    | The [MIT License](../../LICENSE), [design attribution](../design.md), and [Tabler license](../../src/lib/review/TABLER-LICENSE) document source attribution. The licensed Forge reference pack and local drawing fixture directory are excluded from tracked files. The [demo frames](../screenshots/README.md) retain the recorded footage and its labels. These checks do not independently establish ownership of every dependency or drawing.                                                                         |
| Three-minute demo showing the new work                  | The local narrated demo cut used for the screenshots is 151.541 seconds. It shows the review results, source evidence, saved decisions, and a labeled earlier revision review. [Frame provenance](../screenshots/README.md) identifies its source and timestamps.                                                                                                                                                                                                                                                         |
| Baseten hackathon model identifier                      | The configured route uses `meta-models/muse-spark-open-1026`, as the guide requires for the supplied Baseten key. [Recorded validation](baseten-rate-limits.md) documents use of that route.                                                                                                                                                                                                                                                                                                                              |

The open-weight bonus is judged separately and requires the infrastructure
partner to verify eligible model use. Supporting Muse Spark Open and recording
past runs are evidence, not a guarantee of bonus eligibility or current credit.

## Submission checks outside this repository

The guide gives a November 4, 2026 deadline of 9:00 PM Eastern Time, requires one
submission per team, limits teams to four participants, and requires everyone who
worked on the project to be listed. It also requires the submitted video link to
be accessible. This repository check does not verify the final platform
submission, roster, waiver acceptance, participant eligibility, or access to the
submitted video URL. The local demo duration does not establish that the same cut
is the one submitted.
