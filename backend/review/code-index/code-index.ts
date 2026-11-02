import { Schema, Struct } from "effect";
import reference from "./assets/FBC_2023_plan_review_reference.md" with { type: "text" };
import additions from "./assets/florida-code-additions.md" with { type: "text" };
import provenance from "./provenance.json";

/** Index version recorded with reviews; change it whenever an asset or the parser changes. */
export const codeIndexVersion = provenance.version;

/**
 * How a reviewer can read the governing text. ICC Digital Codes blocks automated clients and its
 * user agreement excludes robots, and Florida rules publish their text as Word documents, so those
 * links are for the engineer to open. Statute pages can be retrieved and verified with read_source.
 */
export const CodeTextAccess = Schema.Literals(["read_source", "open_in_browser"]);

/** One pointer from a review check to a Florida code section, statute or rule; never code text. */
export class CodeReference extends Schema.Class<CodeReference>("CodeReference")({
  /** Stable identity: the link without its scheme, which is unique across both assets. */
  id: Schema.NonEmptyString,
  /** Code volume or body of law, such as "FBC Building (Commercial)" or "Florida Statutes". */
  document: Schema.NonEmptyString,
  edition: Schema.NonEmptyString,
  topic: Schema.NonEmptyString,
  /** Section, statute or rule numbers named in the title, such as "1005", "R302" or "553.79". */
  sections: Schema.Array(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  /** What a plan reviewer checks against this section. */
  check: Schema.NonEmptyString,
  url: Schema.String.check(Schema.isStartingWith("https://")),
  access: CodeTextAccess,
}) {}

const entryPattern =
  /^- \*\*(.+?)\*\* - (.+?)\s*((?:\[[^\]]*Link\]\(https:\/\/[^)\s]+\)\s*\/?\s*)+)$/;

const linkPattern = /\[([^\]]*)Link\]\((https:\/\/[^)\s]+)\)/g;

// FBC sections (1005, 1609.3, R302, N1101, C402), statutes (553.79) and rules (61G15-23.002).
const sectionPattern =
  /\b(?:\d{2}[A-Z]\d{0,2}-\d{1,3}(?:\.\d{3,4})?|[A-Z]{0,2}\d{3,4}(?:\.\d+)*)\b/g;

const accessFor = (url: URL): typeof CodeTextAccess.Type =>
  url.hostname.endsWith("iccsafe.org") || url.hostname.endsWith("flrules.org")
    ? "open_in_browser"
    : "read_source";

/** Parse one reference file: `## Document - Edition`, `### Topic`, then bold-titled link entries. */
export function parseCodeReferences(markdown: string): ReadonlyArray<CodeReference> {
  const entries: Array<CodeReference> = [];
  let document: string | null = null;
  let edition: string | null = null;
  let topic: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{2,4}) (.+)$/.exec(line);

    if (heading) {
      const [, level, text = ""] = heading;

      if (level === "##") {
        const split = text.lastIndexOf(" - ");
        document = split < 0 ? null : text.slice(0, split).trim();
        edition = split < 0 ? null : text.slice(split + 3).trim();
        topic = null;
      } else topic = level === "###" ? text.trim() : null;

      continue;
    }

    const entry = entryPattern.exec(line);

    if (!entry || document === null || edition === null || topic === null) continue;
    const [, title = "", check = "", links = ""] = entry;
    const targets = [...links.matchAll(linkPattern)];

    for (const [, label = "", href = ""] of targets) {
      const url = new URL(href);
      const named = targets.length > 1 && label.trim() ? `${title} (${label.trim()})` : title;

      entries.push(
        new CodeReference({
          id: `${url.host}${url.pathname}${url.search}${url.hash}`,
          document,
          edition,
          topic,
          sections: [...new Set(title.match(sectionPattern) ?? [])],
          title: named,
          check,
          url: url.href,
          access: accessFor(url),
        }),
      );
    }
  }

  return entries;
}

/** A section listed under two topics keeps both entries; later ones get a `~2`, `~3` suffix. */
function withUniqueIds(entries: ReadonlyArray<CodeReference>): ReadonlyArray<CodeReference> {
  const counts = new Map<string, number>();

  return entries.map((entry) => {
    const count = (counts.get(entry.id) ?? 0) + 1;
    counts.set(entry.id, count);

    return count === 1
      ? entry
      : new CodeReference(Struct.assign(entry, { id: `${entry.id}~${count}` }));
  });
}

