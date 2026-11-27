import { expect, test } from "bun:test";
import {
  parseCodeReferences,
  resolveCodeReference,
} from "../../backend/review/code-index/code-index.ts";

const rules = (host: string) =>
  parseCodeReferences(
    [
      "## Florida Administrative Code - Current rules",
      "### Engineer seals and signatures (Chapter 61G15-23)",
      `- **61G15-23.002 Seals Acceptable to the Board** - Check the seal. [Link](https://${host}/gateway/ruleNo.asp?id=61G15-23.002)`,
    ].join("\n"),
  );

test("a rule link on a flrules.org subdomain resolves and opens like the bare host", () => {
  const citation = {
    document: "Florida Administrative Code",
    edition: "Current rules",
    section: "61G15-23.002",
  };

  for (const host of ["flrules.org", "www.flrules.org"]) {
    const index = rules(host);
    expect(index[0]?.access, host).toBe("open_in_browser");
    expect(resolveCodeReference(index, citation)?.url, host).toBe(
      `https://${host}/gateway/ruleNo.asp?id=61G15-23.002`,
    );
  }

  // A different domain that merely ends with the same letters is not the rules site.
  expect(rules("notflrules.org")[0]?.access).toBe("read_source");
});
