import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DAILY_FILE_DATA = "assets/data/daily-files.js";
const OUTFILE = "assets/data/seen-documents.js";
const CACHE_DIR = ".cache/catalog-records";
const RANGE_START = "1991-02-28";
const RANGE_END = "1993-01-20";
const CONCURRENCY = Number(process.env.CATALOG_CONCURRENCY || 5);
const LIMIT = Number(process.env.SEEN_LIMIT || 0);

function decodeDailyFiles(source) {
  const prefix = "window.HANG_IN_DAILY_FILES = ";
  if (!source.startsWith(prefix)) {
    throw new Error(`${DAILY_FILE_DATA} does not contain the expected global assignment.`);
  }
  return JSON.parse(source.slice(prefix.length).replace(/;\s*$/, ""));
}

function catalogUrl(naId) {
  const params = new URLSearchParams();
  params.set("naId", naId);
  params.set("includeExtractedText", "true");
  params.set(
    "sourceIncludes",
    [
      "naId",
      "title",
      "digitalObjects.objectUrl",
      "digitalObjects.extractedText",
      "digitalObjects.objectType",
    ].join(",")
  );
  return `https://catalog.archives.gov/proxy/records/search?${params.toString()}`;
}

async function fetchCatalogRecord(folder) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${folder.naId}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8"));
  }

  const response = await fetch(catalogUrl(folder.naId), {
    headers: {
      "User-Agent":
        "Hang-In document-level research index builder (metadata and OCR only)",
    },
  });
  if (!response.ok) {
    throw new Error(`Catalog request failed for ${folder.naId}: ${response.status}`);
  }
  const json = await response.json();
  await writeFile(cachePath, JSON.stringify(json));
  return json;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanLine(line) {
  return normalizeWhitespace(line)
    .replace(/\[(\d{2})\]/g, "$1")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function isHeaderLine(line) {
  return /^(collection|record group|office|series|subseries|whorm cat|file location|pinksheet number|oa\/id number|date closed|foia\/sys case|foia\/sys case #|processed by|re-review case #?:?|re-review case|p-2\/p-5 review case #?:?|stack|row|section|shelf|position|withdrawal\/redaction sheet|george bush library|doc\. no\. \/ type|document no\.|subject\/title|subject\/title of document|date|restriction|classification|class\.|and type|page \d+ of \d+|restriction codes|presidential records act|freedom of information act|appeal case|appeal disposition|disposition date|ar case|mr case|ar disposition|mr disposition|ar disposition date|mr disposition date)$/i.test(
    line
  );
}

function isDateLine(line) {
  return /^(n\.?\s?d\.?|nd|ne|no date|\d{1,2}\/\d{1,2}(?:\/(?:\d{2,4}|\[\d{2}\]))?|\d{1,2}\/\d{2}|\d{2}\/\d{2}\]?)$/i.test(
    line
  );
}

function isRestrictionLine(line) {
  return /^(\(?b\)?\(?\d\)?|p-\d|\(b\)|\(\w\)|&|\/|and his advisors|personal privacy|agency|\(b\)\(\d\)|\(b\)\([^)]+\)|\(\s*b\s*\)\s*\(\s*\d\s*\))/i.test(
    line
  );
}

function isClassificationLine(line) {
  return /^(ts|s|c|u|secret|confidential|top secret|unclassified)$/i.test(line);
}

function normalizeDate(value, folderDate) {
  const clean = value.replace(/\[|\]/g, "").trim();
  if (/^(n\.?\s?d\.?|nd|ne|no date)$/i.test(clean)) return "";
  const match = clean.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : Number(folderDate.slice(0, 4));
  if (year < 100) year += year > 80 ? 1900 : 2000;
  if (year < 1900 || year > 2099) return "";
  if (!month || !day || !year) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index + 1])
);

function normalizeLongDate(value) {
  const clean = normalizeWhitespace(value);
  const monthFirstMatch = clean.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  const dayFirstMatch = clean.match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\.?,?\s+(\d{4})\b/i
  );
  if (!monthFirstMatch && !dayFirstMatch) return "";
  const monthName = monthFirstMatch ? monthFirstMatch[1] : dayFirstMatch[2];
  const dayValue = monthFirstMatch ? monthFirstMatch[2] : dayFirstMatch[1];
  const yearValue = monthFirstMatch ? monthFirstMatch[3] : dayFirstMatch[3];
  const month = MONTHS.get(monthName.toLowerCase().replace(/\.$/, ""));
  const day = Number(dayValue);
  const year = Number(yearValue);
  if (!month || !day || !year) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeAnyDate(value, folderDate) {
  return normalizeLongDate(value) || normalizeDate(value, folderDate);
}

const DOCUMENT_TYPE_PREFIXES = [
  ["Schedule of the President", "Schedule"],
  ["Telephone Log", "Telephone Log"],
  ["Talking Points", "Talking Points"],
  ["Press Release", "Press Release"],
  ["Cover Sheet", "Cover Sheet"],
  ["Index Cards", "Index Cards"],
  ["Draft Cable", "Draft Cable"],
  ["White House Staffing Memorandum", "White House Staffing Memorandum"],
  ["Handwritten", "Handwritten"],
  ["Coversheet", "Coversheet"],
  ["Memorandum", "Memorandum"],
  ["Directive", "Directive"],
  ["Telegram", "Telegram"],
  ["Transcript", "Transcript"],
  ["Photograph", "Photograph"],
  ["Briefing", "Briefing"],
  ["Statement", "Statement"],
  ["Newspaper", "Newspaper"],
  ["Magazine", "Magazine"],
  ["Message", "Message"],
  ["Summary", "Summary"],
  ["Schedule", "Schedule"],
  ["Report", "Report"],
  ["Notes", "Notes"],
  ["Memo", "Memo"],
  ["Note", "Note"],
  ["Letter", "Letter"],
  ["Cable", "Cable"],
  ["List", "List"],
  ["Agenda", "Agenda"],
  ["Draft", "Draft"],
  ["Article", "Article"],
  ["Cards", "Cards"],
  ["Card", "Card"],
  ["Book", "Book"],
  ["Form", "Form"],
  ["Chart", "Chart"],
  ["Diagram", "Diagram"],
  ["Outline", "Outline"],
  ["Manifest", "Manifest"],
  ["Fax", "Fax"],
  ["Map", "Map"],
  ["Log", "Log"],
];

