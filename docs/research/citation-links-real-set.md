# Citation links and a real drawing set

Checked 2026-11-02. Earlier citation proof used a two-sheet schematic and a request that named the
sections to cite. This note records what a real set showed instead, and how far the code links are
checked.

The set is a public 46-sheet Florida fire station renovation, 2023 Florida Building Code, posted
with its bid documents. It is not in the repository. Runs A and B used Muse Spark 1.3 on Meta. Run D
used Muse Spark 1.3 Contributor on OpenCode Go, with Meta only for SAM, which is how the app now runs.
Costs use each service's published rates: Meta $1.25 input, $0.15 cached and $4.25 output per million
tokens; Go $0.10, $0.002 and $0.20. Findings were not checked against the drawings.

## Results

| Run                                         | A                       | B                         | D                   |
| ------------------------------------------- | ----------------------- | ------------------------- | ------------------- |
| Chat route                                  | Meta                    | Meta                      | OpenCode Go         |
| Prompt and code                             | v8 with earlier fixes   | v9, before the last fixes | final               |
| Scope                                       | 46 sheets               | 46 sheets                 | 6 sheets            |
| Ended                                       | Cut off in coordination | Completed in 30 min       | Completed, 1 resume |
| Chat calls                                  | 698                     | 764                       | 195                 |
| Uncached / cached / output (M tokens)       | 7.11 / 38.18 / 0.73     | 10.19 / 41.41 / 0.77      | 2.05 / 10.52 / 0.16 |
| Cached share                                | 84.3%                   | 80.3%                     | 83.7%               |
| Cost at published rates                     | $17.71                  | $22.22                    | $0.26               |
| Findings                                    | 69                      | 71                        | 12                  |
| Citations stored                            | 3                       | 23                        | 9                   |
| Citations with a link                       | 3                       | 11                        | 9                   |
| Citation calls from sheet reviewers         | 0                       | 31 of 33                  | 9 of 9              |
| Code and permit findings with a citation    | 1 of 4                  | 6 of 7                    | 5 of 5              |
| Refused `record_finding` calls              | 66 of 156               | 66 of 164                 | 0                   |
| Refused `record_citation` calls             | 1                       | 10                        | 0                   |
| Findings storing an all-zeros prior comment | 69 of 69                | 71 of 71                  | 0                   |
| Sheet reviewers that failed                 | 3 of 46                 | 0 of 46                   | 0 of 6              |
| Checks left unreviewed                      | 0                       | 31, all on the cover      | 0                   |

A T3 upgrade restarted the host during run A. A review with an unresolved paid request does not
resume, by design, so it ended uncertain. Its numbers stop 25 minutes in, and three of its sheets
failed, so the cost difference between A and B is not a measure of the prompt. Run D reviewed six
sheets, chosen to include the cover that went wrong in run B. It paused at a 200-call cap during
coordination, then resumed and finished. These are single runs on one set, and D is too small to compare with A and B.

In run D, all 195 chat calls went to OpenCode Go and all 12 SAM calls went to Meta. The model still sent `""`
and `"null"` as a source; the host stored none of them.

## What the real set showed

**Reviews logged almost no citations.** On v8, 46 sheet reviewers recorded none. The review method
requires logging every code citation a sheet prints, but the parallel sheet role never mentioned
citations and told reviewers to work in few turns. Findings such as an outdated 2015 IFGC table
named a code with nothing behind it. Prompt v9 tells every role to log them. The link work in the
previous change only matters because of this.

**The model invents IDs when a schema requires one.** On Meta it sent the string `"null"` as
`priorCommentId` 42 to 46 times a run and left it out 18 or 19 times. Each refusal cost a paid turn.
It then sent an all-zeros UUID, which passed. Every finding in runs A and B stored that placeholder,
and the report printed `Prior comment 00000000-…` on each one, in reviews with no prior comments.
`sourceId` went the same way: of 33 citation calls in run B, 23 sent all zeros and 10 sent `"null"`
and were refused. The host now accepts these fields as optional and keeps only a source or comment this
review actually holds. The report applies the same rule to stored rows.

**Reviewers chose the same citation ID.** The model numbers them, `11111111-…` then `22222222-…`.
Run B had one ID chosen by two reviewers, and before this change the later citation would have
replaced the earlier one. A sheet reviewer's citation is now stored under an ID derived from its
sheet, and a test with two sheets and a coordinator shows all of them kept.

**A refused finding can end a sheet's findings.** On the cover sheet in run B the model sent
`calculationIds: ""`, then dropped three fields, then stopped using `record_finding` after two
tries, recorded a citation whose application reads "Test citation to check tool", and left 31 checks
unreviewed. The cover took 58 calls, against 20 in run A. Those list fields now default to empty.

**Twelve of run B's 23 citations had no link.** Six are outside the index on purpose: NFPA 13, NFPA
70, the Standard Building Code and ACI 530, three of them marked Incorrect. Three merged
two sections into one citation, so the prompt now asks for one section per citation. Two were
sections the index lacked, 601 and 714, now added. One was the test citation above.

## How far the links are checked

ICC's [terms of use](https://www.iccsafe.org/website-user-agreement/) exclude robots and data
gathering tools, so nothing here opened an ICC page.

- **The anchor rule.** The owner wrote 252 section anchors by hand. `code-index.test.ts` rebuilds 229
  of them, each from another anchor in the same chapter and subchapter, by swapping the section
  number, and gets the owner's link every time. The other 23 have no such neighbour. Chapter 1 splits
  its sections across subchapters, so a swap across one would be wrong; the only Chapter 1 links the
  host derives are 102 from 101, which share one.
- **The sections exist.** Every section the host links by this rule, 28 today, and every 8th Edition
  section in the additions was checked against UpCodes, some also against ICC's tables of contents
  as returned by a search index. One source for most of them, and printing differences would not
  show.
- **ICC's identifiers.** A search index shows the same identifier form on ICC's own section pages,
  such as `FLBC2023P2_Ch10_Sec1011`.

Six sections the owner's reference names are **Reserved** in the 8th Edition: Building 2118 and 2308,
Existing Building 608, and 102 in Mechanical, Plumbing and Fuel Gas. A citation to one now says so
and names what to check instead. High-velocity masonry is in 2119, 2121 and 2122, now indexed. The
owner's file stays unmodified, so its titles remain as written, including shorthand that is narrower
than the code's: 406 (Motor-Vehicle-Related Occupancies), 717 (Ducts and Air Transfer Openings), 807.4
(gravity loads only), C402.1 (General) and 1106 (Machinery Room, Special Requirements). The owner may
want to correct the reference itself.

## What stays unproven

- **Whether a browser scrolls to the anchor.** A person has to click one link to see this. A wrong
  anchor should open the top of the right chapter.
- **The owner's single-section links.** They follow the pattern, but their sections were not checked
  against a table of contents, so another Reserved section could be among them.
- **Finding quality.** More citations were logged; nobody checked that they are the right ones.
- **The cost of v9.** Run B cost more than run A, but A stopped early and lost three sheets.
- **How fast Go's allowance drains.** One probe reported `opencode.allowance` at twice its list cost.
  That fits a $240 pool with Muse Spark's published $120 Go Plus limit, but this is inferred from one
  request and receipts do not keep the field. The console shows the real figure.
- **A full set on OpenCode Go.** Only six sheets have run there. At run B's token counts a 46-sheet
  review would cost about $1.26 at Go's rates, but tokens vary from run to run.
- **OpenCode Go's other models.** MiMo-V2.6-Flash, GLM-5.3-Flash and GPT-6 Luna are offered and have
  not been tried on drawings.
