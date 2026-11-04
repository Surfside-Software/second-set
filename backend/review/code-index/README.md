# Florida code index

Moke's `search_code` tool searches this index for the code section, statute or
rule behind a review check. Each entry gives the section number and title, a
one-line plan review note and a link. The index contains no copied code text.

`assets/FBC_2023_plan_review_reference.md` is the owner's plan review reference
for the 2023 Florida Building Code, 8th Edition, last modified 2026-07-09. It
predates the hackathon and is vendored unmodified; the formatter ignores it.
`assets/florida-code-additions.md` was written for this entry on 2026-10-30. It
adds Florida Statutes, Florida Administrative Code rules, the Florida Fire
Prevention Code adoption, the 9th Edition (2026) volumes and the 8th Edition
supplements. `provenance.json` records both files' origin and SHA-256.

## Reading the governing text

Each entry's `access` says how a reviewer reads the text it points to.

- `open_in_browser`: ICC Digital Codes blocks automated clients, and its
  [website user agreement](https://iccsafe.org/website-user-agreement/) does
  not license robots or data extraction tools. Florida rules publish their text
  as Word documents. Moke records these citations as unverified with the
  section and link, and the engineer opens the link to confirm them.
- `read_source`: Florida Statutes pages on leg.state.fl.us return their
  official text, so `read_source` can retrieve them and a citation can be
  verified against the quote.

A citation that names no `search_code` result still gets its link when its
document, edition and section identify one index entry. A subsection falls back
to its deepest indexed parent section, including sections explicitly listed in a multi-section title. Same-chapter ICC anchors are retargeted to the cited section; cross-chapter links are never guessed. Explicit search result IDs use the same resolution. Another edition never matches. The workbench
shows an unverified citation with a link as Indexed, because its section is known
and only its wording is unconfirmed.

Some sections the owner's reference names are Reserved in the 8th Edition, with no
requirement behind them: Building 2118 and 2308, Existing Building 608, and 102 in
Mechanical, Plumbing and Fuel Gas. The owner's file stays unmodified, so each has its
own entry in the additions marked `(Reserved)`, with a note saying what to check
instead. That entry describes the link whichever way a citation reaches it.

### How far the links are checked

Nobody has opened an ICC link from Moke by automation, because the user agreement
excludes it. A test rebuilds each of the owner's hand-written anchors by swapping the
section number in another anchor from the same chapter, the same rule the host uses
for a section listed in a combined title. Every section the host links this way, and
the sections in the additions, was checked to exist with its title and Reserved
status, against ICC's Eighth Edition tables of contents as returned by a search index
and against UpCodes. The check is recorded in
[the research note](../../../docs/validation/citation-links-real-set.md). An owner's
single-section link was not checked this way, and whether a browser scrolls to an
anchor can only be seen by opening one. A wrong anchor opens the top of the right
chapter.

`read_source` also extracts embedded text from PDF sources, such as county
amendments and agency checklists, through the PDF worker. A `#page=N` fragment
starts at that page. Scanned PDFs without embedded text stay unavailable.

## Changing the index

Both files use the same format: `## Document - Edition`, `### Topic`, then one
line per entry:

```text
- **1004 Occupant Load** - What the reviewer checks. [Link](https://...)
```

Add entries to the additions file, or replace the reference with a newer copy
of the owner's file. Then update the SHA-256 values in `provenance.json` and
change its `version`. The version is part of the cloud worker identity, so a
changed index needs a rebuilt cloud worker image. `tests/smoke/code-index.test.ts`
checks the hashes, parsing, link access and search ranking.