function splitDocTypeAndInlineTitle(value) {
  const rest = cleanLine(value);
  const match = DOCUMENT_TYPE_PREFIXES.find(([prefix]) => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:\\b|:|\\.|,|\\s)`, "i").test(rest);
  });
  if (!match) return null;

  const [prefix, type] = match;
  const inlineTitle = rest
    .slice(prefix.length)
    .replace(/^[\s:.,-]+/, "")
    .trim();
  return { type, inlineTitle };
}

function parseDocStart(line) {
  const match = line.match(/^(\d{1,3}[a-z]?)\.\s+(.+)$/i);
  if (!match) return null;
  const parsed = splitDocTypeAndInlineTitle(match[2]);
  return parsed ? { number: match[1], ...parsed } : null;
}

function parseDocumentBlock(lines, folder) {
  const start = parseDocStart(lines[0]);
  if (!start) return null;

  const titleLines = [];
  const restrictionLines = [];
  const classificationLines = [];
  let dateRaw = "";
  let sawColumnValue = false;

  if (start.inlineTitle) {
    titleLines.push(start.inlineTitle);
  }

  for (const rawLine of lines.slice(1)) {
    const line = cleanLine(rawLine);
    if (!line || isHeaderLine(line)) continue;
    if (!dateRaw && isDateLine(line)) {
      dateRaw = line;
      sawColumnValue = true;
      continue;
    }
    if (isClassificationLine(line)) {
      classificationLines.push(line.toUpperCase());
      sawColumnValue = true;
      continue;
    }
    if (isRestrictionLine(line)) {
      restrictionLines.push(line);
      sawColumnValue = true;
      continue;
    }
    if (sawColumnValue) {
      if (titleLines.length && /\(\s*\d+\s*pp?\.?\)/i.test(line)) {
        titleLines.push(line);
      }
      continue;
    }
    titleLines.push(line);
  }

  const title = normalizeWhitespace(titleLines.join(" "))
    .replace(/\s+\(\s+/g, " (")
    .replace(/\s+\)/g, ")");
  if (!title || /^page \d+ of \d+$/i.test(title)) return null;
  if (title.length < 3 || title.length > 500) return null;

  const pageMatch = title.match(/\((\d+)\s*pp?\.?\)/i);
  const documentDate = normalizeDate(dateRaw, folder.date);
  const seenDate = folder.date;

  return {
    id: `${folder.id}-doc-${start.number.toLowerCase()}`,
    folderId: folder.id,
    folderNaId: folder.naId,
    folderTitle: folder.title,
    folderDate: folder.date,
    folderLocalId: folder.localId,
    folderContainerId: folder.containerId,
    catalogUrl: folder.catalogUrl,
    pdfUrl: folder.pdfUrl || "",
    chapterId: folder.chapterId,
    chapter: folder.chapter,
    themes: folder.themes,
    searchTerms: folder.searchTerms,
    documentNumber: start.number,
    documentType: start.type,
    title,
    date: seenDate,
    seenDate,
    documentDate,
    year: seenDate.slice(0, 4),
    month: seenDate.slice(0, 7),
    pages: pageMatch ? Number(pageMatch[1]) : null,
    restriction: unique(restrictionLines).join("; "),
    classification: unique(classificationLines).join("; "),
    evidence: "Listed in NARA extracted Withdrawal/Redaction Sheet text for the folder.",
    evidenceStatus: "redaction-sheet-listed",
    citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, document ${start.number}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
  };
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseDocumentsFromText(text, folder) {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  const documents = [];
  let current = null;

  for (const line of lines) {
    const start = parseDocStart(line);
    if (start) {
      if (current) {
        const parsed = parseDocumentBlock(current, folder);
        if (parsed) documents.push(parsed);
      }
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }

  if (current) {
    const parsed = parseDocumentBlock(current, folder);
    if (parsed) documents.push(parsed);
  }

  return Array.from(new Map(documents.map((doc) => [doc.id, doc])).values());
}

const DIRECT_SCAN_TYPES = {
  "magazine-issue": "Magazine Issue",
  "telephone-log": "Telephone Log",
  "memorandum-packet": "Memorandum Packet",
  "report-packet": "Report Packet",
  "event-packet": "Event Packet",
  "press-article": "Press Article",
  "letter-packet": "Letter Packet",
  "speech-material": "Speech Material",
  "direct-scan": "Direct Folder Scan",
};

function contentLinesFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  const positionIndex = lines.findIndex((line) => /^position:?$/i.test(line));
  const hasAdministrativeMarker = lines.some((line) => /^foia marker$/i.test(line));
  let start =
    positionIndex >= 0
      ? positionIndex + 1
      : hasAdministrativeMarker
        ? Math.min(lines.length, 30)
        : 0;

  while (
    start < lines.length &&
    (/^[a-z]$/i.test(lines[start]) || /^[0o]$/i.test(lines[start]) || /^\d$/.test(lines[start]))
  ) {
    start += 1;
  }

  return lines.slice(start).filter((line) => !isHeaderLine(line));
}

function classifyDirectScan(folder, contentLines) {
  const text = `${folder.title}\n${contentLines.slice(0, 140).join("\n")}`;
  const lead = `${folder.title}\n${contentLines.slice(0, 45).join("\n")}`;
  const lower = text.toLowerCase();
  const leadLower = lead.toLowerCase();
  const title = folder.title.toLowerCase();

  if (/magazines/.test(title)) return "magazine-issue";
  if (
    /u\.?\s*s\.?\s*news|u\.s\.news/i.test(lead) &&
    /\bvol\.\s*\d+|\bno\.\s*\d+|world report/i.test(lead) &&
    !/daily press clippings|daily news clips|white house news summary|news summary/i.test(lead)
  ) {
    return "magazine-issue";
  }
  if (
    /telephone memorandum|signal switchboard|telephone log/.test(leadLower) ||
    (/presidential phone calls/.test(leadLower) && /incoming\/outgoing/.test(leadLower))
  ) {
    return "telephone-log";
  }
  if (/daily news clips|daily press clippings|white house news summary|news summary|daily briefing/.test(leadLower)) {
    return "press-article";
  }
  if (/remarks by the president|address|speech|statement by the press secretary/.test(leadLower)) {
    return "speech-material";
  }
  if (/\bletter\b|^dear |[\n ]dear /.test(leadLower)) return "letter-packet";
  if (/the president has seen|memorandum for the president|memorandum to john h\. sununu|subject:/.test(leadLower)) {
    return "memorandum-packet";
  }
  if (/luncheon|dinner|reception|schedule|arrival|departure|participants|guest list|program/.test(leadLower)) {
    return "event-packet";
  }
  if (/upi|associated press|reuters|white house reporter|newspaper|washington post|new york times|editorials/.test(leadLower)) {
    return "press-article";
  }
  if (/response of the administration|report|overview|transmitted to the congress|issues update/.test(leadLower)) {
    return "report-packet";
  }
  return "direct-scan";
}

function classifyDirectScanItemization(folder, category, contentLines) {
  const lead = contentLines.slice(0, 45).join("\n");
  const compactLead = normalizeWhitespace(lead);
  const lower = lead.toLowerCase();

  if (category === "magazine-issue") {
    return {
      status: "single-document",
      disposition: "single-magazine-issue",
      note: "Treated as one magazine issue supplied in the Daily File.",
    };
  }

  if (
    /telephone memorandum|signal switchboard|telephone log/.test(lower) ||
    (/presidential phone calls/.test(lower) && /incoming\/outgoing/.test(lower))
  ) {
    return {
      status: "single-document",
      disposition: "single-telephone-log",
      note: "Treated as one telephone memorandum/log document.",
    };
  }

  if (/schedule of the president/.test(lower)) {
    return {
      status: "single-document",
      disposition: "single-presidential-schedule",
      documentType: "Schedule",
      note: "Treated as one presidential schedule document.",
    };
  }

  if (
    /office of the press secretary/.test(lower) &&
    /for immediate release/.test(lower) &&
    /remarks by the president|statement by the press secretary/.test(lower)
  ) {
    return {
      status: "single-document",
      disposition: "single-press-release-or-remarks",
      note: "Treated as one press-release, remarks, or statement document.",
    };
  }

  if (
    /^[A-Z0-9 .,'&/-]{12,}\n[A-Z0-9 .,'&/-]{8,}/.test(lead) &&
    /thank you/i.test(compactLead.slice(0, 420))
  ) {
    return {
      status: "single-document",
      disposition: "single-remarks-copy",
      note: "Treated as one remarks/speech copy based on the event heading and opening text.",
    };
  }

  if (/daily news clips|daily press clippings|white house news summary|news summary|daily briefing/.test(lower)) {
    return {
      status: "packet-needs-itemization",
      disposition: "packet-news-clippings",
      note: "News clipping or news summary packet; individual items still need review.",
    };
  }

  if (/memorandum|recommended telephone call|white house staffing memorandum|from:|subject:/.test(lower)) {
    return {
      status: "packet-needs-itemization",
      disposition: "packet-memorandum-material",
      note: "Memorandum packet or mixed briefing material; individual items still need review.",
    };
  }

  if (/\bdear\b|from the white house|the president\s+\w+ \d{1,2}, \d{4}/i.test(lead)) {
    return {
      status: "packet-needs-itemization",
      disposition: "packet-correspondence",
      note: "Correspondence packet; letters, enclosures, or routing material still need review.",
    };
  }

  return {
    status: "packet-needs-itemization",
    disposition: "packet-uncertain",
    note: "Direct scan remains a packet or uncertain itemization case.",
  };
}

function excerptFromLines(lines) {
  const excerpt = normalizeWhitespace(lines.slice(0, 28).join(" "));
  return excerpt.length > 520 ? `${excerpt.slice(0, 517).trim()}...` : excerpt;
}

const DIRECT_SCAN_SUPPLEMENTAL_ITEMS = {
  470417565: [
    {
      slug: "state-of-union-fact-sheet",
      documentType: "Fact Sheet",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Fact Sheet: The President's State of the Union Address",
      documentDate: "1992-01-28",
      pages: 16,
      excerpt:
        "The President in his State of the Union Address spoke about America's unique place in the world and about his plans for restoring growth in America's economy.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the document start was confirmed in full-PDF OCR.",
    },
    {
      slug: "growth-agenda-highlights",
      documentType: "Fact Sheet",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Highlights of the President's Growth Agenda",
      documentDate: "1992-01-28",
      pages: 1,
      excerpt:
        "The President has a plan to address both the short-term and the long-term problems facing the economy.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the document start was confirmed in full-PDF OCR.",
    },
    {
      slug: "growth-agenda-chart",
      documentType: "Chart",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Chart: The President's Growth Agenda",
      documentDate: "1992-01-28",
      pages: 1,
      excerpt:
        "The President's Growth Agenda chart lists immediate, intermediate, and long-term initiatives including withholding adjustment, regulatory relief, investment incentives, real-estate incentives, R&D, infrastructure, and Head Start.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the chart start was confirmed in full-PDF OCR.",
    },
    {
      slug: "fy1993-budget-fact-sheets",
      documentType: "Fact Sheets",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "The President's Budget for FY 1993: Fact Sheets",
      documentDate: "1992-01-28",
      pages: 55,
      excerpt:
        "The attached materials present the highlights of the President's budget for Fiscal Year 1993.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the document start was confirmed in full-PDF OCR.",
    },
    {
      slug: "state-of-union-talking-points",
      documentType: "Talking Points",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Talking Points: The State of the Union",
      documentDate: "1992-01-28",
      pages: 1,
      excerpt:
        "The President hit a home run tonight. He was Presidential, composed, and decisive.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the talking-points start was confirmed in full-PDF OCR.",
    },
    {
      slug: "fy1993-budget-talking-points",
      documentType: "Talking Points",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Talking Points: Overview of the President's FY 1993 Budget",
      documentDate: "1992-01-28",
      pages: 1,
      excerpt:
        "The budget reflects the President's Comprehensive Agenda for Growth and is consistent with the Budget Agreement.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the talking-points start was confirmed in full-PDF OCR.",
    },
    {
      slug: "growth-agenda-effects-talking-points",
      documentType: "Talking Points",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Talking Points: The President's Growth Agenda: Effects on the Economy",
      documentDate: "1992-01-28",
      pages: 1,
      excerpt:
        "The President's plan will add hundreds of billions of dollars of goods and services to the nation's output over the next five years.",
      evidence:
        "Itemized from the cover memorandum attachment list in the NARA direct folder scan; the talking-points start was confirmed in full-PDF OCR.",
    },
    {
      slug: "treasury-growth-plan-news",
      documentType: "Press Release",
      category: "treasury-growth-package-material",
      disposition: "itemized-treasury-growth-package-material",
      title:
        "Treasury News: President Bush's Plan to Stimulate Economic Recovery, Promote Long-Term Growth, and Expand Opportunity",
      documentDate: "1992-01-28",
      pages: 30,
      excerpt:
        "The President's plan will stimulate economic recovery and job-creating investment; open up opportunity for home ownership and real estate recovery; and help families build for the future.",
      evidence:
        "Itemized from a Treasury News heading found in full-PDF OCR of the NARA direct folder scan after the cover-listed attachments.",
    },
    {
      slug: "treasury-tax-examples",
      documentType: "Examples",
      category: "treasury-growth-package-material",
      disposition: "itemized-treasury-growth-package-material",
      title: "Treasury Examples: How President Bush's Package Could Affect Individuals and Families",
      documentDate: "1992-01-28",
      pages: 8,
      excerpt:
        "These seven examples are hypothetical illustrations of how President Bush's package could affect individuals and families.",
      evidence:
        "Itemized from a Treasury examples heading found in full-PDF OCR of the NARA direct folder scan after the cover-listed attachments.",
    },
  ],
  470417713: [
    {
      slug: "billy-graham-convention-note",
      documentType: "President's Note",
      category: "president-note-item",
      disposition: "itemized-president-note",
      title: "Note from the President to Ron Kaufman re Billy Graham and the Republican convention",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The President tells Ron Kaufman, with copies to Craig Fuller and Bob Teeter, not to pressure Billy Graham about appearing at the convention.",
      evidence:
        "Itemized from a Walker's Point presidential note heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "campaign-finance-reform-column",
      documentType: "Press Column",
      category: "press-column-item",
      disposition: "itemized-press-column",
      title: "Press column by George J. Mitchell on campaign-finance reform",
      documentDate: "",
      pages: 2,
      excerpt:
        "A newspaper clipping by George J. Mitchell discusses House and Senate action on campaign-finance reform legislation.",
      evidence:
        "Itemized from a press-column byline and campaign-finance reform text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "jon-bush-damato-victory-92-note",
      documentType: "President's Note",
      category: "president-note-item",
      disposition: "itemized-president-note",
      title: "Note from the President to Ron Kaufman re Jon Bush, Al D'Amato, and Victory '92",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The President reports that Jon Bush called at Al D'Amato's behest in favor of a joint D'Amato-Victory '92 fundraiser and asks Kaufman to advise the campaign.",
      evidence:
        "Itemized from a Walker's Point presidential note heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rosty-chicago-note",
      documentType: "President's Note",
      category: "president-note-item",
      disposition: "itemized-president-note",
      title: "Note from the President to Sam Skinner re Rosty and Chicago",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The President thanks Sam Skinner for a prompt response to Chicago's troubles and notes Dan Rostenkowski's request to talk money for Chicago.",
      evidence:
        "Itemized from a Walker's Point presidential note heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "april-17-telephone-memoranda",
      documentType: "Telephone Memoranda",
      category: "telephone-log-item",
      disposition: "itemized-telephone-log",
      title: "Telephone memoranda and Signal Switchboard log: April 17, 1992",
      documentDate: "1992-04-17",
      pages: 2,
      excerpt:
        "White House telephone memoranda list calls with Billy Graham, Gordon Zacks, Max Fisher, Roger Ailes, George W. Bush, Brent Scowcroft, Sam Skinner, and others.",
      evidence:
        "Itemized from White House telephone memorandum and Signal Switchboard headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "april-17-presidential-movements",
      documentType: "Presidential Movements",
      category: "presidential-movements-item",
      disposition: "itemized-presidential-movements",
      title: "Presidential Movements: Kennebunkport, Maine, April 17, 1992",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The movement log records low-key motorcade movements between Walker's Point, North Street Congregational Church, and Kenneth Raynor's residence.",
      evidence:
        "Itemized from a Presidential Movements heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-april-17-1992",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Friday, April 17, 1992, 6 A.M. EDT Edition",
      documentDate: "1992-04-17",
      pages: 17,
      excerpt:
        "The Office of the Press Secretary news summary opens with education-plan coverage, Clinton economic criticism, Perot ballot coverage, abortion counseling, Bosnia, Libya, Iraq, and network news.",
      evidence:
        "Itemized from a White House News Summary heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "political-cartoon-packet-april-17-1992",
      documentType: "Political Cartoons",
      category: "political-cartoon-packet",
      disposition: "itemized-political-cartoon-packet",
      title: "Political cartoon packet on the 1992 campaign and House Bank scandal",
      documentDate: "1992-04-17",
      pages: 23,
      excerpt:
        "A packet of clipped political cartoons covers Clinton, Perot, Iran, Boris Yeltsin, House Bank criticism, unemployment, and other campaign subjects.",
      evidence:
        "Itemized from a run of political cartoon pages found in full-PDF OCR of the NARA direct folder scan after the White House News Summary.",
    },
    {
      slug: "bud-walton-condolence-letter",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Bud Walton re Sam Walton",
      documentDate: "1992-04-17",
      pages: 4,
      excerpt:
        "The President sends condolences to Bud Walton after Sam Walton's death and recalls his Bentonville visit before Walton's passing.",
      evidence:
        "Itemized from White House letter pages and duplicate/copy pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rob-walton-condolence-letter",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Rob Walton re Sam Walton",
      documentDate: "1992-04-17",
      pages: 4,
      excerpt:
        "The President thanks Rob Walton for his hospitality in Bentonville and sends condolences after Sam Walton's death.",
      evidence:
        "Itemized from White House letter pages and duplicate/copy pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "apn-daily-briefing-april-17-1992",
      documentType: "Daily Political Briefing",
      category: "daily-political-briefing-item",
      disposition: "itemized-daily-political-briefing",
      title: "The Daily Briefing on American Politics: Friday, April 17, 1992",
      documentDate: "1992-04-17",
      pages: 23,
      excerpt:
        "The American Political Network briefing summarizes Bush and Clinton education/economic coverage, Perot, House Bank fallout, polling, Senate races, and TV monitoring.",
      evidence:
        "Itemized from The Daily Briefing on American Politics heading and Hotline sections found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "materials-forwarded-to-president-april-17-1992",
      documentType: "Forwarded Materials List",
      category: "forwarded-materials-list",
      disposition: "itemized-forwarded-materials-list",
      title: "Materials Forwarded to the President: April 17, 1992, to Kennebunkport",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The forwarded-materials list identifies action, classified, information, remarks, and schedule items, including Cuba policy, Canada beer, a Cabinet report, and an Ohio trip notebook.",
      evidence:
        "Itemized from a Materials Forwarded to the President cover list found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "point-of-light-kristen-wunderle",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press Release: Kristen Wunderle recognized as the 749th Daily Point of Light",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The White House announces Kristen Wunderle of Parma, Ohio, as the 749th Daily Point of Light for her work with residents of the Corinthian Nursing Home.",
      evidence:
        "Itemized from an Office of the Press Secretary release heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-dinner-for-six",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report: Dinner for Six",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "Frank Murray reports on President and Mrs. Bush's dinner at Ken Raynor's Kennebunk residence.",
      evidence:
        "Itemized from a Pool Report heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-good-friday-services",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #3: The Bushes Attend Good Friday Services",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "John Yang reports on President and Mrs. Bush attending Good Friday services at First Congregational Church in Kennebunkport.",
      evidence:
        "Itemized from a Pool Report #3 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-dunagin-family",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to George and Sandy Dunagin",
      documentDate: "1992-04-17",
      pages: 1,
      excerpt:
        "The President thanks Mr. and Mrs. Dunagin for support and encloses a signed photograph.",
      evidence:
        "Itemized from a White House letter heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "dunagin-family-to-president",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from George, Sandy, and Angela Dunagin to President Bush",
      documentDate: "1992-03-11",
      pages: 1,
      excerpt:
        "The Dunagin family writes after Super Tuesday to encourage President Bush, praise his record, and request an autographed photograph.",
      evidence:
        "Itemized from an incoming constituent letter start found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-april-17-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Friday, April 17, 1992",
      documentDate: "1992-04-17",
      pages: 22,
      excerpt:
        "Mrs. Bush's Press Office clipping packet covers Barbara Bush's Los Angeles Mission visit, Millie's Book royalties, Hillary Clinton, and working women.",
      evidence:
        "Itemized from a Mrs. Bush's Press Office Daily Press Clippings cover page and clipping run found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "scowcroft-cuba-initiative-memo",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Information Memorandum from Brent Scowcroft to the President re New Presidential Initiative on Cuba",
      documentDate: "1992-04-17",
      pages: 2,
      excerpt:
        "Brent Scowcroft outlines a plan for a presidential Cuba statement, Torricelli bill modifications, contacts with Mack and Ros-Lehtinen, and a follow-up letter to interested members.",
      evidence:
        "Itemized from a confidential information memorandum and Situation Room cover sheet found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "april-17-19-presidential-schedules",
      documentType: "Presidential Schedule",
      category: "presidential-schedule-item",
      disposition: "itemized-presidential-schedule",
      title: "Schedules of the President: April 17-19, 1992",
      documentDate: "1992-04-17",
      pages: 2,
      excerpt:
        "The schedule pages list the President in Kennebunkport for Good Friday, Saturday, and Easter Sunday.",
      evidence:
        "Itemized from Schedule of the President headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "phone-call-slips-handwritten-notes",
      documentType: "Handwritten Notes and Call Slips",
      category: "handwritten-notes-packet",
      disposition: "itemized-handwritten-notes",
      title: "Presidential phone-call slips and handwritten notes packet",
      documentDate: "",
      pages: 9,
      excerpt:
        "A Bush Library photocopy packet includes From the Desk of George Bush pages, handwritten notes, presidential phone-call slips, and a message from Rose Zamaria about George DePontis and Luz Santa Romana.",
      evidence:
        "Itemized as a mixed handwritten-notes packet from full-PDF OCR and photocopy markers in the NARA direct folder scan; several individual pages have low-confidence OCR.",
    },
    {
      slug: "scowcroft-tv-marti-memo",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Information Memorandum from Brent Scowcroft to the President re Update on TV Marti",
      documentDate: "",
      pages: 2,
      excerpt:
        "Brent Scowcroft reports that Cuban test-pattern broadcasting interfered with TV Marti and summarizes agency disagreement over whether to broadcast over the Cuban signal.",
      evidence:
        "Itemized from a confidential information memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ocs-leasing-tracts-memo",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum for Sam Skinner re possible withdrawal of OCS tracts from the 1992-97 leasing program",
      documentDate: "1992-04-06",
      pages: 2,
      excerpt:
        "A memorandum discusses whether to exempt 63 Outer Continental Shelf tracts off the Santa Barbara/San Luis Obispo coast from Interior's 1992-97 leasing program, with a handwritten presidential note at the top.",
      evidence:
        "Itemized from a memorandum heading and presidential handwriting found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "lions-international-invitation-packet",
      documentType: "Correspondence Packet",
      category: "scheduling-correspondence-packet",
      disposition: "itemized-scheduling-correspondence",
      title: "Lions International 75th Anniversary invitation correspondence packet",
      documentDate: "1992-04-15",
      pages: 12,
      excerpt:
        "The packet includes Robert K. Turner, Kathy Super, Norman Dahl, Donald Banker, and handwritten material regarding a proposed presidential appearance at the Lions International 75th Anniversary banquet.",
      evidence:
        "Itemized from Lions Clubs International letterheads, White House correspondence, and handwritten-note pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ferc-order-636-material",
      documentType: "News Release and Fact Sheet",
      category: "regulatory-material",
      disposition: "itemized-regulatory-material",
      title: "FERC Order No. 636 news release and fact sheet on natural gas pipeline restructuring",
      documentDate: "1992-04-09",
      pages: 7,
      excerpt:
        "Federal Energy Regulatory Commission materials announce and summarize Order No. 636, the Restructuring Rule for interstate natural gas pipelines.",
      evidence:
        "Itemized from a FERC news release and Summary of Order No. 636 fact sheet found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "don-ritter-quality-competitiveness-correspondence",
      documentType: "Correspondence and Notes",
      category: "congressional-correspondence",
      disposition: "itemized-congressional-correspondence",
      title: "Don Ritter correspondence and handwritten notes re quality and American competitiveness",
      documentDate: "",
      pages: 4,
      excerpt:
        "A packet addressed to Representative Don Ritter includes handwritten material discussing quality, competitiveness, administration beacons, and related policy arguments.",
      evidence:
        "Itemized from Don Ritter letterhead/address pages and handwritten-note pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "feigenbaum-quality-americas-competitiveness",
      documentType: "Faxed Report",
      category: "faxed-report",
      disposition: "itemized-faxed-report",
      title: "Faxed report by A. V. Feigenbaum: Quality and America's Competitiveness",
      documentDate: "1992-04-15",
      pages: 9,
      excerpt:
        "General Systems Company faxed A. V. Feigenbaum's April 1992 essay on quality and America's competitiveness for Representative Don Ritter.",
      evidence:
        "Itemized from a General Systems fax cover sheet and report title pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "barbara-bush-la-mission-tv-reports",
      documentType: "Television Reports",
      category: "television-report-packet",
      disposition: "itemized-television-report-packet",
      title: "TV reports and clipping material on Barbara Bush's Los Angeles Mission visit",
      documentDate: "1992-04-16",
      pages: 2,
      excerpt:
        "TV Reports material for the Social Office summarizes coverage of Barbara Bush visiting and dedicating the Los Angeles Mission Education Center.",
      evidence:
        "Itemized from TV Reports and Los Angeles Mission text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "newstab-wire-reports-april-18-20-1992",
      documentType: "Wire Reports",
      category: "wire-report-packet",
      disposition: "itemized-wire-report-packet",
      title: "Newstab wire reports on Mark Russell, Ross Perot polling, AMVETS awards, and Points of Light",
      documentDate: "1992-04-20",
      pages: 5,
      excerpt:
        "Newstab items from April 18-20 cover Mark Russell jokes, Ross Perot polling, AMVETS Silver Helmet awards, and Columbia Savings receiving a Points of Light award.",
      evidence:
        "Itemized from Newstab datelines found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "loose-press-clippings-bush-family-matalin-hillary",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Loose press clippings on Bush family business, Mary Matalin, Millie, Marilyn Quayle, Hillary Clinton, and women in politics",
      documentDate: "1992-04-20",
      pages: 23,
      excerpt:
        "Loose clippings include Jeff Gerth on Bush relatives' business dealings, Mary Matalin profiles, Millie's Book royalties, Marilyn Quayle coverage, Hillary Clinton analysis, and op-eds on women in politics.",
      evidence:
        "Itemized from a run of newspaper and magazine clipping starts found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
  470417874: [
    {
      slug: "white-house-news-summary-june-29-1992",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Monday, June 29, 1992, 6:00 A.M. EDT Edition",
      documentDate: "1992-06-29",
      pages: 21,
      excerpt:
        "Office of the Press Secretary White House News Summary for Monday, June 29, 1992, opening with earthquake cleanup, Tailhook, Yugoslavia, POWs, and Sunday network news.",
      evidence:
        "Itemized from a White House News Summary heading found in full-PDF OCR of the NARA direct folder scan after the catalog OCR truncation point.",
    },
    {
      slug: "apn-daily-briefing-american-politics",
      documentType: "Daily Political Briefing",
      category: "daily-political-briefing-item",
      disposition: "itemized-daily-political-briefing",
      title: "The Daily Briefing on American Politics: Monday, June 29, 1992",
      documentDate: "1992-06-29",
      pages: 24,
      excerpt:
        "The American Political Network daily briefing summarizes Bush-Perot coverage, abortion, Democratic convention planning, foreign policy criticism, and campaign polling.",
      evidence:
        "Itemized from The Daily Briefing on American Politics heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "upi-paderewski-poland-welcome",
      documentType: "Wire Story",
      category: "wire-story-item",
      disposition: "itemized-wire-story",
      title: "UPI Wire Story: Poland welcomes return of Ignacy Jan Paderewski",
      documentDate: "1992-06-29",
      pages: 2,
      excerpt:
        "Bogdan Turek reports from Warsaw on Poland welcoming Ignacy Jan Paderewski's remains before President Bush's July 5 stop en route to the Munich Economic Summit.",
      evidence:
        "Itemized from a UPI dateline and byline found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "upi-paderewski-dying-wish",
      documentType: "Wire Story",
      category: "wire-story-item",
      disposition: "itemized-wire-story",
      title: "UPI Wire Story: Paderewski's dying wish to be buried in free Poland",
      documentDate: "1992-06-28",
      pages: 2,
      excerpt:
        "Helen Thomas reports on Paderewski's remains being transported from Arlington to Poland, with President and Mrs. Bush scheduled to attend the reburial.",
      evidence:
        "Itemized from a UPI dateline and byline found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "loose-press-clippings-white-house-perot-campaign",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Loose press clippings on White House workers, Perot, campaign issues, schools, and AIDS",
      documentDate: "1992-06-29",
      pages: 21,
      excerpt:
        "Loose newspaper and wire clippings include White House folklore coverage, Margot Perot, Bush-Perot campaign stories, school choice, sexual harassment, and AIDS reporting.",
      evidence:
        "Itemized from a run of full-PDF OCR clipping starts in the NARA direct folder scan between the Paderewski wire stories and pool reports.",
    },
    {
      slug: "pool-report-new-york-dea-dedication",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #1: Air Force One to DEA dedication to Hilton Hotel, New York",
      documentDate: "1992-06-29",
      pages: 1,
      excerpt:
        "Pool Report #1 covers Air Force One, the DEA dedication trip, abortion-decision reaction, and the New York motorcade.",
      evidence:
        "Itemized from a Pool Report #1 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-detroit",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #2: Detroit, Michigan",
      documentDate: "1992-06-29",
      pages: 1,
      excerpt:
        "Pool Report #2 covers the Detroit leg, Ron Kaufman's comments on Perot polling, and Marlin Fitzwater's comments on U.N. action regarding Yugoslavia.",
      evidence:
        "Itemized from a Pool Report #2 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "remarks-dea-dedication",
      documentType: "Remarks",
      category: "remarks-item",
      disposition: "itemized-remarks",
      title: "Remarks by the President at Drug Enforcement Administration Dedication Ceremony",
      documentDate: "1992-06-29",
      pages: 4,
      excerpt:
        "Remarks by the President at the Drug Enforcement Administration dedication ceremony in New York, emphasizing law enforcement, drug control, and anticrime legislation.",
      evidence:
        "Itemized from an Office of the Press Secretary remarks heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-note-to-mike-deland",
      documentType: "President's Note",
      category: "president-note-item",
      disposition: "itemized-president-note",
      title: "Note from the President to Mike Deland re Bill Roberts and EPA proposals",
      documentDate: "1992-06-29",
      pages: 1,
      excerpt:
        "The President asks Mike Deland to contact Bill Roberts by phone or letter regarding Roberts's two EPA proposals.",
      evidence:
        "Itemized from a From the President note heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-bill-roberts",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from the President to Bill Roberts re EPA and regulations",
      documentDate: "1992-06-26",
      pages: 1,
      excerpt:
        "The President tells Bill Roberts he will get him a specific reply on EPA suggestions and says the administration is lifting regulations from the backs of the American people.",
      evidence:
        "Itemized from a presidential letter start found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "bill-roberts-to-president",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from Bill Roberts to President Bush re Clean Air Act proposals",
      documentDate: "",
      pages: 1,
      excerpt:
        "Bill Roberts, chairman of the Saline County Republican Central Committee, asks the President to consider Clean Air Act compliance extensions and job-protection measures.",
      evidence:
        "Itemized from an undated Bill Roberts letter heading and salutation found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "burton-lee-to-president-milbank",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum from Dr. Burton Lee to the President re Jerry Milbank material",
      documentDate: "1992-07-02",
      pages: 1,
      excerpt:
        "Dr. Burton Lee forwards Jerry Milbank material and suggests that someone in the campaign office answer Milbank responsibly.",
      evidence:
        "Itemized from a Memorandum for the President heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "jeremiah-milbank-to-president",
      documentType: "Letter and Enclosure",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from Jeremiah Milbank to President Bush with Thoughts for the Campaign of the President",
      documentDate: "1992-07-23",
      pages: 9,
      excerpt:
        "Jeremiah Milbank sends thoughts on energizing the reelection campaign, including congressional term limits, taxes, welfare, crime, environment, defense, and action now.",
      evidence:
        "Itemized from Jeremiah Milbank letterhead and enclosed campaign-thoughts pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-jeremiah-milbank",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from the President to Jeremiah Milbank re campaign ideas",
      documentDate: "",
      pages: 1,
      excerpt:
        "The President thanks Jerry Milbank for sending his ideas and says they sound like many of his own.",
      evidence:
        "Itemized from an undated presidential letter start found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "daily-news-clips-june-29-1992",
      documentType: "Daily News Clips",
      category: "daily-news-clips-item",
      disposition: "itemized-daily-news-clips",
      title: "Daily News Clips: Monday, June 29, 1992",
      documentDate: "1992-06-29",
      pages: 77,
      excerpt:
        "Office of Media Affairs Daily News Clips from The Washington Post, The Washington Times, The Wall Street Journal, USA Today, and The New York Times.",
      evidence:
        "Itemized from a Daily News Clips cover page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "cardinal-law-to-president-immigration-commission",
      documentType: "Faxed Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Faxed letter from Cardinal Bernard Law to President Bush re Commission on Legal Immigration funding",
      documentDate: "1992-06-29",
      pages: 2,
      excerpt:
        "Cardinal Bernard Law writes as chairman of the Commission on Legal Immigration requesting startup funding for initial staffing and meeting costs.",
      evidence:
        "Itemized from Cardinal's Residence fax and letter pages found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
  470418165: [
    {
      slug: "bush-quayle-fax-family-friends-list",
      documentType: "Fax",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Fax from Debbie Dunn to Bobbie Kilberg with Bush-Quayle family and friends contact list",
      documentDate: "1992-10-21",
      pages: 12,
      excerpt:
        "Bush Quayle '92 fax cover sheet from Debbie Dunn to Bobbie Kilberg, followed by a family and friends contact list for the November 3 file.",
      evidence:
        "Itemized from full-PDF OCR of an OCR-truncated NARA direct folder scan; the catalog OCR cuts off before later packet starts.",
    },
    {
      slug: "zamaria-to-president-moss-party",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Rose Zamaria to the President re Bill Moss election-night party",
      documentDate: "1992-10-14",
      pages: 1,
      excerpt:
        "Rose Zamaria reports that Bill Moss wanted to underwrite an election-night party, but appeared to lose interest when told the President would be there for only 20 or 30 minutes.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "zamaria-to-jim-baker-moss-party",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Rose Zamaria to Jim Baker re Bill Moss election-night party",
      documentDate: "1992-10-13",
      pages: 1,
      excerpt:
        "Rose Zamaria asks Jim Baker whether Bill Moss can go forward with an election-night party for family, old friends, and staff at the Houstonian.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-handwritten-note-moss",
      documentType: "Handwritten Note",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Handwritten note from the President to Rose Zamaria re getting back to Moss",
      documentDate: "1992-10-13",
      pages: 1,
      excerpt:
        "The President asks Rose Zamaria to remind him to get back to Moss in a week or so.",
      evidence:
        "Itemized from a Bush Library photocopy handwriting marker found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-william-moss",
      documentType: "Letter",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Letter from the President to William P. Moss re election night at the Houstonian",
      documentDate: "1992-10-05",
      pages: 1,
      excerpt:
        "The President thanks William Moss for offering to give an election-night party at the Houstonian and says he will let Moss know very soon what the plans are.",
      evidence:
        "Itemized from a presidential letter start found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "william-moss-to-president",
      documentType: "Letter",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Letter from William P. Moss to the President re election-night party",
      documentDate: "1992-10-01",
      pages: 1,
      excerpt:
        "William P. Moss proposes an election-night party for the President and Barbara Bush with old friends, family, and past and present staff.",
      evidence:
        "Itemized from a William Moss letterhead and salutation found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "kilberg-to-zamaria-bush-brigade-update",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Bobbie Kilberg to Rose Zamaria re update on the '80 Bush Brigade project",
      documentDate: "1992-10-08",
      pages: 2,
      excerpt:
        "Bobbie Kilberg describes the project to locate 1980 Bush supporters, enlist their help in getting out the vote, and invite the '80 Bush Brigade to Houston for election night.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "groomes-to-bates-super-keller",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Karen Groomes to David Bates, Kathy Super, and John Keller re Bobbie Kilberg memo",
      documentDate: "1992-09-09",
      pages: 1,
      excerpt:
        "Karen Groomes forwards Bobbie Kilberg's memo for action now that President Bush would be in Houston on election eve.",
      evidence:
        "Itemized from a memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "kilberg-to-tutwiler-early-supporters",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Bobbie Kilberg to Margaret Tutwiler re early supporters of President Bush",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "Bobbie Kilberg recommends identifying early supporters, contacting them about the campaign, and inviting them to Houston for election night.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-daily-press-clippings",
      documentType: "Daily Press Clippings",
      category: "election-day-clippings",
      disposition: "itemized-election-day-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Tuesday, November 3, 1992",
      documentDate: "1992-11-03",
      pages: 35,
      excerpt:
        "Mrs. Bush's Press Office daily press clippings for Tuesday, November 3, 1992, including election and First Family coverage.",
      evidence:
        "Itemized from a Daily Press Clippings heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-thomas-devine",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from the President to Thomas J. Devine re Devine's October 28 letter",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "The President tells Thomas J. Devine that his October 28 letter caught up with him in Houston and that staff would look into it and give him a report.",
      evidence:
        "Itemized from a White House letter start found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "thomas-devine-to-president",
      documentType: "Letter",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Letter from Thomas J. Devine to the President re Soviet nuclear-powered submarines",
      documentDate: "1992-10-28",
      pages: 2,
      excerpt:
        "Thomas J. Devine urges presidential attention to nuclear weapons and reactors in lost Soviet submarines and the Woods Hole Oceanographic Institution's proposed conference.",
      evidence:
        "Itemized from Thomas J. Devine letterhead and salutation found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "media-affairs-election-day-news-clippings",
      documentType: "News Clippings",
      category: "election-day-clippings",
      disposition: "itemized-election-day-clippings",
      title: "Media Affairs Office News Clippings: Election Day, Tuesday, November 3, 1992",
      documentDate: "1992-11-03",
      pages: 90,
      excerpt:
        "Media Affairs Office election-day news clippings for Tuesday, November 3, 1992, beginning with a presidential candidate comparison and national newspaper coverage.",
      evidence:
        "Itemized from a Media Affairs Office News Clippings heading found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
};

function buildDirectSupplementalItemDocuments(folder, packetDoc) {
  const supplementalItems = DIRECT_SCAN_SUPPLEMENTAL_ITEMS[folder.naId] || [];
  if (!supplementalItems.length || !packetDoc.needsItemization) return [];

  return supplementalItems.map((item, index) => {
    const itemLabel = String(index + 1).padStart(2, "0");
    const seenDate = folder.date;
    const idKind = folder.naId === "470417565" ? "attachment" : "supplement";
    const citationKind = folder.naId === "470417565" ? "attachment" : "supplemental";
    const itemizationNote =
      folder.naId === "470417565"
        ? "Itemized from an OCR-truncated direct packet using a cover-memo attachment list and full-PDF OCR confirmation."
        : "Itemized from an OCR-truncated direct packet using cover-memo, heading, or full-PDF OCR evidence.";

    return {
      id: `${folder.id}-direct-${idKind}-${item.slug}`,
      folderId: folder.id,
      folderNaId: folder.naId,
      folderTitle: folder.title,
      folderDate: folder.date,
      folderLocalId: folder.localId,
      folderContainerId: folder.containerId,
      catalogUrl: folder.catalogUrl,
      pdfUrl: folder.pdfUrl || "",
      chapterId: folder.chapterId,
      chapter: folder.chapter,
      themes: folder.themes,
      searchTerms: folder.searchTerms,
      documentNumber: `Direct-A${itemLabel}`,
      documentType: item.documentType,
      directScanCategory: item.category,
      directScanDisposition: item.disposition,
      directScanItemizationStatus: "itemized-document",
      directScanItemizationNote: itemizationNote,
      parentPacketId: packetDoc.id,
      title: item.title,
      date: seenDate,
      seenDate,
      documentDate: item.documentDate,
      year: seenDate.slice(0, 4),
      month: seenDate.slice(0, 7),
      pages: item.pages,
      restriction: "",
      classification: "",
      excerpt: item.excerpt,
      evidence: item.evidence,
      evidenceStatus: "direct-scan-itemized",
      needsItemization: false,
      citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan ${citationKind} item ${itemLabel}, ${item.title}, National Archives Catalog NAID ${folder.naId}.`,
    };
  });
}

