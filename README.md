# Second Set

Second Set is a desktop app that gives a drawing set a second review before
submittal. Import the PDFs and ask for a QA pass or a discipline review. Second
Set reads the sheets, lists what it finds with the evidence behind each finding,
and exports an HTML report you can share.

![Second Set's five-sheet review with 19 findings, coverage gaps, and findings navigation](docs/screenshots/workbench.png)

## What it checks

Each sheet gets four passes: document completeness, code and agency
requirements, coordination between disciplines, and follow-up on prior review
comments. Code findings cite the Florida code section, statute or rule they rely
on.

A whole-set review covers general, building design, civil, structural,
mechanical, electrical, plumbing, fire alarm, fire sprinkler, fire protection and
life safety. You can also ask for one discipline.

With a Meta key, SAM 3.1 locates drawn devices and fixtures so they can be
counted, and zooms into the area each finding is about.

## Running a review

1. **Create a project and import the PDFs.** You don't need to confirm sheets
   or set up count checks first.
2. **Ask for the review.** Click **Initial Review** for a full first-submittal
   review, or type a request such as "Run a quick QA pass on this drawing set" or
   "Review the electrical design and supporting calculations."
3. **Work through the findings.** Each finding gives the sheet and location, the
   evidence, the correction needed, and its code sources or calculations. Open a
   finding to see the source drawing beside it. Mark it valid, a false alarm,
   not applicable or a duplicate, and give a reason. Follow-up questions and
   reviews in the same conversation take that decision into account.
4. **Export the report.** The report is a single HTML file with the findings,
   evidence images, coverage, code citations, calculations and prior-comment
   tracking. Use its Completed checkboxes to track corrections.

![A saved false-alarm decision beside the source drawing and SAM highlight](docs/screenshots/correction.png)

When revised sheets arrive, import them and ask for a recheck. Earlier findings
keep their issue IDs, and a finding closes only after the review inspects the
revised sheet.

To apply your firm's own checklist to new reviews, add it in Review settings.

## Limits

- Findings are model review results. They are not professional approval, and a
  finished review does not replace your own check.
- The report lists any sheets that were not reviewed. Code text that could not be
  opened, unknown code editions and missing project information show as
  **Needs input**.
- A citation marked **Indexed** has a known section and link. Open the link to
  confirm the wording.
- SAM highlights show where a symbol appears on the sheet. They do not measure
  dimensions.

## Where your drawings go

Projects are stored on your computer. A review sends drawing images to the model
provider you choose: Meta, Baseten, OpenCode Go, or a custom endpoint you add.

The model offered through OpenCode Go, Muse Spark 1.3 Contributor, trains Meta's
models on your drawings. Don't connect OpenCode Go for drawings that can't be
shared.

**Push to cloud** uploads your whole Second Set workspace, including every
project and its original PDFs, to a cloud sandbox. The review runs there, and the
results come back to your computer. It needs a one-time setup; see
[cloud reviews](docs/cloud-reviews.md).

## Install

Download the installer for Windows, macOS (Apple silicon) or Linux from
[GitHub Releases](https://github.com/Surfside-Software/second-set/releases/latest).
The installers are unsigned. If macOS blocks the first launch, open System
Settings › Privacy & Security and click Open Anyway. On Linux, make the AppImage
executable or install the `.deb`.

Reviews need a key from a model provider; [inference setup](docs/inference.md)
explains how to add one. Without a key you can still import drawings and run
manual count checks.

If you used version 0.2.2, read the [upgrade notes](docs/upgrading.md) first.

## For developers

Install the Bun version pinned in [.bun-version](.bun-version), then run:

```sh
bun install --frozen-lockfile
bun run dev      # run the app from source
bun run verify   # checks, tests, builds, and Electron end-to-end tests
```

For model reviews from source, copy [.env.example](.env.example) to `.env` and
add a provider key. The app is an Electron shell around a SvelteKit interface and
a bundled Bun backend, which owns the SQLite database, PDF processing and review
execution. [Development and testing](docs/development.md) covers the commands and
test suites, and the [documentation index](docs/README.md) lists the
architecture, release and validation records.

## License

Second Set is released under the [MIT License](LICENSE). Vendored code and
third-party assets keep their own licenses. The styles in `src/lib/forge.css` are
adapted from Uiverse Design's Forge and remain under its license; see
[the design notes](docs/design.md).