/** The bundled Florida index: the plan review reference followed by the additions. */
export const floridaCodeIndex: ReadonlyArray<CodeReference> = withUniqueIds([
  ...parseCodeReferences(reference),
  ...parseCodeReferences(additions),
]);

/** Look up an entry by the id search_code returned. */
export const codeReference = (id: string) => floridaCodeIndex.find((entry) => entry.id === id);

const stopWords = new Set(
  "a an and are as at be by for from in is of on or the to with what which where when how does".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word.length > 1 && !stopWords.has(word));

/** A query section matches itself, its subsections, and the parent section it belongs to. */
const sectionScore = (query: string, section: string) => {
  const left = query.toLowerCase();
  const right = section.toLowerCase();

  if (left === right) return 10;

  return left.startsWith(`${right}.`) || right.startsWith(`${left}.`) ? 6 : 0;
};

/**
 * A code volume's name in comparable form: "Florida Building Code, Building (Commercial) 2023" and
 * "FBC Building" are one volume, while "FBC Existing Building" stays a different one.
 */
const volumeName = (document: string) =>
  document
    .toLowerCase()
    .replace(/florida building code/g, "fbc")
    .replace(/\(commercial\)/g, " ")
    .replace(/\b(?:(?:19|20)\d{2}|\d+(?:st|nd|rd|th)|edition)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Sections explicitly starting slash-separated title segments or a leading section range. */
export function listedCodeSections(entry: CodeReference): ReadonlyArray<string> {
  const leading = /^([A-Z]{0,2}\d{3,4}(?:\.\d+)*)(?=\s|\/|$)/;

  const range = /^([A-Z]{0,2}\d{3,4}(?:\.\d+)*)-([A-Z]{0,2}\d{3,4}(?:\.\d+)*)(?=\s|$)/.exec(
    entry.title,
  );

  const sections = range
    ? [range[1] ?? "", range[2] ?? ""]
    : entry.title.split("/").flatMap((part) => {
        const section = leading.exec(part.trim())?.[1];

        return section === undefined ? [] : [section];
      });

  return sections.length > 1 ? sections : [];
}

const sectionChapter = (section: string) => {
  const digits = /^[A-Z]*(\d{3,4})/i.exec(section)?.[1];

  return digits === undefined ? undefined : Number(digits.slice(0, -2));
};

const referenceForSection = (entry: CodeReference, section: string) => {
  if (linkedSection(entry) === section.toLowerCase()) return entry;

  if (!listedCodeSections(entry).some((listed) => listed.toLowerCase() === section.toLowerCase()))
    return undefined;
  const url = new URL(entry.url);
  const chapter = /_Ch(\d+)(?:_SubCh\d+)?_Sec[A-Z]{0,2}\d+(?:\.\d+)*$/i.exec(url.hash)?.[1];

  if (
    url.hostname !== "codes.iccsafe.org" ||
    chapter === undefined ||
    Number(chapter) !== sectionChapter(section)
  )
    return undefined;
  url.hash = url.hash.replace(/_Sec[A-Z]{0,2}\d+(?:\.\d+)*$/i, `_Sec${section.toUpperCase()}`);

  return new CodeReference(Struct.assign(entry, { url: url.href }));
};

/**
 * The entry that describes exactly this link. A combined entry such as "2304 Wood / 2308 Light-Frame"
 * names several sections, and the additions correct what one of them actually is, such as Reserved.
 */
const describedBy = (index: ReadonlyArray<CodeReference>, entry: CodeReference) =>
  index.find((candidate) => candidate.url === entry.url && candidate.sections.length === 1) ??
  entry;

/** Preserve an explicit selection, retargeting only one listed section or its subsection. */
export function selectedCodeReference(entry: CodeReference, section: string): CodeReference {
  const sections = [...new Set(section.toUpperCase().match(sectionPattern) ?? [])];
  const [number] = sections;

  if (sections.length !== 1 || number === undefined) return entry;

  const listed = listedCodeSections(entry).filter(
    (value) => number === value.toUpperCase() || number.startsWith(`${value.toUpperCase()}.`),
  );

  const [target] = listed;

  if (listed.length !== 1 || target === undefined) return entry;
  const retargeted = referenceForSection(entry, target);

  // A section listed from another chapter has no derivable anchor, but may have its own entry.
  return retargeted === undefined
    ? (resolveCodeReference(floridaCodeIndex, {
        document: entry.document,
        edition: entry.edition,
        section: target,
      }) ?? entry)
    : describedBy(floridaCodeIndex, retargeted);
}

const linkedSection = (entry: CodeReference) => {
  const url = new URL(entry.url);

  if (url.hostname === "codes.iccsafe.org")
    return /_Sec([A-Z]{0,2}\d+(?:\.\d+)*)$/i.exec(url.hash)?.[1]?.toLowerCase();

  if (url.hostname === "flrules.org") return url.searchParams.get("id")?.toLowerCase();

  return /\/Sections\/0*(\d+(?:\.\d+)*)\.html$/i
    .exec(url.searchParams.get("URL") ?? url.pathname)?.[1]
    ?.toLowerCase();
};

/**
 * The index entry behind a citation that names no search result, or undefined when the document,
 * edition and section do not identify exactly one link. A subsection falls back to its indexed
 * parent section, and a citation to another edition never links to this one.
 */
export function resolveCodeReference(
  index: ReadonlyArray<CodeReference>,
  citation: { readonly document: string; readonly edition: string; readonly section: string },
): CodeReference | undefined {
  const sections = [...new Set(citation.section.toUpperCase().match(sectionPattern) ?? [])];
  const [sectionNumber] = sections;

  if (sectionNumber === undefined) return undefined;
  const section = sectionNumber.toLowerCase();
  const volume = volumeName(citation.document);
  const edition = `${citation.edition} ${citation.document}`.toLowerCase();
  const years = edition.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const editions = edition.match(/\b\d+(?:st|nd|rd|th)\b/g) ?? [];

  const candidates = index.filter(
    (entry) =>
      volumeName(entry.document) === volume &&
      years.every((year) => entry.edition.includes(year)) &&
      editions.every((edition) => entry.edition.toLowerCase().includes(edition)),
  );

  const exact = candidates.flatMap((entry) => {
    if (sections.length === 1) {
      const resolved = referenceForSection(entry, sectionNumber);

      return resolved === undefined ? [] : [resolved];
    }

    const listed = listedCodeSections(entry);

    return listed.length === sections.length &&
      listed.every((value) => sections.includes(value.toUpperCase()))
      ? [entry]
      : [];
  });

  const parents = candidates.flatMap((entry) =>
    [...new Set([linkedSection(entry), ...listedCodeSections(entry)])].flatMap((parent) => {
      if (
        sections.length !== 1 ||
        parent === undefined ||
        !section.startsWith(`${parent.toLowerCase()}.`)
      )
        return [];
      const resolved = referenceForSection(entry, parent);

      return resolved === undefined ? [] : [{ entry: resolved, length: parent.length }];
    }),
  );

  const deepest = Math.max(0, ...parents.map((parent) => parent.length));

  const matches =
    exact.length > 0
      ? exact
      : parents.flatMap((parent) => (parent.length === deepest ? [parent.entry] : []));

  const [first] = matches;

  // One section listed under two topics is still one link; different links stay ambiguous.
  return first !== undefined && matches.every((entry) => entry.url === first.url)
    ? describedBy(index, first)
    : undefined;
}

/** Rank index entries for a reviewer's query by section numbers, then title, topic and check words. */
export function searchCodeReferences(
  index: ReadonlyArray<CodeReference>,
  query: string,
  limit: number,
): ReadonlyArray<CodeReference> {
  const terms = words(query);

  if (terms.length === 0) return [];

  return index
    .flatMap((entry) => {
      const fields = [
        { words: new Set(words(entry.title)), weight: 3 },
        { words: new Set(words(entry.topic)), weight: 2 },
        { words: new Set(words(`${entry.document} ${entry.edition}`)), weight: 1.5 },
        { words: new Set(words(entry.check)), weight: 1 },
      ];

      let matched = 0;
      let score = 0;

      for (const term of terms) {
        const section = Math.max(0, ...entry.sections.map((value) => sectionScore(term, value)));

        const field = Math.max(
          0,
          ...fields.map((item) => (item.words.has(term) ? item.weight : 0)),
        );

        if (section + field > 0) matched++;
        score += section + field;
      }

      // Entries matching every query term rank above those matching one term strongly.
      const total = score + (matched === terms.length ? terms.length * 2 : 0);

      return total > 0 ? [{ entry, score: total }] : [];
    })
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => result.entry);
}