function directScanTitle(folder, typeLabel) {
  if (/^magazines,/i.test(folder.title)) return `${typeLabel}: ${folder.title}`;
  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),/i.test(folder.title)) {
    return `${typeLabel}: ${folder.title}`;
  }
  return folder.title;
}

function isDirectLetterhead(line) {
  return /^(the president|the presioent|the president of|presidents? the|tresident the|resident the|george bush|walkers point|the white house|from the white house)/i.test(
    line
  );
}

function isDirectPresidentMarker(line) {
  return /^(the president|the presioent|the president of|presidents? the|tresident the|resident the|george bush)/i.test(
    line
  );
}

function isSignatureContext(lines, index) {
  return /^(sincerely|warmest regards|best wishes|with appreciation|with warm|love to all|regards)[,;]?$/i.test(
    lines[index - 1] || ""
  );
}

function hasSalutation(lines, index, window = 6) {
  return lines
    .slice(index, Math.min(lines.length, index + window + 1))
    .some((line) => /^(dear|pear)\b/i.test(line));
}

function isDirectLetterStart(lines, index) {
  const line = lines[index];
  if (!line || /handwriting/i.test(line) || isSignatureContext(lines, index)) return false;
  if (isDirectPresidentMarker(line) && hasSalutation(lines, index, 6)) return true;
  if (isDirectLetterhead(line) && hasSalutation(lines, index, 5)) return true;
  return index < 4 && /^(dear|pear)\b/i.test(line);
}

function directLetterStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDirectLetterStart(lines, index)) continue;
    if (starts.length && index - starts[starts.length - 1] <= 7) continue;
    starts.push(index);
  }
  return starts;
}

function hasDirectSalutationContext(line) {
  return /^(the president|the presioent|the president of|george bush|walkers point|the white house|from the white house|washington|kennebunkport|date:?|\(?\d{1,4}\)?|[a-z]+day,?\s+[a-z]+|january|february|march|april|may|june|july|august|september|october|november|december|mr\.|mrs\.|ms\.|honorable|president george bush|bush library photocopy|document originally attached|cc:?|personal|\(personal\)|by courier|daily|aboard air force one|office of the president|united states senate|house of representatives|white house|fax|hand delivered)/i.test(
    line
  );
}

function isDirectSalutationLetterStart(lines, index) {
  const line = lines[index] || "";
  if (!/^(dear|pear)\b/i.test(line) || isSignatureContext(lines, index)) return false;
  const nextLines = lines.slice(index + 1, index + 5);
  if (!nextLines.some((nextLine) => /[a-z]{3,}/i.test(nextLine) && !/^(from|to|date|subject|re):?$/i.test(nextLine))) {
    return false;
  }
  if (index < 8) return true;
  return lines.slice(Math.max(0, index - 12), index).some(hasDirectSalutationContext);
}

function hasSupplementalSalutation(lines, index, window = 8) {
  return lines
    .slice(index, Math.min(lines.length, index + window + 1))
    .some((line) => /^(my\s+dear|dear|pear)\b/i.test(line));
}

function directCorrespondenceSupplementStarts(lines, primaryLetterStarts) {
  const starts = primaryLetterStarts.length < 2 ? [...primaryLetterStarts] : [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isDirectSalutationLetterStart(lines, index)) continue;
    if (primaryLetterStarts.some((start) => Math.abs(start - index) <= 7)) continue;
    if (starts.some((start) => Math.abs(start - index) <= 7)) continue;
    starts.push(index);
  }

  return sortedUniqueNumbers(starts);
}

function directMyDearSupplementStarts(lines, usedStarts) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^my\s+dear\b/i.test(lines[index] || "") || isSignatureContext(lines, index)) continue;
    if (usedStarts.some((start) => Math.abs(start - index) <= 7)) continue;
    if (starts.some((start) => Math.abs(start - index) <= 7)) continue;
    if (!lines.slice(Math.max(0, index - 12), index).some(hasDirectSalutationContext)) continue;
    starts.push(index);
  }
  return starts;
}

function directPressReleaseStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^for immediate release\b/i.test(lines[index])) starts.push(index);
  }
  return starts;
}

function directPoolReportStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^pool report\b/i.test(lines[index])) starts.push(index);
  }
  return starts;
}

function directMemoStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      /^white house staffing memorandum\b/i.test(lines[index]) ||
      /^recommended telephone call by the president\b/i.test(lines[index]) ||
      /^memorandum (?:for|to)\s+\S/i.test(lines[index])
    ) {
      starts.push(index);
    }
  }
  return starts;
}

function hasLongDate(line) {
  return /\b(January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+\d{1,2},?\s+\d{4}\b/i.test(
    line
  );
}

function isNewsContinuationDateLine(line) {
  return /--\s*A-[2-9]\b/i.test(line);
}

function isNewsEditionLine(line) {
  return /\b(edition|update|network|coverage|clips|index)\b/i.test(line);
}

function isDailyPressClippingSequence(lines, index) {
  return (
    /^the white house$/i.test(lines[index] || "") &&
    /^mrs\. bush'?s press office$/i.test(lines[index + 1] || "") &&
    /^daily press clippings\b/i.test(lines[index + 2] || "")
  );
}

function isDailyPressClippingStart(lines, index) {
  if (isDailyPressClippingSequence(lines, index)) return true;
  if (!/^daily press clippings\b/i.test(lines[index] || "")) return false;
  if (
    /^mrs\. bush'?s press office$/i.test(lines[index - 1] || "") &&
    /^the white house$/i.test(lines[index - 2] || "")
  ) {
    return false;
  }
  return (
    hasLongDate(lines[index + 1] || "") ||
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lines[index + 1] || "")
  );
}

function isNewsSummaryStart(lines, index) {
  const line = lines[index] || "";
  if (/^news summary$/i.test(line)) {
    return (
      /^office of the press secretary$/i.test(lines[index + 1] || "") &&
      /^the white house$/i.test(lines[index + 2] || "") &&
      /^washington$/i.test(lines[index + 3] || "") &&
      hasLongDate(lines[index + 4] || "")
    );
  }
  if (/^white house news summary$/i.test(line)) {
    const dateLine = lines[index + 1] || "";
    if (!hasLongDate(dateLine) || isNewsContinuationDateLine(dateLine)) return false;
    return (
      isNewsEditionLine(lines[index + 2] || "") ||
      isNewsEditionLine(lines[index + 3] || "") ||
      /^[A-Z0-9 .,'&()/-]{12,}$/.test(lines[index + 2] || "")
    );
  }
  return false;
}

function directNewsStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isDailyPressClippingStart(lines, index) || isNewsSummaryStart(lines, index)) {
      starts.push(index);
    }
  }
  return starts;
}

function isSupplementalWhiteHouseNewsSummaryStart(lines, index) {
  if (!/^white house news summary$/i.test(lines[index] || "")) return false;
  const dateLine = lines[index + 1] || "";
  const editionLine = lines[index + 2] || "";
  return (
    hasLongDate(dateLine) &&
    !isNewsContinuationDateLine(dateLine) &&
    /\b(wires|news update|edition|coverage|clips|index)\b/i.test(editionLine)
  );
}

function directNewsSupplementKind(lines, index) {
  const line = lines[index] || "";
  if (/^daily news clips\b/i.test(line)) return "daily-news-clips";
  if (/the daily briefing on american politics/i.test(line)) return "daily-political-briefing";
  if (isSupplementalWhiteHouseNewsSummaryStart(lines, index)) return "news-summary";
  return "";
}

function directNewsSupplementStarts(lines, primaryNewsStarts) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = directNewsSupplementKind(lines, index);
    if (!kind) continue;
    if (primaryNewsStarts.some((start) => Math.abs(start - index) <= 6)) continue;
    if (starts.some(({ start }) => Math.abs(start - index) <= 6)) continue;
    starts.push({ start: index, kind });
  }
  return starts;
}

