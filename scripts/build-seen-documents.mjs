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
  const match = normalizeWhitespace(value).match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (!match) return "";
  const month = MONTHS.get(match[1].toLowerCase().replace(/\.$/, ""));
  const day = Number(match[2]);
  const year = Number(match[3]);
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

function sortedUniqueNumbers(values) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function nextBoundaryAfter(boundaryStarts, start, fallback) {
  return boundaryStarts.find((candidate) => candidate > start) || fallback;
}

function salutationFromSegment(lines) {
  const salutation = lines.slice(0, 8).find((line) => /^(dear|pear)\b/i.test(line));
  if (!salutation) return "unidentified correspondent";
  return salutation
    .replace(/^pear\b/i, "Dear")
    .replace(/\s+/g, " ")
    .replace(/[,.;:]+$/, "")
    .trim();
}

function documentDateFromSegment(lines, folderDate) {
  for (const line of lines.slice(0, 12)) {
    const date = normalizeAnyDate(line, folderDate);
    if (date) return date;
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
  return /^(action\/concurrence\/comment due by|action fyi|date|from|through|to|purpose|background|key points|subject|recommended by):?$/i.test(
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
    const date = normalizeAnyDate(line, folderDate);
    if (date) return date;
  }
  return folderDate;
}

function staffingMemoTitle(segment, typeLabel) {
  const heading = [];
  for (const line of segment.slice(0, 12)) {
    if (/^presidential remarks:/i.test(line)) {
      heading.push(line);
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
  const pressReleaseStarts = packetDoc.needsItemization ? directPressReleaseStarts(contentLines) : [];
  const poolReportStarts = packetDoc.needsItemization ? directPoolReportStarts(contentLines) : [];
  const memoStarts = packetDoc.needsItemization ? directMemoStarts(contentLines) : [];
  const boundaryStarts = sortedUniqueNumbers([
    ...letterStarts,
    ...pressReleaseStarts,
    ...poolReportStarts,
    ...memoStarts,
  ]);
  const itemizedDocs = packetDoc.needsItemization
    ? [
        ...buildDirectLetterDocuments(contentLines, folder, packetDoc, letterStarts, boundaryStarts),
        ...buildDirectMemoDocuments(contentLines, folder, packetDoc, memoStarts, boundaryStarts),
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
