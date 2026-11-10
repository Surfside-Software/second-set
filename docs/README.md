# Project documentation

Start with [the Second Set README](../README.md) for the product, workflow, and screenshots.

## Setup and development

- [Development and testing](development.md): commands, smoke/Electron suites, demo frames, and offline fixture captures.
- [Inference setup](inference.md): provider keys, canonical routes, and manual API checks.
- [Cloud reviews](cloud-reviews.md): Push to cloud, operator setup, sandbox lifetimes, and recovery limits.
- [Model reference](models.md): the Meta catalog and the Baseten hackathon endpoint.
- [Desktop builds and releases](deployment.md): packaging, CI, credentials, and runtime boundaries.
- [Data and recovery](data.md): SQLite migrations, consistent backups, complete packages, and restore behavior.
- [Demonstration fixture](fixtures/hero-case.md): supported issue, correction, unchanged control, and revision recheck.
- [Workbench design](design.md): the Forge design system, its desktop adaptations, and asset licenses.

## Architecture

- [Product scope](../PRODUCT.md): what the workbench does and who it serves.
- [Review runtime](review-runtime.md): local ownership, Pi Durable, hosted inference, and cloud review scope.
- [Pi execution for count checks](architecture/pi-runtime.md): journals, request admission, controls, and crash recovery.
- [Review packages](architecture/review-packages.md): complete export/restore and interrupted replacement recovery.
- [SAM integration](architecture/sam-integration.md): image geometry, intent ledger, source fences, and proposals.
- [Review prompt provenance](../backend/review/prompts/README.md): where the review instructions come from and how they version.
- [Project choices and dependency provenance](../.project-kit/manifest.json)

## Validation records

The [hackathon rules and repository evidence](validation/hackathon-readiness.md)
records the participant guide check and what this repository can verify.

These record specific live runs on the dates they state. They are not benchmarks
for unseen drawings. Raw request and response receipts stayed in the ignored
`.local/` directory of the machine that ran them; the `*-result.json` files here
are the committed records.

- [Core validation](validation/core-validation.md): recorded Meta/SAM receipts, recovery checks, and limits.
- [Cloud validation](validation/cloud-validation.md): a live cloud review, its automatic return, and its recovery.
- [Fast initial review](validation/fast-initial-review.md): measured time and cost for the Initial Review button.
- [Parallel sheet review](validation/parallel-sheet-review.md): live results for one reviewer per sheet on Muse Spark 1.3.
- [Citation links on a real set](validation/citation-links-real-set.md): what a public 46-sheet set showed, and how far code links are checked.
- [Muse Spark Open reviews](validation/muse-spark-open.md): completed reviews on one of Meta's open-weight models, and their limits.
- [Baseten rate limits and caching](validation/baseten-rate-limits.md): measured key limits, 429 shape, session affinity and the request pacer.

## Drawing experiments

These studies record bounded development experiments. Captured model results are
not a benchmark for unseen drawings. Reproducing live requests requires provider
access and the separately supplied drawing pack.

- [SAM drawing experiment](experiments/segmentation-test.md): crop rendering, prompts, overlays, and coordinates.
- [Plumbing coordination](experiments/plumbing-segmentation.md): count experiments, corrections, and the offline worksheet.
- [SAM beyond plumbing](experiments/sam-drawing-expansion.md): electrical, lighting, HVAC, doors, and observed limits.
- [Adaptive Meta review](experiments/adaptive-meta-review.md): independent inventories, targeted zooms, and fresh SAM guidance.
- [Additional discipline sets](experiments/sam-expanded-sets.md): electrical, fire alarm, structural, and civil probes.