function isAllCapsBriefingTitleLine(line) {
  return (
    /^[A-Z0-9 .,/&'():-]{5,}$/.test(line) &&
    /[A-Z]/.test(line) &&
    !/^(the white house|washington|date:?|time:?|location:?|from:?|through:?|to:?|subject:?|office of|classified|declassified|unclassified|confidential)$/i.test(
      line
    )
  );
}

function directEventBriefingTitleLines(lines, index) {
  if (
    !/^the white house$/i.test(lines[index] || "") ||
    !/^washington$/i.test(lines[index + 1] || "") ||
    !hasLongDate(lines[index + 2] || "")
  ) {
    return [];
  }

  const titleLines = [];
  let cursor = index + 3;
  while (cursor < Math.min(lines.length, index + 8)) {
    const line = lines[cursor] || "";
    if (/^date:?\b/i.test(line)) break;
    if (!isAllCapsBriefingTitleLine(line)) return [];
    titleLines.push(line);
    cursor += 1;
  }

  if (!titleLines.length || !/^date:?\b/i.test(lines[cursor] || "")) return [];
  const detail = lines.slice(cursor, cursor + 10).join("\n");
  if (!/(^|\n)(time|location|through|from):?\b/i.test(detail)) return [];
  return titleLines;
}

function isDirectEventBriefingStart(lines, index) {
  return Boolean(directEventBriefingTitleLines(lines, index).length);
}

function isDirectPresidentNoteStart(lines, index) {
  if (!/^the white house$/i.test(lines[index] || "")) return false;
  if (!/^washington$/i.test(lines[index + 1] || "")) return false;
  const lead = lines.slice(index + 2, index + 7).join("\n");
  return /^date:?$/im.test(lead) && /^from the president$/im.test(lead) && /^to:?$/im.test(lead);
}

function isDirectTalkingPointsStart(line) {
  return /^talking points\b/i.test(line) && !/\b(provided by|to be provided)\b/i.test(line);
}

function hasClockTime(line) {
  return /\b\d{1,2}:\d{2}\s*(?:A|P)\.?M\.?\b/i.test(line);
}

function isDirectSpeechHeadingCandidate(line) {
  if (!/^[A-Z0-9 .,/&'():\\-]{3,}$/.test(line) || !/[A-Z]/.test(line)) return false;
  if (!/[\s:&\\]/.test(line) && !/^AT&T$/i.test(line)) return false;
  if (hasLongDate(line) || hasClockTime(line)) return false;
  if (
    /^(the white house|white house staffing memorandum|action\/concurrence\/comment due by|the president|washington|date:?|time:?|location:?|from:?|through:?|to:?|subject:?|office of|classified|declassified|unclassified|confidential|bush library photocopy|the president has seen|for immediate release|contact:|embargoed|text as prepared|signal switchboard|telephone memorandum|materials forwarded to the president|mr\.|mrs\.|ms\.|honorable|and wire transmissions|white house commctr|executive office of the president|revised|end|air|for:|unp\b|gb\s*\d+|[ivx]+\.\s+|[a-z]+day,?\s+|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}:\d{2}|p\.\d+\/\d+|pg\.\d+|no\.\s*\d+|---|\d+\)?\.?$)/i.test(
      line
    ) ||
    /^(mon|tue|wed|thu|fri|sat|sun)\b.*\d{2}:\d{2}/i.test(line)
  ) {
    return false;
  }
  return true;
}

function isDirectSpeechSupplementStart(lines, index) {
  if (!isDirectSpeechHeadingCandidate(lines[index] || "")) return false;
  if (lines.slice(Math.max(0, index - 4), index).some(isDirectSpeechHeadingCandidate)) {
    return false;
  }
  if (
    lines
      .slice(Math.max(0, index - 3), index)
      .some((line) => /^bush library photocopy/i.test(line) || /^- ?\d+ ?-$/i.test(line))
  ) {
    return false;
  }

  const window = lines.slice(index, index + 14);
  if (
    /^(my\s+dear|dear|pear)\b/im.test(window.join("\n")) ||
    /\b(congress of the united states|house of representatives|longworth house office building|office of public liaison|washington office:)\b/i.test(
      window.join(" ")
    )
  ) {
    return false;
  }
  const hasOpening = window.some((line) => /^thank you\b|^presidential remarks\b|^remarks by\b/i.test(line));
  const hasEventLabels =
    window.some((line) => /^date:?\b/i.test(line)) &&
    window.some((line) => /^time:?\b/i.test(line)) &&
    window.some((line) => /^location:?\b/i.test(line));
  return window.some(hasLongDate) && (hasOpening || hasEventLabels);
}

function directSpeechSupplementStarts(lines, primaryBriefingStarts) {
  const primaryStarts = primaryBriefingStarts.map(({ start }) => start);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDirectSpeechSupplementStart(lines, index)) continue;
    if (primaryStarts.some((start) => Math.abs(start - index) <= 8)) continue;
    if (starts.some((start) => Math.abs(start - index) <= 8)) continue;
    starts.push(index);
  }
  return starts;
}

function isForwardingNoteStart(lines, index) {
  const lead = lines.slice(index, index + 12).join("\n");
  return (
    /^(walker's point|the white house|aboard air force one)$/i.test(lines[index] || "") &&
    lines.slice(index, index + 12).some((line) => normalizeAnyDate(line, "1992-01-01")) &&
    /^to:/im.test(lead)
  );
}

function isWireStoryStart(lines, index) {
  return (
    Boolean(lines[index]) &&
    /^by\s+[A-Z][A-Z .'-]+$/i.test(lines[index + 1] || "") &&
    /\b(upi|associated press|reuters|white house reporter)\b/i.test(
      lines.slice(index + 2, index + 5).join(" ")
    )
  );
}

function isPresidentialDocumentsReprintStart(lines, index) {
  return (
    /^administration of jimmy carter$/i.test(lines[index] || "") &&
    /^presidential documents$/i.test(lines[index + 1] || "") &&
    lines.slice(index + 2, index + 10).some((line) => /^address to the nation\b/i.test(line))
  );
}

function isCongressionalMonitorStart(lines, index) {
  const lead = lines.slice(index, index + 16).join(" ");
  return (
    index <= 8 &&
    /\bcongressional\b/i.test(lead) &&
    /\bmonitor\b/i.test(lead) &&
    /volume\s+\d+,\s+number\s+\d+/i.test(lead)
  );
}

function isHumanitarianBriefingStart(lines, index) {
  return (
    index <= 8 &&
    /^global humanitarian$/i.test(lines[index] || "") &&
    lines.slice(index, index + 12).some((line) => /^global humanitarian$/i.test(line)) &&
    lines.slice(index, index + 16).some((line) => /^relief efforts$/i.test(line))
  );
}

function isPresidentialDebateMapStart(lines, index) {
  const lead = lines.slice(index, index + 18).join(" ");
  return index <= 8 && /^welcome to$/i.test(lines[index] || "") && /st\.?\s*louis/i.test(lead) && /presidential debate/i.test(lead);
}

function isLetterToEditorStart(lines, index) {
  return Boolean(lines[index]) && /^to the editor:?$/i.test(lines[index + 1] || "");
}

function isHandwrittenNotesStart(lines, index) {
  return (
    /^bush library photocopy - (?:george bush|miscellaneous) handwriting$/i.test(lines[index] || "") &&
    lines.slice(index + 1, index + 8).some((line) => /^rose said$/i.test(line))
  );
}

function isHandwrittenLetterStart(lines, index) {
  const lead = lines.slice(index, index + 12).join("\n");
  return (
    /^bush library photocopy - miscellaneous handwriting$/i.test(lines[index] || "") &&
    /richard nixon/i.test(lead) &&
    /(dear|dan)\s+george/i.test(lead)
  );
}

function isCampaignTalkingPointsStart(lines, index) {
  return (
    index <= 8 &&
    /^statistics:?$/i.test(lines[index] || "") &&
    lines.slice(index, index + 90).some((line) => /^domestic accomplishments$/i.test(line))
  );
}

function isElectionNoticeStart(lines, index) {
  return (
    /^lowville,\s*n\.?y\.?,\s*november\s+3,\s+1992$/i.test(lines[index] || "") &&
    lines.slice(index, index + 10).some((line) => /recanvass of the voting machines/i.test(line))
  );
}

function directStandaloneSourceKind(lines, index) {
  if (isForwardingNoteStart(lines, index)) return "forwarding-note";
  if (isWireStoryStart(lines, index)) return "wire-story";
  if (isPresidentialDocumentsReprintStart(lines, index)) return "presidential-documents-reprint";
  if (isCongressionalMonitorStart(lines, index)) return "newsletter-issue";
  if (isHumanitarianBriefingStart(lines, index)) return "briefing-binder";
  if (isPresidentialDebateMapStart(lines, index)) return "map";
  if (isLetterToEditorStart(lines, index)) return "letter-to-editor";
  if (isHandwrittenLetterStart(lines, index)) return "handwritten-letter";
  if (isHandwrittenNotesStart(lines, index)) return "handwritten-notes";
  if (isCampaignTalkingPointsStart(lines, index)) return "campaign-talking-points";
  if (isElectionNoticeStart(lines, index)) return "election-notice";
  return "";
}

function directStandaloneSourceStarts(lines, packetDoc, usedStarts) {
  if (packetDoc.directScanDisposition !== "packet-uncertain") return [];

  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = directStandaloneSourceKind(lines, index);
    if (!kind) continue;
    if (usedStarts.some((start) => Math.abs(start - index) <= 6)) continue;
    if (starts.some(({ start }) => Math.abs(start - index) <= 6)) continue;
    starts.push({ start: index, kind });
  }
  return starts;
}

function isDirectAdministrationReportStart(lines, index) {
  return (
    /^response of the administration$/i.test(lines[index] || "") &&
    /^to issues raised/i.test(lines[index + 1] || "") &&
    lines.slice(index, index + 8).some((line) => /^transmitted to the congress$/i.test(line))
  );
}

function isDirectLegislativeIssuesUpdateStart(lines, index) {
  return (
    /^legislative issues update$/i.test(lines[index] || "") &&
    /^office of legislative affairs$/i.test(lines[index + 1] || "") &&
    lines.slice(index + 2, index + 7).some((line) => /^index$/i.test(line))
  );
}

function directBriefingKind(lines, index, seenPossibleQuestions) {
  const line = lines[index] || "";
  if (isDirectEventBriefingStart(lines, index)) return "event-briefing";
  if (isDirectPresidentNoteStart(lines, index)) return "president-note";
  if (/^schedule of the president$/i.test(line)) return "presidential-schedule";
  if (isDirectTalkingPointsStart(line)) return "talking-points";
  if (/^possible questions\b/i.test(line)) {
    const key = line.toLowerCase();
    if (seenPossibleQuestions.has(key)) return "";
    seenPossibleQuestions.add(key);
    return "possible-questions";
  }
  if (isDirectAdministrationReportStart(lines, index)) return "administration-report";
  if (isDirectLegislativeIssuesUpdateStart(lines, index)) return "legislative-issues-update";
  if (/^list of participants$/i.test(line)) return "participant-list";
  return "";
}

function directBriefingStarts(lines) {
  const starts = [];
  const seenPossibleQuestions = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const kind = directBriefingKind(lines, index, seenPossibleQuestions);
    if (kind) starts.push({ start: index, kind });
  }
  return starts;
}

function isDatePresidentNoteStart(lines, index) {
  return (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(lines[index] || "") &&
    /^mr\. president:?$/i.test(lines[index + 1] || "")
  );
}

function isFromToReBlockStart(lines, index) {
  return (
    /^from:/i.test(lines[index] || "") &&
    lines.slice(index + 1, index + 6).some((line) => /^to:/i.test(line)) &&
    lines.slice(index + 1, index + 7).some((line) => /^(re|subject):/i.test(line))
  );
}

function isGenericMemorandumBlockStart(lines, index) {
  const line = lines[index] || "";
  if (/^telephone memorandum$/i.test(line) && /^signal switchboard$/i.test(lines[index + 1] || "")) {
    return true;
  }
  return (
    /^memorandum$/i.test(line) &&
    lines.slice(index + 1, index + 7).some((candidate) => /^from:/i.test(candidate)) &&
    lines.slice(index + 1, index + 8).some((candidate) => /^(to|subj|subject):/i.test(candidate))
  );
}

function isDirectMemoSupplementStart(lines, index) {
  return (
    /^note for (?:potus|the president)\b/i.test(lines[index] || "") ||
    isDatePresidentNoteStart(lines, index) ||
    isFromToReBlockStart(lines, index) ||
    isGenericMemorandumBlockStart(lines, index)
  );
}

function directMemoSupplementStarts(lines, primaryMemoStarts) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDirectMemoSupplementStart(lines, index)) continue;
    if (primaryMemoStarts.some((start) => Math.abs(start - index) <= 6)) continue;
    if (starts.some((start) => Math.abs(start - index) <= 6)) continue;
    starts.push(index);
  }
  return starts;
}

function sortedUniqueNumbers(values) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function nextBoundaryAfter(boundaryStarts, start, fallback) {
  return boundaryStarts.find((candidate) => candidate > start) || fallback;
}

function salutationFromSegment(lines) {
  const salutation = lines.slice(0, 8).find((line) => /^(my\s+dear|dear|pear)\b/i.test(line));
  if (!salutation) return "unidentified correspondent";
  return salutation
    .replace(/^pear\b/i, "Dear")
    .replace(/\s+/g, " ")
    .replace(/[,.;:]+$/, "")
    .trim();
}

function normalizeDateLineYear(value, folderDate) {
  return String(value || "").replace(/\b(\d{4})\b/g, (yearValue) => {
    const year = Number(yearValue);
    return year < 1900 || year > 2099 ? folderDate.slice(0, 4) : yearValue;
  });
}

function documentDateFromSegment(lines, folderDate) {
  for (const line of lines.slice(0, 12)) {
    let date = normalizeAnyDate(line, folderDate);
    if (date && date >= "1900-01-01" && date <= "2099-12-31") return date;
    date = normalizeAnyDate(normalizeDateLineYear(line, folderDate), folderDate);
    if (date && date >= "1900-01-01" && date <= "2099-12-31") return date;
  }
  return folderDate;
}

function compactTitle(value, fallback) {
  const clean = normalizeWhitespace(value)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[#:\-\s]+/, "")
    .trim();
  if (!clean) return fallback;
  return clean.length > 160 ? `${clean.slice(0, 157).trim()}...` : clean;
}

function pressReleaseType(segment) {
  const lead = segment.slice(0, 12).join("\n").toLowerCase();
  if (/press briefing/.test(lead)) return "Press Briefing";
  if (/remarks by the president|address by the president/.test(lead)) return "Remarks";
  if (/statement by the press secretary/.test(lead)) return "Statement";
  return "Press Release";
}

function pressReleaseTitle(segment, typeLabel) {
  const skip = /^(for immediate release|contact:|bq'?92|office of the press secretary|the white house|washington|[a-z]+day,|january|february|march|april|may|june|july|august|september|october|november|december)/i;
  const titleLines = [];
  for (const line of segment.slice(0, 12)) {
    if (!line || skip.test(line) || normalizeAnyDate(line, "") || /^\([^)]+\)$/.test(line)) continue;
    titleLines.push(line);
    if (titleLines.length >= 3 || /[.!?]$/.test(line)) break;
  }
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function poolReportTitle(segment) {
  const titleLines = [segment[0]];
  for (const line of segment.slice(1, 5)) {
    if (normalizeAnyDate(line, "") || /^\([^)]+\)$/.test(line)) continue;
    titleLines.push(line);
    if (titleLines.length >= 2) break;
  }
  const title = compactTitle(titleLines.join(": "), "Pool Report").replace(/^pool report\b/i, "Pool Report");
  return /^Pool Report\b/.test(title) ? title : `Pool Report: ${title}`;
}

function memoKindFromStart(line) {
  if (/^white house staffing memorandum\b/i.test(line)) return "staffing";
  if (/^recommended telephone call by the president\b/i.test(line)) return "recommended-call";
  return "memorandum";
}

function directMemoType(kind) {
  if (kind === "staffing") return "White House Staffing Memorandum";
  if (kind === "recommended-call") return "Recommended Telephone Call";
  return "Memorandum";
}

function directMemoCategory(kind) {
  if (kind === "staffing") return "staffing-memorandum-item";
  if (kind === "recommended-call") return "recommended-call-item";
  return "memorandum-item";
}

function directMemoDisposition(kind) {
  if (kind === "staffing") return "itemized-staffing-memorandum";
  if (kind === "recommended-call") return "itemized-recommended-telephone-call";
  return "itemized-memorandum";
}

function isDirectMemoLabel(line) {
  return /^(action\/concurrence\/comment due by|action fyi|date|from|through|to|via|encl|purpose|background|key points|re|subj|subject|recommended by)(?::\s*.*)?$/i.test(
    line
  );
}

function isSubjectBodyStart(line) {
  return /^(i\.|ii\.|issue:|purpose\b|summary\b|discussion\b|attached\b|on\b|your\b|most\b|the attached\b|you will\b|we believe\b|as\b|below\b|in\b|tomorrow\b|personal income\b|to \()/i.test(
    line
  );
}

function isSubjectContinuation(previous, line) {
  if (!previous || isSubjectBodyStart(line)) return false;
  if (/^(by|onth|draft|remarks|note|attachment|attachments):?$/i.test(line)) return false;
  if (/^[A-Z0-9 .,'&()/:;-]+$/.test(line) && /[A-Z]/.test(line)) return true;
  return /\b(a|an|the|of|for|from|to|and|or|between|with|in|on|concerning)$/i.test(previous);
}

function linesAfterLabel(segment, label) {
  const values = [];
  const pattern = new RegExp(`^${label}:?\\s*(.*)$`, "i");

  for (let index = 0; index < segment.length; index += 1) {
    const match = segment[index].match(pattern);
    if (!match) continue;

    if (match[1]) values.push(match[1]);
    for (const line of segment.slice(index + 1)) {
      if (values.length >= 3) break;
      if (!line || isDirectMemoLabel(line)) break;
      if (values.length && !isSubjectContinuation(values[values.length - 1], line)) break;
      if (!values.length && /^(---|action fyi)$/i.test(line)) break;
      values.push(line);
    }
    break;
  }

  return values.map(cleanLine).filter(Boolean);
}

function titleCaseMemoRecipient(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bThe President\b/g, "the President")
    .replace(/\bIii\b/g, "III")
    .replace(/\bIi\b/g, "II")
    .replace(/\bH\.\b/g, "H.");
}

function memorandumHeaderTitle(value, fallback) {
  const match = value.match(/^memorandum\s+(for|to)\s+(.+)$/i);
  if (!match) return compactTitle(value, fallback);
  return `Memorandum ${match[1].toLowerCase()} ${titleCaseMemoRecipient(match[2])}`;
}

function directMemoDate(contentLines, start, folderDate) {
  for (const line of contentLines.slice(Math.max(0, start - 8), start + 12)) {
    let date = normalizeAnyDate(line, folderDate);
    if (date && date >= "1900-01-01" && date <= "2099-12-31") return date;
    date = normalizeAnyDate(normalizeDateLineYear(line, folderDate), folderDate);
    if (date && date >= "1900-01-01" && date <= "2099-12-31") return date;
  }
  return folderDate;
}

function staffingMemoTitle(segment, typeLabel) {
  const heading = [];
  for (const line of segment.slice(0, 24)) {
    const remarksIndex = line.search(/presidential remarks:/i);
    if (remarksIndex >= 0) {
      heading.push(line.slice(remarksIndex));
      continue;
    }
    if (heading.length) {
      if (isDirectMemoLabel(line) || /^(---|action fyi)$/i.test(line)) break;
      heading.push(line);
      if (heading.length >= 3) break;
    }
  }
  const subject = heading.length ? heading : linesAfterLabel(segment, "subject");
  return `${typeLabel}: ${compactTitle(subject.join(" "), typeLabel)}`;
}

function recommendedCallTitle(segment, typeLabel) {
  const recipient = linesAfterLabel(segment, "to");
  const purpose = linesAfterLabel(segment, "purpose");
  const title = recipient.length ? recipient.join(" ") : purpose.join(" ");
  return `${typeLabel}: ${compactTitle(title, typeLabel)}`;
}

function memorandumTitle(segment, typeLabel) {
  const header = memorandumHeaderTitle(segment[0], typeLabel);
  const subject = linesAfterLabel(segment, "subject").join(" ");
  return subject ? `${header}: ${compactTitle(subject, typeLabel)}` : header;
}

function directMemoTitle(segment, kind, typeLabel) {
  if (kind === "staffing") return staffingMemoTitle(segment, typeLabel);
  if (kind === "recommended-call") return recommendedCallTitle(segment, typeLabel);
  return memorandumTitle(segment, typeLabel);
}

function memoSupplementKind(segment) {
  if (/^telephone memorandum$/i.test(segment[0] || "")) return "telephone-memorandum";
  if (/^note for (?:potus|the president)\b/i.test(segment[0] || "")) return "note-for-president";
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(segment[0] || "") && /^mr\. president:?$/i.test(segment[1] || "")) {
    return "president-note";
  }
  return "routing-memorandum";
}

function directMemoSupplementType(kind) {
  if (kind === "telephone-memorandum") return "Telephone Memorandum";
  if (kind === "note-for-president" || kind === "president-note") return "Note";
  return "Memorandum";
}

function directMemoSupplementCategory(kind) {
  if (kind === "telephone-memorandum") return "telephone-memorandum-item";
  if (kind === "note-for-president" || kind === "president-note") return "note-item";
  return "memorandum-item";
}

function directMemoSupplementDisposition(kind) {
  if (kind === "telephone-memorandum") return "itemized-telephone-memorandum";
  if (kind === "note-for-president" || kind === "president-note") return "itemized-note-to-president";
  return "itemized-memorandum";
}

function firstMemoBodyLine(segment, offset = 1) {
  return (
    segment
      .slice(offset, offset + 10)
      .find(
        (line) =>
          line &&
          !isDirectMemoLabel(line) &&
          !/^(mr\. president:?|the president has seen|bush library photocopy|personal)$/i.test(line) &&
          !normalizeAnyDate(line, "")
      ) || ""
  );
}

function directMemoSupplementTitle(segment, kind, typeLabel, folderDate) {
  if (kind === "telephone-memorandum") {
    const dateLine = segment.slice(0, 6).find((line) => normalizeAnyDate(line, folderDate));
    return `${typeLabel}: ${compactTitle(dateLine || folderDate, typeLabel)}`;
  }

  if (kind === "note-for-president") {
    const subject = linesAfterLabel(segment, "subject").join(" ") || linesAfterLabel(segment, "re").join(" ");
    return `${typeLabel}: ${compactTitle(subject || segment[0], typeLabel)}`;
  }

  if (kind === "president-note") {
    return `${typeLabel} to the President: ${compactTitle(firstMemoBodyLine(segment, 2), typeLabel)}`;
  }

  const subject =
    linesAfterLabel(segment, "subj").join(" ") ||
    linesAfterLabel(segment, "subject").join(" ") ||
    linesAfterLabel(segment, "re").join(" ") ||
    linesAfterLabel(segment, "to").join(" ") ||
    linesAfterLabel(segment, "from").join(" ");
  return `${typeLabel}: ${compactTitle(subject, typeLabel)}`;
}

function newsKindFromStart(segment) {
  return isDailyPressClippingSequence(segment, 0) || /^daily press clippings\b/i.test(segment[0] || "")
    ? "daily-press-clippings"
    : "news-summary";
}

function directNewsType(kind) {
  return kind === "daily-press-clippings" ? "Daily Press Clippings" : "News Summary";
}

function directNewsCategory(kind) {
  return kind === "daily-press-clippings" ? "daily-press-clippings-item" : "news-summary-item";
}

function directNewsDisposition(kind) {
  return kind === "daily-press-clippings"
    ? "itemized-daily-press-clippings"
    : "itemized-news-summary";
}

function dailyPressClippingTitle(segment, typeLabel, folderDate) {
  const start = segment.findIndex((line) => /^daily press clippings\b/i.test(line));
  const titleLines = [];
  for (const line of segment.slice(Math.max(0, start + 1), start + 5)) {
    if (!line || /^(mrs\. bush|\(in folder\)|secretary|west wing|residence|susan porter rose)/i.test(line)) {
      break;
    }
    titleLines.push(normalizeDateLineYear(line, folderDate));
    if (hasLongDate(line)) break;
  }
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function newsSummaryTitle(segment, typeLabel, folderDate) {
  const titleLines = [];
  for (const line of segment.slice(1, 9)) {
    if (/^(office of the press secretary|the white house|washington)$/i.test(line)) continue;
    if (!titleLines.length && !hasLongDate(line)) continue;
    titleLines.push(normalizeDateLineYear(line, folderDate).replace(/\s+--\s*1\b/i, ""));
    if (titleLines.length >= 2) break;
  }
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function directNewsTitle(segment, kind, typeLabel, folderDate) {
  if (kind === "daily-press-clippings") {
    return dailyPressClippingTitle(segment, typeLabel, folderDate);
  }
  return newsSummaryTitle(segment, typeLabel, folderDate);
}

function directNewsSupplementType(kind) {
  if (kind === "daily-news-clips") return "Daily News Clips";
  if (kind === "daily-political-briefing") return "Daily Political Briefing";
  return directNewsType(kind);
}

function directNewsSupplementCategory(kind) {
  if (kind === "daily-news-clips") return "daily-news-clips-item";
  if (kind === "daily-political-briefing") return "daily-political-briefing-item";
  return directNewsCategory(kind);
}

function directNewsSupplementDisposition(kind) {
  if (kind === "daily-news-clips") return "itemized-daily-news-clips";
  if (kind === "daily-political-briefing") return "itemized-daily-political-briefing";
  return directNewsDisposition(kind);
}

function directNewsSupplementTitle(segment, kind, typeLabel, folderDate) {
  if (kind === "news-summary") return newsSummaryTitle(segment, typeLabel, folderDate);

  const dateLine = segment
    .slice(0, 10)
    .map((line) => normalizeDateLineYear(line, folderDate))
    .find((line) => normalizeAnyDate(line, folderDate) || hasLongDate(line));
  return `${typeLabel}: ${compactTitle(dateLine || folderDate, typeLabel)}`;
}

function directBriefingType(kind) {
  if (kind === "event-briefing") return "Event Briefing";
  if (kind === "president-note") return "President's Note";
  if (kind === "presidential-schedule") return "Schedule";
  if (kind === "talking-points") return "Talking Points";
  if (kind === "possible-questions") return "Possible Questions";
  if (kind === "administration-report") return "Report";
  if (kind === "legislative-issues-update") return "Legislative Issues Update";
  if (kind === "participant-list") return "Participant List";
  return "Briefing Material";
}

function directBriefingCategory(kind) {
  if (kind === "event-briefing") return "event-briefing-item";
  if (kind === "president-note") return "president-note-item";
  if (kind === "presidential-schedule") return "presidential-schedule-item";
  if (kind === "talking-points") return "talking-points-item";
  if (kind === "possible-questions") return "possible-questions-item";
  if (kind === "administration-report") return "report-item";
  if (kind === "legislative-issues-update") return "legislative-issues-update-item";
  if (kind === "participant-list") return "participant-list-item";
  return "briefing-material-item";
}

function directBriefingDisposition(kind) {
  if (kind === "event-briefing") return "itemized-event-briefing";
  if (kind === "president-note") return "itemized-president-note";
  if (kind === "presidential-schedule") return "itemized-presidential-schedule";
  if (kind === "talking-points") return "itemized-talking-points";
  if (kind === "possible-questions") return "itemized-possible-questions";
  if (kind === "administration-report") return "itemized-report";
  if (kind === "legislative-issues-update") return "itemized-legislative-issues-update";
  if (kind === "participant-list") return "itemized-participant-list";
  return "itemized-briefing-material";
}

function headingContinuationLines(segment, maxLines = 3) {
  const heading = [segment[0]];
  for (const line of segment.slice(1, maxLines)) {
    if (
      !line ||
      /^--/.test(line) ||
      /^\d+[).]/.test(line) ||
      /^(date|time|location|through|from|to|i\.|ii\.|overview|index):?\b/i.test(line)
    ) {
      break;
    }
    if (!isAllCapsBriefingTitleLine(line)) break;
    heading.push(line);
  }
  return heading;
}

function directEventBriefingTitle(segment, typeLabel) {
  const titleLines = directEventBriefingTitleLines(segment, 0);
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function directPresidentNoteTitle(segment, typeLabel) {
  const toIndex = segment.findIndex((line) => /^to:?$/i.test(line));
  const recipient = toIndex >= 0 ? segment[toIndex + 1] : "";
  const title = recipient ? `To ${titleCaseMemoRecipient(recipient)}` : "";
  return `${typeLabel}: ${compactTitle(title, typeLabel)}`;
}

function directBriefingReportTitle(segment, typeLabel) {
  const heading = [segment[0]];
  for (const line of segment.slice(1, 5)) {
    if (/^(transmitted to the congress|by the president|on\b|overview|index)$/i.test(line)) break;
    heading.push(line);
  }
  return `${typeLabel}: ${compactTitle(heading.join(" "), typeLabel)}`;
}

function directBriefingTitle(segment, kind, typeLabel, folderDate) {
  if (kind === "event-briefing") return directEventBriefingTitle(segment, typeLabel);
  if (kind === "president-note") return directPresidentNoteTitle(segment, typeLabel);
  if (kind === "presidential-schedule") {
    const scheduleDate = normalizeDateLineYear(segment[1] || folderDate, folderDate);
    return `${typeLabel}: ${compactTitle(scheduleDate, typeLabel)}`;
  }
  if (kind === "talking-points") {
    return `${typeLabel}: ${compactTitle(headingContinuationLines(segment).join(" "), typeLabel)}`;
  }
  if (kind === "possible-questions") return `${typeLabel}: ${compactTitle(segment[0], typeLabel)}`;
  if (kind === "administration-report") return directBriefingReportTitle(segment, typeLabel);
  if (kind === "legislative-issues-update") return typeLabel;
  if (kind === "participant-list") return typeLabel;
  return `${typeLabel}: ${compactTitle(segment[0], typeLabel)}`;
}

function isSpeechSupplementAllowedPacket(packetDoc) {
  return ["speech-material", "direct-scan", "event-packet", "memorandum-packet"].includes(
    packetDoc.directScanCategory
  );
}

function speechSupplementHeading(segment) {
  const heading = [];
  for (const rawLine of segment.slice(0, 8)) {
    const line = rawLine.replace(/^[\\|/.,\s]+/, "").trim();
    if (!line || /^bush library photocopy/i.test(line) || /^thank you\b/i.test(line)) break;
    if (/^\d+$/.test(line)) continue;
    if (heading.length && /^- ?\d+ ?-$/.test(line)) break;
    if (isDirectSpeechHeadingCandidate(line) || hasLongDate(line) || hasClockTime(line)) {
      heading.push(normalizeDateLineYear(line, ""));
    }
    if (heading.length >= 4) break;
  }
  return heading;
}

function segmentHasSpeechOpening(segment) {
  return segment.slice(0, 14).some((line) => /^thank you\b|^presidential remarks\b|^remarks by\b/i.test(line));
}

function segmentHasEventLabels(segment) {
  const lead = segment.slice(0, 18);
  return (
    lead.some((line) => /^date:?\b/i.test(line)) &&
    lead.some((line) => /^time:?\b/i.test(line)) &&
    lead.some((line) => /^location:?\b/i.test(line))
  );
}

function speechSupplementMaterialKind(segment) {
  return segmentHasEventLabels(segment) && !segmentHasSpeechOpening(segment)
    ? "event-briefing"
    : "speech-remarks-draft";
}

function speechSupplementType(kind) {
  return kind === "event-briefing" ? "Event Briefing" : "Speech/Remarks Draft";
}

function speechSupplementCategory(kind) {
  return kind === "event-briefing" ? "event-briefing-item" : "speech-remarks-item";
}

function speechSupplementDisposition(kind) {
  return kind === "event-briefing" ? "itemized-event-briefing" : "itemized-speech-remarks-draft";
}

function speechSupplementTitle(segment, typeLabel) {
  const heading = speechSupplementHeading(segment);
  return `${typeLabel}: ${compactTitle(heading.join(" "), typeLabel)}`;
}

function standaloneSourceType(kind) {
  const types = {
    "forwarding-note": "Forwarding Note",
    "wire-story": "Wire Story",
    "presidential-documents-reprint": "Presidential Documents Reprint",
    "newsletter-issue": "Newsletter Issue",
    "briefing-binder": "Briefing Binder",
    map: "Map",
    "letter-to-editor": "Letter to the Editor",
    "handwritten-letter": "Letter",
    "handwritten-notes": "Handwritten Notes",
    "campaign-talking-points": "Campaign Talking Points",
    "election-notice": "Election Notice",
  };
  return types[kind] || "Document";
}

function standaloneSourceCategory(kind) {
  const categories = {
    "forwarding-note": "forwarding-note-item",
    "wire-story": "wire-story-item",
    "presidential-documents-reprint": "presidential-documents-reprint-item",
    "newsletter-issue": "newsletter-issue-item",
    "briefing-binder": "briefing-binder-item",
    map: "map-item",
    "letter-to-editor": "letter-to-editor-item",
    "handwritten-letter": "letter-item",
    "handwritten-notes": "handwritten-notes-item",
    "campaign-talking-points": "campaign-talking-points-item",
    "election-notice": "election-notice-item",
  };
  return categories[kind] || "document-item";
}

function standaloneSourceDisposition(kind) {
  const dispositions = {
    "forwarding-note": "itemized-forwarding-note",
    "wire-story": "itemized-wire-story",
    "presidential-documents-reprint": "itemized-presidential-documents-reprint",
    "newsletter-issue": "itemized-newsletter-issue",
    "briefing-binder": "itemized-briefing-binder",
    map: "itemized-map",
    "letter-to-editor": "itemized-letter-to-editor",
    "handwritten-letter": "itemized-correspondence-letter",
    "handwritten-notes": "itemized-handwritten-notes",
    "campaign-talking-points": "itemized-campaign-talking-points",
    "election-notice": "itemized-election-notice",
  };
  return dispositions[kind] || "itemized-document";
}

function forwardingNoteTitle(segment, typeLabel) {
  const dateLine = segment.slice(0, 8).find((line) => normalizeAnyDate(line, "1992-01-01")) || "";
  const recipient = linesAfterLabel(segment, "to").join(" ");
  const title = [dateLine, recipient ? `to ${recipient}` : ""].filter(Boolean).join(" ");
  return `${typeLabel}: ${compactTitle(title, typeLabel)}`;
}

function wireStoryTitle(segment, typeLabel) {
  const titleLine = segment[0] || "";
  const byline = /^by\b/i.test(segment[1] || "") ? segment[1] : "";
  return `${typeLabel}: ${compactTitle([titleLine, byline].filter(Boolean).join(" "), typeLabel)}`;
}

function presidentialDocumentsReprintTitle(segment, typeLabel) {
  const subject =
    segment.find((line) => /^energy and national goals$/i.test(line)) ||
    segment.find((line) => /^address to the nation\b/i.test(line)) ||
    segment[0];
  const dateLine = segment.find((line) => /^address to the nation\.\s+/i.test(line)) || "";
  return `${typeLabel}: ${compactTitle([subject, dateLine].filter(Boolean).join(" "), typeLabel)}`;
}

function newsletterIssueTitle(segment, typeLabel) {
  const volumeLine = segment.find((line) => /volume\s+\d+,\s+number\s+\d+/i.test(line)) || "";
  return `${typeLabel}: ${compactTitle(["Congressional Monitor", volumeLine].filter(Boolean).join(" "), typeLabel)}`;
}

function briefingBinderTitle(segment, typeLabel) {
  const titleLines = [];
  for (const line of segment.slice(0, 14)) {
    if (/^(department|dep of defense|fema|united states of america)$/i.test(line)) continue;
    if (/^(global humanitarian|relief efforts|dod humanitarian operations)$/i.test(line)) {
      titleLines.push(line);
    }
  }
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function mapTitle(segment, typeLabel) {
  const titleLines = segment
    .slice(0, 18)
    .filter((line) => /welcome to|st\.?\s*louis|presidential debate/i.test(line));
  return `${typeLabel}: ${compactTitle(titleLines.join(" "), typeLabel)}`;
}

function handwrittenLetterTitle(segment, typeLabel) {
  const sender = segment.find((line) => /^richard nixon$/i.test(line)) || "";
  const dateLine = segment.find((line) => normalizeAnyDate(line, "1993-01-01")) || "";
  const salutation = segment.find((line) => /^(dear|dan)\s+george/i.test(line)) || "";
  return `${typeLabel}: ${compactTitle([sender, dateLine, salutation].filter(Boolean).join(" "), typeLabel)}`;
}

function handwrittenNotesTitle(segment, typeLabel) {
  const firstLine = firstMemoBodyLine(segment, 1);
  return `${typeLabel}: ${compactTitle(firstLine, typeLabel)}`;
}

function campaignTalkingPointsTitle(segment, typeLabel) {
  const headings = segment
    .slice(0, 120)
    .filter((line) => /^(statistics:?|domestic accomplishments|agenda for american renewal)$/i.test(line));
  return `${typeLabel}: ${compactTitle(headings.join(" / "), typeLabel)}`;
}

function electionNoticeTitle(segment, typeLabel) {
  const placeDate = segment[0] || "";
  const board = segment.find((line) => /board of elections/i.test(line)) || "";
  return `${typeLabel}: ${compactTitle([placeDate, board].filter(Boolean).join(" "), typeLabel)}`;
}

function standaloneSourceTitle(segment, kind, typeLabel) {
  if (kind === "forwarding-note") return forwardingNoteTitle(segment, typeLabel);
  if (kind === "wire-story") return wireStoryTitle(segment, typeLabel);
  if (kind === "presidential-documents-reprint") return presidentialDocumentsReprintTitle(segment, typeLabel);
  if (kind === "newsletter-issue") return newsletterIssueTitle(segment, typeLabel);
  if (kind === "briefing-binder") return briefingBinderTitle(segment, typeLabel);
  if (kind === "map") return mapTitle(segment, typeLabel);
  if (kind === "letter-to-editor") return `${typeLabel}: ${compactTitle(segment[0], typeLabel)}`;
  if (kind === "handwritten-letter") return handwrittenLetterTitle(segment, typeLabel);
  if (kind === "handwritten-notes") return handwrittenNotesTitle(segment, typeLabel);
  if (kind === "campaign-talking-points") return campaignTalkingPointsTitle(segment, typeLabel);
  if (kind === "election-notice") return electionNoticeTitle(segment, typeLabel);
  return `${typeLabel}: ${compactTitle(segment[0], typeLabel)}`;
}

function buildDirectLetterDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!["packet-correspondence", "packet-memorandum-material"].includes(packetDoc.directScanDisposition)) {
    return [];
  }

  if (starts.length < 2) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 6 || !hasSalutation(segment, 0, 8)) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const salutation = salutationFromSegment(segment);
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const title = `Letter: ${salutation}`;

      return {
        id: `${folder.id}-direct-letter-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-L${itemLabel}`,
        documentType: "Letter",
        directScanCategory: "letter-item",
        directScanDisposition: "itemized-correspondence-letter",
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from repeated presidential correspondence markers in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using repeated letterhead and salutation markers.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectCorrespondenceSupplementDocuments(
  contentLines,
  folder,
  packetDoc,
  starts,
  boundaryStarts
) {
  if (
    !["packet-correspondence", "packet-memorandum-material", "packet-uncertain"].includes(
      packetDoc.directScanDisposition
    )
  ) {
    return [];
  }

  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 4 || !hasSupplementalSalutation(segment, 0, 8)) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const salutation = salutationFromSegment(segment);
      const seenDate = folder.date;
      const dateWindow = contentLines.slice(Math.max(0, start - 8), end);
      const documentDate = documentDateFromSegment(dateWindow, folder.date);
      const title = `Letter: ${salutation}`;

      return {
        id: `${folder.id}-direct-correspondence-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-C${itemLabel}`,
        documentType: "Letter",
        directScanCategory: "letter-item",
        directScanDisposition: "itemized-correspondence-letter",
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a single letterhead/salutation or standalone salutation marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a single letterhead/salutation or standalone salutation marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan correspondence supplement item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectMyDearSupplementDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (
    !["packet-correspondence", "packet-memorandum-material", "packet-uncertain"].includes(
      packetDoc.directScanDisposition
    )
  ) {
    return [];
  }

  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 4 || !hasSupplementalSalutation(segment, 0, 8)) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const salutation = salutationFromSegment(segment);
      const seenDate = folder.date;
      const dateWindow = contentLines.slice(Math.max(0, start - 8), end);
      const documentDate = documentDateFromSegment(dateWindow, folder.date);
      const title = `Letter: ${salutation}`;

      return {
        id: `${folder.id}-direct-my-dear-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-MD${itemLabel}`,
        documentType: "Letter",
        directScanCategory: "letter-item",
        directScanDisposition: "itemized-correspondence-letter",
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a My dear salutation marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence: "Itemized from NARA direct folder scan OCR using a My dear salutation marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan My dear correspondence item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectPressReleaseDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 4) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const typeLabel = pressReleaseType(segment);
      const title = pressReleaseTitle(segment, typeLabel);

      return {
        id: `${folder.id}-direct-press-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-P${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: "press-release-item",
        directScanDisposition: "itemized-press-release",
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a For Immediate Release marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a For Immediate Release marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan press item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectMemoDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 4) return null;
      const kind = memoKindFromStart(segment[0]);
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = directMemoDate(contentLines, start, folder.date);
      const typeLabel = directMemoType(kind);
      const title = directMemoTitle(segment, kind, typeLabel);

      return {
        id: `${folder.id}-direct-memo-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-M${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: directMemoCategory(kind),
        directScanDisposition: directMemoDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from an explicit memorandum header in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence: "Itemized from NARA direct folder scan OCR using a memorandum header.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan memorandum item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectMemoSupplementDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 3) return null;
      const kind = memoSupplementKind(segment);
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = directMemoDate(contentLines, start, folder.date);
      const typeLabel = directMemoSupplementType(kind);
      const title = directMemoSupplementTitle(segment, kind, typeLabel, folder.date);

      return {
        id: `${folder.id}-direct-memo-supplement-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-MS${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: directMemoSupplementCategory(kind),
        directScanDisposition: directMemoSupplementDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a note, routing memorandum, or telephone-memorandum marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a note, routing memorandum, or telephone-memorandum marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan memo supplement item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectNewsDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 5) return null;
      const kind = newsKindFromStart(segment);
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const typeLabel = directNewsType(kind);
      const title = directNewsTitle(segment, kind, typeLabel, folder.date);

      return {
        id: `${folder.id}-direct-news-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-N${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: directNewsCategory(kind),
        directScanDisposition: directNewsDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from an explicit news-summary or daily-press-clippings header in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a news-summary or daily-press-clippings header.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan news item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectNewsSupplementDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map(({ start, kind }, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 5) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(contentLines.slice(Math.max(0, start - 8), end), folder.date);
      const typeLabel = directNewsSupplementType(kind);
      const title = directNewsSupplementTitle(segment, kind, typeLabel, folder.date);

      return {
        id: `${folder.id}-direct-news-supplement-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-NS${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: directNewsSupplementCategory(kind),
        directScanDisposition: directNewsSupplementDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a supplemental news, daily-clips, or political-briefing header in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a supplemental news, daily-clips, or political-briefing header.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan news supplement item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectBriefingDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map(({ start, kind }, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 4) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const typeLabel = directBriefingType(kind);
      const title = directBriefingTitle(segment, kind, typeLabel, folder.date);

      return {
        id: `${folder.id}-direct-briefing-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-B${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: directBriefingCategory(kind),
        directScanDisposition: directBriefingDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from an explicit briefing, schedule, report, or presidential-note marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using an explicit briefing, schedule, report, or presidential-note marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan briefing/material item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectSpeechSupplementDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length || !isSpeechSupplementAllowedPacket(packetDoc)) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 5) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const kind = speechSupplementMaterialKind(segment);
      const typeLabel = speechSupplementType(kind);
      const title = speechSupplementTitle(segment, typeLabel);

      return {
        id: `${folder.id}-direct-speech-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-S${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: speechSupplementCategory(kind),
        directScanDisposition: speechSupplementDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from an unheaded speech, remarks, or event-briefing heading in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using an unheaded speech, remarks, or event-briefing heading.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan speech/remarks item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectStandaloneSourceDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map(({ start, kind }, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 2) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const typeLabel = standaloneSourceType(kind);
      const title = standaloneSourceTitle(segment, kind, typeLabel);

      return {
        id: `${folder.id}-direct-source-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-X${itemLabel}`,
        documentType: typeLabel,
        directScanCategory: standaloneSourceCategory(kind),
        directScanDisposition: standaloneSourceDisposition(kind),
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a standalone source marker in an uncertain direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence:
          "Itemized from NARA direct folder scan OCR using a standalone source marker such as a wire-story, binder, map, letter, or issue heading.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan standalone source item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectPoolReportDocuments(contentLines, folder, packetDoc, starts, boundaryStarts) {
  if (!starts.length) return [];

  return starts
    .map((start, index) => {
      const end = nextBoundaryAfter(boundaryStarts, start, contentLines.length);
      const segment = contentLines.slice(start, end);
      if (segment.length < 5) return null;
      const itemNumber = index + 1;
      const itemLabel = String(itemNumber).padStart(2, "0");
      const seenDate = folder.date;
      const documentDate = documentDateFromSegment(segment, folder.date);
      const title = poolReportTitle(segment);

      return {
        id: `${folder.id}-direct-pool-${itemLabel}`,
        folderId: folder.id,
        folderNaId: folder.naId,
        folderTitle: folder.title,
        folderDate: folder.date,
        folderLocalId: folder.localId,
        folderContainerId: folder.containerId,
        catalogUrl: folder.catalogUrl,
        pdfUrl: folder.pdfUrl || "",
        chapterId: folder.chapterId,
        chapter: folder.chapter,
        themes: folder.themes,
        searchTerms: folder.searchTerms,
        documentNumber: `Direct-R${itemLabel}`,
        documentType: "Pool Report",
        directScanCategory: "pool-report-item",
        directScanDisposition: "itemized-pool-report",
        directScanItemizationStatus: "itemized-document",
        directScanItemizationNote:
          "Itemized from a pool-report marker in a direct folder scan.",
        parentPacketId: packetDoc.id,
        title,
        date: seenDate,
        seenDate,
        documentDate,
        year: seenDate.slice(0, 4),
        month: seenDate.slice(0, 7),
        pages: null,
        restriction: "",
        classification: "",
        excerpt: excerptFromLines(segment),
        evidence: "Itemized from NARA direct folder scan OCR using a pool-report marker.",
        evidenceStatus: "direct-scan-itemized",
        needsItemization: false,
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct scan pool report item ${itemLabel}, ${title}, National Archives Catalog NAID ${folder.naId}.`,
      };
    })
    .filter(Boolean);
}

function buildDirectScanDocument(text, folder) {
  const contentLines = contentLinesFromText(text);
  if (!contentLines.length) return null;

  const category = classifyDirectScan(folder, contentLines);
  const itemization = classifyDirectScanItemization(folder, category, contentLines);
  const typeLabel =
    itemization.documentType || DIRECT_SCAN_TYPES[category] || DIRECT_SCAN_TYPES["direct-scan"];
  const seenDate = folder.date;

  return {
    id: `${folder.id}-direct-scan`,
    folderId: folder.id,
    folderNaId: folder.naId,
    folderTitle: folder.title,
    folderDate: folder.date,
    folderLocalId: folder.localId,
    folderContainerId: folder.containerId,
    catalogUrl: folder.catalogUrl,
    pdfUrl: folder.pdfUrl || "",
    chapterId: folder.chapterId,
    chapter: folder.chapter,
    themes: folder.themes,
    searchTerms: folder.searchTerms,
    documentNumber: "Direct",
    documentType: typeLabel,
    directScanCategory: category,
    directScanDisposition: itemization.disposition,
    directScanItemizationStatus: itemization.status,
    directScanItemizationNote: itemization.note,
    title: directScanTitle(folder, typeLabel),
    date: seenDate,
    seenDate,
    documentDate: seenDate,
    year: seenDate.slice(0, 4),
    month: seenDate.slice(0, 7),
    pages: null,
    restriction: "",
    classification: "",
    excerpt: excerptFromLines(contentLines),
    evidence:
      "Directly digitized in the NARA folder OCR; no numbered withdrawal/redaction-sheet rows were parsed.",
    evidenceStatus: "direct-folder-scan",
    needsItemization: itemization.status !== "single-document",
    citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct folder scan, National Archives Catalog NAID ${folder.naId}.`,
  };
}

function buildDirectScanDocuments(text, folder) {
  const contentLines = contentLinesFromText(text);
  const packetDoc = buildDirectScanDocument(text, folder);
  if (!packetDoc) return [];
  const letterStarts = packetDoc.needsItemization ? directLetterStarts(contentLines) : [];
  const correspondenceSupplementStarts = packetDoc.needsItemization
    ? directCorrespondenceSupplementStarts(contentLines, letterStarts)
    : [];
  const myDearSupplementStarts = packetDoc.needsItemization
    ? directMyDearSupplementStarts(contentLines, [...letterStarts, ...correspondenceSupplementStarts])
    : [];
  const pressReleaseStarts = packetDoc.needsItemization ? directPressReleaseStarts(contentLines) : [];
  const poolReportStarts = packetDoc.needsItemization ? directPoolReportStarts(contentLines) : [];
  const memoStarts = packetDoc.needsItemization ? directMemoStarts(contentLines) : [];
  const memoSupplementStarts = packetDoc.needsItemization
    ? directMemoSupplementStarts(contentLines, memoStarts)
    : [];
  const newsStarts = packetDoc.needsItemization ? directNewsStarts(contentLines) : [];
  const newsSupplementStarts = packetDoc.needsItemization
    ? directNewsSupplementStarts(contentLines, newsStarts)
    : [];
  const briefingStarts = packetDoc.needsItemization ? directBriefingStarts(contentLines) : [];
  const speechSupplementStarts = packetDoc.needsItemization
    ? directSpeechSupplementStarts(contentLines, briefingStarts)
    : [];
  const usedStartsBeforeStandalone = sortedUniqueNumbers([
    ...letterStarts,
    ...correspondenceSupplementStarts,
    ...myDearSupplementStarts,
    ...pressReleaseStarts,
    ...poolReportStarts,
    ...memoStarts,
    ...memoSupplementStarts,
    ...newsStarts,
    ...newsSupplementStarts.map(({ start }) => start),
    ...briefingStarts.map(({ start }) => start),
    ...speechSupplementStarts,
  ]);
  const standaloneSourceStarts = packetDoc.needsItemization
    ? directStandaloneSourceStarts(contentLines, packetDoc, usedStartsBeforeStandalone)
    : [];
  const boundaryStarts = sortedUniqueNumbers([
    ...usedStartsBeforeStandalone,
    ...standaloneSourceStarts.map(({ start }) => start),
  ]);
  const speechSupplementStartSet = new Set(speechSupplementStarts);
  const memoBoundaryStarts = boundaryStarts.filter((start) => !speechSupplementStartSet.has(start));
  const itemizedDocs = packetDoc.needsItemization
    ? [
        ...buildDirectLetterDocuments(contentLines, folder, packetDoc, letterStarts, boundaryStarts),
        ...buildDirectCorrespondenceSupplementDocuments(
          contentLines,
          folder,
          packetDoc,
          correspondenceSupplementStarts,
          boundaryStarts
        ),
        ...buildDirectMyDearSupplementDocuments(
          contentLines,
          folder,
          packetDoc,
          myDearSupplementStarts,
          boundaryStarts
        ),
        ...buildDirectMemoDocuments(contentLines, folder, packetDoc, memoStarts, memoBoundaryStarts),
        ...buildDirectMemoSupplementDocuments(
          contentLines,
          folder,
          packetDoc,
          memoSupplementStarts,
          memoBoundaryStarts
        ),
        ...buildDirectNewsDocuments(contentLines, folder, packetDoc, newsStarts, boundaryStarts),
        ...buildDirectNewsSupplementDocuments(
          contentLines,
          folder,
          packetDoc,
          newsSupplementStarts,
          boundaryStarts
        ),
        ...buildDirectBriefingDocuments(
          contentLines,
          folder,
          packetDoc,
          briefingStarts,
          boundaryStarts
        ),
        ...buildDirectSpeechSupplementDocuments(
          contentLines,
          folder,
          packetDoc,
          speechSupplementStarts,
          boundaryStarts
        ),
        ...buildDirectStandaloneSourceDocuments(
          contentLines,
          folder,
          packetDoc,
          standaloneSourceStarts,
          boundaryStarts
        ),
        ...buildDirectSupplementalItemDocuments(folder, packetDoc),
        ...buildDirectPressReleaseDocuments(
          contentLines,
          folder,
          packetDoc,
          pressReleaseStarts,
          boundaryStarts
        ),
        ...buildDirectPoolReportDocuments(contentLines, folder, packetDoc, poolReportStarts, boundaryStarts),
      ]
    : [];
  return [packetDoc, ...itemizedDocs];
}

function extractRecord(json) {
  return json?.body?.hits?.hits?.[0]?._source?.record || null;
}

async function worker(queue, folders, results) {
  while (queue.length) {
    const index = queue.shift();
    const folder = folders[index];
    const json = await fetchCatalogRecord(folder);
    const record = extractRecord(json);
    const object = record?.digitalObjects?.[0] || {};
    const text = object.extractedText || "";
    const enrichedFolder = {
      ...folder,
      title: record?.title || folder.title,
      pdfUrl: object.objectUrl || "",
    };
    const redactionSheetDocs = text ? parseDocumentsFromText(text, enrichedFolder) : [];
    const directScanDocs =
      text && !redactionSheetDocs.length ? buildDirectScanDocuments(text, enrichedFolder) : [];
    const docs = redactionSheetDocs.length ? redactionSheetDocs : directScanDocs;
    results[index] = {
      folder: enrichedFolder,
      documentCount: docs.length,
      redactionSheetDocumentCount: redactionSheetDocs.length,
      directFolderScanCount: directScanDocs.length ? 1 : 0,
      hasExtractedText: Boolean(text),
      documents: docs,
    };
    process.stdout.write(`Parsed ${index + 1}/${folders.length}: ${docs.length} docs\r`);
  }
}

async function main() {
  const dailyData = decodeDailyFiles(await readFile(DAILY_FILE_DATA, "utf8"));
  const folders = dailyData.records
    .filter((record) => record.date >= RANGE_START && record.date <= RANGE_END)
    .slice(0, LIMIT || undefined);
  const queue = folders.map((_, index) => index);
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, folders.length) }, () =>
      worker(queue, folders, results)
    )
  );
  process.stdout.write("\n");

  const parsedFolders = results.filter(Boolean);
  const documents = parsedFolders.flatMap((entry) => entry.documents).sort((a, b) =>
    a.date === b.date
      ? (a.documentNumber || "").localeCompare(b.documentNumber || "", undefined, { numeric: true })
      : a.date.localeCompare(b.date)
  );
  const foldersWithNoText = parsedFolders.filter((entry) => !entry.hasExtractedText).length;
  const foldersWithoutParsedRows = parsedFolders.filter(
    (entry) => entry.hasExtractedText && entry.redactionSheetDocumentCount === 0
  ).length;
  const foldersStillUnrepresented = parsedFolders.filter(
    (entry) => entry.hasExtractedText && entry.documentCount === 0
  ).length;
  const redactionSheetDocumentCount = parsedFolders.reduce(
    (sum, entry) => sum + entry.redactionSheetDocumentCount,
    0
  );
  const directFolderScanCount = parsedFolders.reduce(
    (sum, entry) => sum + entry.directFolderScanCount,
    0
  );
  const directScanCategoryCounts = documents
    .filter((doc) => doc.evidenceStatus === "direct-folder-scan")
    .reduce((acc, doc) => {
      acc[doc.directScanCategory] = (acc[doc.directScanCategory] || 0) + 1;
      return acc;
    }, {});
  const directScanDispositionCounts = documents
    .filter((doc) => doc.evidenceStatus === "direct-folder-scan")
    .reduce((acc, doc) => {
      acc[doc.directScanDisposition] = (acc[doc.directScanDisposition] || 0) + 1;
      return acc;
    }, {});
  const directSingleDocumentScanCount = documents.filter(
    (doc) =>
      doc.evidenceStatus === "direct-folder-scan" &&
      doc.directScanItemizationStatus === "single-document"
  ).length;
  const directPacketScanCount = directFolderScanCount - directSingleDocumentScanCount;
  const directItemizedDocumentCount = documents.filter(
    (doc) => doc.evidenceStatus === "direct-scan-itemized"
  ).length;
  const directItemizedFolderCount = new Set(
    documents
      .filter((doc) => doc.evidenceStatus === "direct-scan-itemized")
      .map((doc) => doc.folderId)
  ).size;

  const payload = {
    metadata: {
      title: "Hang In: Documents Listed in the Presidential Daily Files",
      generatedAt: new Date().toISOString(),
      dateRange: `${RANGE_START}/${RANGE_END}`,
      folderCount: parsedFolders.length,
      documentCount: documents.length,
      redactionSheetDocumentCount,
      directFolderScanCount,
      directSingleDocumentScanCount,
      directPacketScanCount,
      directItemizedDocumentCount,
      directItemizedFolderCount,
      foldersWithNoText,
      foldersWithoutParsedRows,
      foldersStillUnrepresented,
      foldersWithNoDocuments: foldersWithoutParsedRows,
      directScanCategoryCounts,
      directScanDispositionCounts,
      coverageNote:
        "Document records include numbered NARA withdrawal/redaction-sheet rows plus direct scans when OCR contains source material but no parsable numbered rows. Direct scans are marked as either single-document scans or packet scans needing item-level review; high-confidence OCR markers inside packet scans are added as itemized child records while packet placeholders remain for residual audit.",
      source: "NARA Catalog proxy records with digital object extracted text.",
    },
    folders: parsedFolders.map(
      ({
        folder,
        documentCount,
        redactionSheetDocumentCount,
        directFolderScanCount,
        hasExtractedText,
      }) => ({
        ...folder,
        documentCount,
        redactionSheetDocumentCount,
        directFolderScanCount,
        hasExtractedText,
      })
    ),
    documents,
  };

  await mkdir("assets/data", { recursive: true });
  await writeFile(
    OUTFILE,
    `window.HANG_IN_SEEN_DOCUMENTS = ${JSON.stringify(payload, null, 2)};\n`
  );
  console.log(`Wrote ${documents.length} documents from ${parsedFolders.length} folders to ${OUTFILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
