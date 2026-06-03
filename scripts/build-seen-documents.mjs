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
  470417059: [
    {
      slug: "front-folder-flap-handwritten-dilemma-note",
      documentType: "Folder-Flap Handwritten Note",
      category: "folder-flap-note",
      disposition: "itemized-folder-flap-note",
      title: "Front-folder-flap handwritten note: Dilemma",
      documentDate: "",
      pages: 1,
      excerpt:
        "A post-it note originally located on the front folder flap carries a brief handwritten Dilemma notation.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using the post-it note, handwritten folder-flap location note, OCR, and rendered-page review.",
    },
    {
      slug: "upi-helen-thomas-bush-aggression-defeated-war-over",
      documentType: "Wire Story",
      category: "joint-session-address-wire-story",
      disposition: "itemized-wire-story",
      title: "UPI Wire Story by Helen Thomas: Bush says aggression is defeated; the war is over",
      documentDate: "1991-03-06",
      pages: 1,
      excerpt:
        "Helen Thomas reports for UPI on President Bush declaring allied victory and the end of the Persian Gulf War in his joint-session address.",
      evidence:
        "Itemized from page 3 of the NARA direct folder scan using the UPI complete writethru heading, Helen Thomas byline, OCR, and rendered-page review.",
    },
    {
      slug: "upi-thomas-ferraro-bush-speech-pows-abused",
      documentType: "Wire Story",
      category: "joint-session-address-wire-story",
      disposition: "itemized-wire-story",
      title:
        "UPI Wire Story by Thomas Ferraro: Bush speech; doctors say some POWs abused by Iraqis",
      documentDate: "1991-03-06",
      pages: 1,
      excerpt:
        "Thomas Ferraro reports for UPI on President Bush's joint-session address, the return of U.S. troops from the Gulf, POW releases, and continuing Iraq developments.",
      evidence:
        "Itemized from the UPI 9:45 p.m. writethru heading and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "upi-gulf-wrapup-saddam-postwar-troubles",
      documentType: "Wire Story",
      category: "gulf-war-wrapup-wire-story",
      disposition: "itemized-wire-story",
      title: "UPI Gulf wrapup first add: Saddam's postwar troubles intensify",
      documentDate: "1991-03-06",
      pages: 1,
      excerpt:
        "A UPI Gulf wrapup first-add page reports on Saddam Hussein's postwar troubles, unrest in Iraq, missing journalists, Arab postwar cooperation, and regional security issues.",
      evidence:
        "Itemized from a UPI gulf-wrapup first-add heading and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "george-bush-review-highlights-records-note",
      documentType: "Handwritten Presidential Note",
      category: "joint-session-address-draft-note",
      disposition: "itemized-presidential-handwriting",
      title: "George Bush handwritten note re review highlights and records return",
      documentDate: "",
      pages: 1,
      excerpt:
        "A From the desk of George Bush note asks for review of highlights on the second draft and says to hold and return the material for records.",
      evidence:
        "Itemized from page 6 of the NARA direct folder scan using the From the desk of George Bush note, Bush Library handwriting marker, OCR, and rendered-page review.",
    },
    {
      slug: "march-4-8am-joint-session-address-draft",
      documentType: "Speech Draft",
      category: "joint-session-address-draft",
      disposition: "itemized-speech-draft",
      title: "Presidential Remarks: Joint Session of Congress, March 4, 1991, 8:00 a.m. draft",
      documentDate: "1991-03-04",
      pages: 10,
      excerpt:
        "McGroarty/Dooley draft of the President's joint-session address, dated March 4, 1991, 8:00 a.m., with Desert Storm victory, Gulf security, Middle East peace, and domestic-agenda language.",
      evidence:
        "Itemized from the March 4, 1991, 8:00 a.m. draft heading and full-PDF OCR page sequence in the NARA direct folder scan.",
    },
    {
      slug: "march-4-445pm-joint-session-address-marked-draft",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "joint-session-address-draft",
      disposition: "itemized-speech-draft",
      title:
        "Presidential Remarks: Joint Session of Congress, March 4, 1991, 4:45 p.m. marked draft",
      documentDate: "1991-03-04",
      pages: 10,
      excerpt:
        "McGroarty/Dooley marked draft of the joint-session address, dated March 4, 1991, 4:45 p.m., with George Bush handwriting and edits to the Desert Storm victory language.",
      evidence:
        "Itemized from the March 4, 1991, 4:45 p.m. draft heading, Bush Library handwriting marker, and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "march-6-9am-joint-session-address-draft",
      documentType: "Speech Draft",
      category: "joint-session-address-draft",
      disposition: "itemized-speech-draft",
      title: "Presidential Remarks: Joint Session of Congress, March 6, 1991, 9:00 a.m. draft",
      documentDate: "1991-03-06",
      pages: 11,
      excerpt:
        "McGroarty/Dooley March 6, 1991, 9:00 a.m. draft of the joint-session address, including mission-accomplished language and the planned troop-return celebration.",
      evidence:
        "Itemized from the March 6, 1991, 9:00 a.m. draft heading and full-PDF OCR page sequence in the NARA direct folder scan.",
    },
    {
      slug: "march-5-815pm-joint-session-address-marked-copy",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "joint-session-address-draft",
      disposition: "itemized-speech-draft",
      title:
        "Presidential Remarks: Joint Session of Congress, March 5, 1991, 8:15 p.m. marked copy",
      documentDate: "1991-03-05",
      pages: 11,
      excerpt:
        "Marked March 5, 1991, 8:15 p.m. copy of the joint-session address with George Bush handwriting across the Desert Storm, Middle East peace, and domestic-agenda sections.",
      evidence:
        "Itemized from the March 5, 1991, 8:15 p.m. draft heading, Bush Library handwriting marker, and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "march-5-815pm-joint-session-address-second-marked-copy",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "joint-session-address-draft",
      disposition: "itemized-speech-draft",
      title:
        "Presidential Remarks: Joint Session of Congress, March 5, 1991, 8:15 p.m. second marked copy",
      documentDate: "1991-03-05",
      pages: 9,
      excerpt:
        "Second marked copy or partial copy of the March 5, 1991, 8:15 p.m. joint-session address draft, with additional George Bush handwriting and line edits.",
      evidence:
        "Itemized from a second March 5, 1991, 8:15 p.m. marked draft heading and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-network-reaction",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Network Reaction to the President's Address to a Joint Session",
      documentDate: "1991-03-06",
      pages: 3,
      excerpt:
        "White House News Summary excerpts ABC, CBS, and NBC reaction to the President's March 6, 1991 joint-session address after Operation Desert Storm.",
      evidence:
        "Itemized from the White House News Summary heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ap-terence-hunt-arab-israeli-conflict",
      documentType: "Wire Story",
      category: "joint-session-address-wire-story",
      disposition: "itemized-wire-story",
      title:
        "AP Wire Story by Terence Hunt: Bush Urges Compromise in New Efforts to End Arab-Israeli Conflict",
      documentDate: "1991-03-06",
      pages: 2,
      excerpt:
        "Terence Hunt reports for AP on President Bush proclaiming an end to the Persian Gulf War and calling for compromise in new Arab-Israeli peace efforts.",
      evidence:
        "Itemized from the AP urgent wire heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ap-merrell-hartson-domestic-agenda",
      documentType: "Wire Story",
      category: "joint-session-address-wire-story",
      disposition: "itemized-wire-story",
      title: "AP Wire Story by Merrell Hartson: Bush Calls Congress for Enactment of Domestic Agenda",
      documentDate: "1991-03-06",
      pages: 1,
      excerpt:
        "Merrell Hartson reports for AP on President Bush urging Congress to speed action on anticrime, highway, energy, education, and civil-rights legislation.",
      evidence:
        "Itemized from the AP domestic-agenda wire heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "reuters-laurance-mcquillan-first-troops-home",
      documentType: "Wire Story",
      category: "joint-session-address-wire-story",
      disposition: "itemized-wire-story",
      title: "Reuters Wire Story by Laurance McQuillan: Bush says first troops coming home from Gulf within hours",
      documentDate: "1991-03-06",
      pages: 2,
      excerpt:
        "Reuters copy by Laurance McQuillan reports on Bush saying the first U.S. troops would come home within hours and outlining a postwar Middle East agenda.",
      evidence:
        "Itemized from Reuters Gulf-Bush fourth-lead wire headings and rendered page review of the NARA direct folder scan.",
    },
  ],
  470417119: [
    {
      slug: "supreme-court-justices-luncheon-cover-schedule",
      documentType: "Folder Cover and Schedule",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "Camp David Supreme Court Justices luncheon folder cover and schedule",
      documentDate: "1991-04-20",
      pages: 1,
      excerpt:
        "The folder cover identifies the Camp David Supreme Court Justices luncheon for April 20, 1991, with arrival, luncheon, and departure times.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using the folder-cover title block, OCR, and rendered-page review.",
    },
    {
      slug: "supreme-court-justices-luncheon-invitation-drafts",
      documentType: "Invitation Drafts",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "Draft invitation letters for the Camp David Supreme Court Justices luncheon",
      documentDate: "",
      pages: 2,
      excerpt:
        "Two draft invitation pages work through language for an informal Camp David outing with the present and former members of the Supreme Court.",
      evidence:
        "Itemized from pages 3-4 of the NARA direct folder scan using Camp David letterhead, draft invitation language, edits, OCR, and rendered-page review.",
    },
    {
      slug: "camp-david-chapel-dedication-acceptance-regrets-lists",
      documentType: "Acceptance and Regrets Lists",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "Camp David Chapel Dedication acceptance and regrets lists",
      documentDate: "1991-04-21",
      pages: 2,
      excerpt:
        "The lists record acceptances and regrets for directors, supporters, and other guests invited to the Camp David Chapel Dedication.",
      evidence:
        "Itemized from pages 5-6 of the NARA direct folder scan using the acceptance and regrets headings, OCR, and rendered-page review.",
    },
    {
      slug: "rehnquist-notecard-invitation-instruction",
      documentType: "Invitation Instruction",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "Instruction to put Supreme Court Justices luncheon invitation on Camp David notecards",
      documentDate: "1991-04-20",
      pages: 1,
      excerpt:
        "A staff instruction asks that the invitation to Chief Justice and Mrs. Rehnquist be put on Camp David notecards, with salutation guidance for Justice Souter.",
      evidence:
        "Itemized from page 7 of the NARA direct folder scan using the notecard instruction, Rehnquist salutation, OCR, and rendered-page review.",
    },
    {
      slug: "supreme-court-justices-luncheon-guest-transportation-lists",
      documentType: "Guest and Transportation Lists",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "Camp David Supreme Court Justices luncheon guest and transportation lists",
      documentDate: "1991-04-20",
      pages: 5,
      excerpt:
        "The planning packet lists present and former justices, White House guests, additional guests, regrets, court cars, private vehicles, and presidential handwriting on guest arrangements.",
      evidence:
        "Itemized from pages 8-12 of the NARA direct folder scan using guest-list headings, additional-guest page, handwriting photocopy markers, OCR, and rendered-page review.",
    },
    {
      slug: "colin-alma-powell-camp-david-luncheon-invitation",
      documentType: "Invitation Letter",
      category: "camp-david-invitation",
      disposition: "itemized-camp-david-invitation",
      title:
        "President Bush invitation letter to Colin and Alma Powell for Camp David Supreme Court Justices luncheon",
      documentDate: "1991-03-29",
      pages: 1,
      excerpt:
        "President Bush invites Colin and Alma Powell to an informal Camp David outing with present and former members of the Supreme Court.",
      evidence:
        "Itemized from page 13 of the NARA direct folder scan using Camp David letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "dick-lynne-cheney-camp-david-luncheon-invitation",
      documentType: "Invitation Letter",
      category: "camp-david-invitation",
      disposition: "itemized-camp-david-invitation",
      title:
        "President Bush invitation letter to Dick and Lynne Cheney for Camp David Supreme Court Justices luncheon",
      documentDate: "1991-03-29",
      pages: 1,
      excerpt:
        "President Bush invites Dick and Lynne Cheney to the April 20 Camp David luncheon honoring Supreme Court justices.",
      evidence:
        "Itemized from page 14 of the NARA direct folder scan using Camp David letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "jim-susan-baker-camp-david-luncheon-invitation",
      documentType: "Invitation Letter",
      category: "camp-david-invitation",
      disposition: "itemized-camp-david-invitation",
      title:
        "President Bush invitation letter to Jim and Susan Baker for Camp David Supreme Court Justices luncheon",
      documentDate: "1991-03-29",
      pages: 1,
      excerpt:
        "President Bush invites Jim and Susan Baker to the informal Camp David outing with present and former members of the Supreme Court.",
      evidence:
        "Itemized from page 15 of the NARA direct folder scan using Camp David letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "john-nancy-sununu-camp-david-luncheon-invitation",
      documentType: "Invitation Letter",
      category: "camp-david-invitation",
      disposition: "itemized-camp-david-invitation",
      title:
        "President Bush invitation letter to John and Nancy Sununu for Camp David Supreme Court Justices luncheon",
      documentDate: "1991-03-29",
      pages: 1,
      excerpt:
        "President Bush invites John and Nancy Sununu to the April 20 Camp David luncheon with Supreme Court guests.",
      evidence:
        "Itemized from page 16 of the NARA direct folder scan using Camp David letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "kenneth-alice-starr-camp-david-luncheon-invitation",
      documentType: "Invitation Letter",
      category: "camp-david-invitation",
      disposition: "itemized-camp-david-invitation",
      title:
        "President Bush invitation letter to Kenneth and Alice Starr for Camp David Supreme Court Justices luncheon",
      documentDate: "1991-03-29",
      pages: 1,
      excerpt:
        "President Bush invites Kenneth and Alice Starr to the Camp David luncheon and notes the trails for biking and walking.",
      evidence:
        "Itemized from page 17 of the NARA direct folder scan using Camp David letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "boyden-gray-supreme-court-justices-lunch-memo",
      documentType: "Memorandum with President Bush Handwriting",
      category: "camp-david-event-planning",
      disposition: "itemized-camp-david-event-planning",
      title:
        "C. Boyden Gray memorandum to the President re invitation to Supreme Court Justices to lunch at Camp David",
      documentDate: "1991-03-20",
      pages: 2,
      excerpt:
        "Boyden Gray discusses inviting Supreme Court justices and additional guests to lunch at Camp David, with presidential handwriting and an attached guest list.",
      evidence:
        "Itemized from pages 18-19 of the NARA direct folder scan using the White House memorandum heading, Bush Library handwriting marker, attached guest list, OCR, and rendered-page review.",
    },
  ],
  470417135: [
    {
      slug: "nafta-administration-response-overview",
      documentType: "Administration Report",
      category: "nafta-fast-track-report",
      disposition: "itemized-nafta-fast-track-report",
      title:
        "Response of the Administration to Issues Raised in Connection with the Negotiation of a North American Free Trade Agreement",
      documentDate: "1991-05-01",
      pages: 14,
      excerpt:
        "The President transmits the administration's response to congressional issues raised over fast-track authority for a North American free trade agreement with Mexico.",
      evidence:
        "Itemized from pages 2-15 of the NARA direct folder scan using the transmitted-report title page, overview heading sequence, OCR, and rendered-page review.",
    },
    {
      slug: "nafta-economic-impact-tab",
      documentType: "Report Tab",
      category: "nafta-economic-impact",
      disposition: "itemized-nafta-economic-impact",
      title: "Tab 1: Free Trade Negotiation with Mexico, Economic Impact",
      documentDate: "1991-05-01",
      pages: 31,
      excerpt:
        "The economic-impact tab assesses trade with Mexico, sector and worker adjustment, U.S. competitiveness, environmental trade issues, and likely effects of a North American free trade agreement.",
      evidence:
        "Itemized from pages 16-46 of the NARA direct folder scan using the Tab 1 title page, internal section headings, OCR, and rendered-page review.",
    },
    {
      slug: "nafta-environmental-matters-tab",
      documentType: "Report Tab",
      category: "nafta-environmental-matters",
      disposition: "itemized-nafta-environmental-matters",
      title: "Tab 4: Free Trade Negotiations with Mexico, Environmental Matters",
      documentDate: "1991-05-01",
      pages: 10,
      excerpt:
        "The environmental-matters tab reviews Mexico's environmental law, U.S.-Mexico environmental cooperation, and environmental safeguards connected to NAFTA negotiations.",
      evidence:
        "Itemized from pages 47-56 of the NARA direct folder scan using the Tab 4 title page, environmental-law headings, OCR, and rendered-page review.",
    },
    {
      slug: "us-mexico-labor-cooperation-mou",
      documentType: "Memorandum of Understanding",
      category: "us-mexico-labor-cooperation",
      disposition: "itemized-us-mexico-labor-cooperation",
      title: "Memorandum of Understanding re U.S.-Mexico labor cooperation",
      documentDate: "1991",
      pages: 5,
      excerpt:
        "A U.S.-Mexico labor cooperation memorandum of understanding sets out cooperation between the U.S. Department of Labor and Mexico's Secretariat of Labor and Social Welfare.",
      evidence:
        "Itemized from pages 57-61 of the NARA direct folder scan using the memorandum title page, party names, OCR, and rendered-page review.",
    },
    {
      slug: "nafta-labor-standards-worker-rights-tab",
      documentType: "Report Tab",
      category: "nafta-labor-standards",
      disposition: "itemized-nafta-labor-standards",
      title:
        "Tab 3: Free Trade Negotiations with Mexico, Labor Standards, Worker Health and Safety, and Worker Rights",
      documentDate: "1991-05-01",
      pages: 12,
      excerpt:
        "The labor tab examines labor standards, worker health and safety, and worker rights issues raised by fast-track consideration of free trade negotiations with Mexico.",
      evidence:
        "Itemized from pages 62-73 of the NARA direct folder scan using the Tab 3 title page, labor-standards headings, OCR, and rendered-page review.",
    },
    {
      slug: "nafta-facilitating-adjustment-tab",
      documentType: "Report Tab",
      category: "nafta-adjustment",
      disposition: "itemized-nafta-adjustment",
      title: "Tab 2: Free Trade Negotiations with Mexico, Facilitating Adjustment",
      documentDate: "1991-05-01",
      pages: 7,
      excerpt:
        "The adjustment tab reviews how the administration proposed to facilitate worker and firm adjustment during negotiations toward a North American free trade agreement.",
      evidence:
        "Itemized from pages 74-80 of the NARA direct folder scan using the Tab 2 title page, adjustment-policy headings, OCR, and rendered-page review.",
    },
    {
      slug: "may-1-1991-pool-reports-national-security-agency-workout-fast-track",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title:
        "Pool reports on National Security Agency visit, Great American Workout, Lee Sang-Ock photo op, and fast-track briefing",
      documentDate: "1991-05-01",
      pages: 6,
      excerpt:
        "The May 1 pool-report packet covers the President's National Security Agency visit, Great American Workout, Lee Sang-Ock photo opportunity, and fast-track briefing.",
      evidence:
        "Itemized from pages 81-86 of the NARA direct folder scan using pool-report headings, byline copy, OCR, and rendered-page review.",
    },
    {
      slug: "fast-track-coalition-supporters-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "presidential-remarks-release",
      disposition: "itemized-presidential-remarks-release",
      title:
        "Office of the Press Secretary release of remarks to fast-track coalition supporters",
      documentDate: "1991-05-01",
      pages: 3,
      excerpt:
        "The Office of the Press Secretary released the President's remarks to fast-track coalition supporters in Room 450 of the Old Executive Office Building.",
      evidence:
        "Itemized from pages 87-89 of the NARA direct folder scan using the press-release heading, room line, OCR, and rendered-page review.",
    },
    {
      slug: "farm-broadcasters-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "presidential-remarks-release",
      disposition: "itemized-presidential-remarks-release",
      title: "Office of the Press Secretary release of remarks to farm broadcasters",
      documentDate: "1991-04-29",
      pages: 7,
      excerpt:
        "The Office of the Press Secretary released the President's April 29 remarks to farm broadcasters in the Roosevelt Room.",
      evidence:
        "Itemized from pages 90-96 of the NARA direct folder scan using the press-release heading, date line, Roosevelt Room line, OCR, and rendered-page review.",
    },
    {
      slug: "nafta-administration-action-plan-fact-sheet",
      documentType: "Fact Sheet",
      category: "nafta-fast-track-fact-sheet",
      disposition: "itemized-nafta-fast-track-fact-sheet",
      title:
        "Fact Sheet: The Administration's Action Plan in response to NAFTA negotiation issues",
      documentDate: "1991-05-01",
      pages: 6,
      excerpt:
        "The administration fact sheet summarizes its action plan responding to concerns raised in connection with negotiating a North American free trade agreement.",
      evidence:
        "Itemized from pages 97-102 of the NARA direct folder scan using the Office of the Press Secretary fact-sheet heading, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-april-30-1991-5pm-fast-track",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 5:00 p.m. news update, April 30, 1991",
      documentDate: "1991-04-30",
      pages: 2,
      excerpt:
        "The April 30 White House News Summary update tracks fast-track, Mexico trade, and related press coverage before the May 1 transmittal.",
      evidence:
        "Itemized from pages 103-104 of the NARA direct folder scan using the White House News Summary heading, 5:00 p.m. update marker, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-may-1-1991-updates",
      documentType: "White House News Summary Updates",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary updates, May 1, 1991",
      documentDate: "1991-05-01",
      pages: 5,
      excerpt:
        "The May 1 White House News Summary pages include 9:30 a.m., 12:45 p.m., and 4:30 p.m. updates on fast-track and the day's press coverage.",
      evidence:
        "Itemized from pages 105-109 of the NARA direct folder scan using the White House News Summary update headings, OCR, and rendered-page review.",
    },
  ],
  470417151: [
    {
      slug: "legislative-issues-update-cover-sheet",
      documentType: "Cover Sheet",
      category: "legislative-issues-update",
      disposition: "itemized-legislative-issues-update",
      title: "Legislative Issues Update cover sheet",
      documentDate: "1990-05-10",
      pages: 1,
      excerpt:
        "Cover sheet for the Office of Legislative Affairs Legislative Issues Update dated May 10, 1990.",
      evidence:
        "Itemized from page 3 of the NARA direct folder scan using the Legislative Issues Update title block, OCR, and rendered-page review.",
    },
    {
      slug: "mcclure-legislative-issues-update-transmittal-memo",
      documentType: "Memorandum",
      category: "legislative-issues-update",
      disposition: "itemized-legislative-issues-update",
      title:
        "Frederick D. McClure memorandum to President Bush re Legislative Issues Update",
      documentDate: "1990-05-10",
      pages: 1,
      excerpt:
        "Frederick D. McClure transmits an updated legislative issues analysis to the President, noting that the Office of Legislative Affairs will continue to update the summary as issues develop.",
      evidence:
        "Itemized from page 4 of the NARA direct folder scan using the White House memorandum heading, McClure signature line, subject line, OCR, and rendered-page review.",
    },
    {
      slug: "office-legislative-affairs-legislative-issues-update",
      documentType: "Legislative Issues Update",
      category: "legislative-issues-update",
      disposition: "itemized-legislative-issues-update",
      title: "Office of Legislative Affairs Legislative Issues Update, May 10, 1990",
      documentDate: "1990-05-10",
      pages: 112,
      excerpt:
        "The Office of Legislative Affairs update surveys major issues before Congress, including abortion, ADA, Amtrak, appropriations, budget, campaign finance, capital gains, child care, China/MFN sanctions, civil rights, crime and drugs, Eastern Europe, education, environment, export controls, farm policy, flag burning, food safety, supplemental appropriations, Hatch Act, housing, labor, national service, OIRA, pocket veto, product liability, RTC, Soviet trade, and motor voter legislation.",
      evidence:
        "Itemized from pages 5-116 of the NARA direct folder scan using the report title page, index, issue-section headings, OCR, and rendered-page review.",
    },
  ],
  470417227: [
    {
      slug: "burton-lee-aids-memo-to-sununu",
      documentType: "Memorandum with President Bush Handwriting",
      category: "aids-policy-memo",
      disposition: "itemized-aids-policy-memo",
      title: "Burton J. Lee memorandum to John H. Sununu re AIDS",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "Burton J. Lee advises John Sununu that President Bush's central AIDS theme should be education and prevention, with issues including promiscuity, drugs, and fairness to fellow Americans.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using the White House memorandum heading, THE PRESIDENT HAS SEEN stamp, Bush handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "newspaper-clipping-albania-safire-sununu",
      documentType: "Newspaper Clipping Page",
      category: "press-clipping",
      disposition: "itemized-press-clipping",
      title:
        "Newspaper clipping page with Sali Berisha essay excerpt and William Safire column In Deep Sununu",
      documentDate: "",
      pages: 1,
      excerpt:
        "A clipping page combines an essay excerpt on Albania's post-Communist politics with William Safire's column In Deep Sununu on John Sununu's White House role and travel controversies.",
      evidence:
        "Itemized from page 3 of the NARA direct folder scan using newspaper clipping layout, Safire column title, Albania essay text, OCR, and rendered-page review.",
    },
    {
      slug: "johnny-morris-big-cedar-lodge-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush correspondence with Johnny Morris re Big Cedar Lodge",
      documentDate: "1991-06-27",
      pages: 2,
      excerpt:
        "President Bush writes Johnny Morris about the Big Cedar Lodge book and hopes to visit the shop again; Morris's June 20 incoming letter thanks Bush for interest in the Bluefin Tuna issue and invites him to Big Cedar Lodge.",
      evidence:
        "Itemized from pages 4-5 of the NARA direct folder scan using the presidential note, Bass Pro Shops incoming letter, bcc/return instructions, OCR, and rendered-page review.",
    },
    {
      slug: "george-bell-birthday-card-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to George De B. Bell re birthday card and summer plans",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "President Bush writes George De B. Bell about a card, returning to golf and tennis, and plans to celebrate his mother's ninetieth birthday in Maine.",
      evidence:
        "Itemized from page 6 of the NARA direct folder scan using presidential letterhead, addressee block, signature, OCR, and rendered-page review.",
    },
    {
      slug: "clark-judge-capital-gains-article-correspondence",
      documentType: "Correspondence and Press Article",
      category: "capital-gains-press-article",
      disposition: "itemized-capital-gains-press-article",
      title: "President Bush note to Clark S. Judge with The Tax That Ate the Economy article",
      documentDate: "1991-06-27",
      pages: 2,
      excerpt:
        "A White House routing page carries President Bush's note thanking Clark S. Judge for his conclusion, followed by Judge's article The Tax That Ate the Economy on capital-gains taxation and job creation.",
      evidence:
        "Itemized from pages 7-8 of the NARA direct folder scan using the White House address page, Bush note, records instruction, article title, OCR, and rendered-page review.",
    },
    {
      slug: "chafee-title-x-proposed-substitute",
      documentType: "Legislative Proposal",
      category: "title-x-pregnancy-counseling",
      disposition: "itemized-title-x-pregnancy-counseling",
      title: "Proposed substitute for S. 323, Chafee Title X Pregnancy Counseling Act of 1991",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "The proposed substitute outlines pregnancy counseling options, family involvement, conscience protections, and availability of services under Title X funded clinics.",
      evidence:
        "Itemized from page 10 of the NARA direct folder scan using the proposed substitute heading, Chafee Title X Pregnancy Counseling Act title, OCR, and rendered-page review.",
    },
    {
      slug: "chafee-title-x-memo-to-president",
      documentType: "Senator Memorandum",
      category: "title-x-pregnancy-counseling",
      disposition: "itemized-title-x-pregnancy-counseling",
      title: "Senator Chafee memorandum to President Bush re Title X and Pregnancy Counseling",
      documentDate: "1991-06-27",
      pages: 2,
      excerpt:
        "Senator John Chafee asks President Bush to support Title X pregnancy counseling legislation that would overturn the 1988 HHS regulations and respond to medical, public-opinion, and Republican electoral concerns.",
      evidence:
        "Itemized from pages 11-12 of the NARA direct folder scan using the DATE/TO/FROM/RE heading, Chafee signature context, OCR, and rendered-page review.",
    },
    {
      slug: "title-x-pregnancy-counseling-vote-lists",
      documentType: "Vote Lists",
      category: "title-x-pregnancy-counseling",
      disposition: "itemized-title-x-pregnancy-counseling",
      title: "Vote lists on the Chafee pregnancy counseling amendment and S. 323",
      documentDate: "1990-09-25",
      pages: 2,
      excerpt:
        "Vote lists record Senate votes on the Chafee pregnancy counseling amendment to Title X and a Senate Labor and Human Resources Committee vote on S. 323.",
      evidence:
        "Itemized from pages 13-14 of the NARA direct folder scan using vote-list headings, member columns, OCR, and rendered-page review.",
    },
    {
      slug: "s323-title-x-bill-print-and-status",
      documentType: "Bill Print and Status Sheet",
      category: "title-x-pregnancy-counseling",
      disposition: "itemized-title-x-pregnancy-counseling",
      title: "S. 323 Title X Pregnancy Counseling Act bill print and status sheet",
      documentDate: "1991",
      pages: 3,
      excerpt:
        "The packet includes the S. 323 bill print title page and a status sheet for the Title X Pregnancy Counseling Act of 1991.",
      evidence:
        "Itemized from pages 15-17 of the NARA direct folder scan using the Calendar No. 125 bill print, official title, and status sheet, OCR, and rendered-page review.",
    },
    {
      slug: "wall-street-journal-ama-doctors-counseling-article",
      documentType: "Press Article",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "Wall Street Journal article: AMA Opposes Government Interference With Doctors' Counseling of Patients",
      documentDate: "1991-06-26",
      pages: 1,
      excerpt:
        "Thomas M. Burton reports that the American Medical Association opposed government interference with doctors' counseling of patients.",
      evidence:
        "Itemized from page 18 of the NARA direct folder scan using the Wall Street Journal masthead, article title, byline, OCR, and rendered-page review.",
    },
    {
      slug: "washington-post-forbidden-advice-editorial",
      documentType: "Editorial",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "Washington Post editorial: Forbidden Advice",
      documentDate: "1991-05-24",
      pages: 1,
      excerpt:
        "The Washington Post editorial Forbidden Advice criticizes restrictions on abortion-related advice in federally funded family-planning clinics.",
      evidence:
        "Itemized from page 19 of the NARA direct folder scan using the Washington Post editorial page masthead, title, date, OCR, and rendered-page review.",
    },
    {
      slug: "new-york-times-ama-medical-advice-curbs-article",
      documentType: "Press Article",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "New York Times article: A.M.A. Condemns U.S. Curbs on Medical Advice",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "The New York Times reports from Chicago that the American Medical Association condemned federal curbs on medical advice related to abortion counseling.",
      evidence:
        "Itemized from page 20 of the NARA direct folder scan using the New York Times heading, article title, date line, OCR, and rendered-page review.",
    },
    {
      slug: "ama-gag-rule-statement",
      documentType: "Association Statement",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "American Medical Association statement: The Gag Rule",
      documentDate: "1991-06-13",
      pages: 1,
      excerpt:
        "The American Medical Association statement attributed to James S. Todd supports S. 323 and H.R. 392, the Title X Pregnancy Counseling Act.",
      evidence:
        "Itemized from page 21 of the NARA direct folder scan using AMA statement heading, attribution line, date, OCR, and rendered-page review.",
    },
    {
      slug: "acog-pregnancy-counseling-statement",
      documentType: "Association Statement",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "American College of Obstetricians and Gynecologists statement on pregnancy counseling",
      documentDate: "1991-06-21",
      pages: 2,
      excerpt:
        "Richard H. Schwarz, president of the American College of Obstetricians and Gynecologists, argues that restrictions on pregnancy counseling interfere with the doctor-patient relationship.",
      evidence:
        "Itemized from pages 22-23 of the NARA direct folder scan using the ACOG letterhead, statement heading, signature/date page, OCR, and rendered-page review.",
    },
    {
      slug: "david-cole-get-government-out-doctors-office-oped",
      documentType: "Opinion Article",
      category: "title-x-pregnancy-counseling-press",
      disposition: "itemized-title-x-pregnancy-counseling-press",
      title: "David Cole op-ed: Get Government Out of the Doctor's Office",
      documentDate: "1991-05-28",
      pages: 1,
      excerpt:
        "David Cole's Washington Post op-ed criticizes government restrictions on what doctors may say to patients in Title X clinics.",
      evidence:
        "Itemized from page 24 of the NARA direct folder scan using the Washington Post byline, op-ed title, date, OCR, and rendered-page review.",
    },
    {
      slug: "title-x-pregnancy-counseling-draft-amendment",
      documentType: "Draft Amendment",
      category: "title-x-pregnancy-counseling",
      disposition: "itemized-title-x-pregnancy-counseling",
      title: "Draft amendment on Title X pregnancy information and counseling",
      documentDate: "1991",
      pages: 5,
      excerpt:
        "Draft amendment language would require pregnancy information and counseling under Title X while addressing conscience protections, referrals, definitions, and religious or moral convictions.",
      evidence:
        "Itemized from pages 25-29 of the NARA direct folder scan using the BAI91.449 S.L.C. page headers, amendment purpose line, section text, OCR, and rendered-page review.",
    },
    {
      slug: "louis-marks-handwritten-presidential-letter",
      documentType: "Handwritten Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush handwritten letter to Louis Marks Jr. re fan-jet forehand",
      documentDate: "1991-06-27",
      pages: 2,
      excerpt:
        "President Bush writes Louis Marks Jr. in longhand about having been there at sixty years old and suggests that a fan-jet forehand might enhance his finesse.",
      evidence:
        "Itemized from pages 30-31 of the NARA direct folder scan using the White House address page, handwritten front and continuation page, OCR, and rendered-page review.",
    },
    {
      slug: "charles-neblett-presidential-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Charles Neblett re Lisbon note and family news",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "President Bush thanks Charles Neblett for a June 9 note from Lisbon, mentions Joe and Carole Zappala, Andrew and Margaret, and plans for his mother's ninetieth birthday.",
      evidence:
        "Itemized from page 32 of the NARA direct folder scan using presidential letterhead, address block, signature, OCR, and rendered-page review.",
    },
    {
      slug: "pool-report-bust-unveiling-marshall-resignation",
      documentType: "Pool Report",
      category: "pool-report-packet",
      disposition: "itemized-pool-report",
      title: "Pool report on bust unveiling and Thurgood Marshall resignation",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "Jim Gerstenzang's pool report covers the bust unveiling and President Bush's comment on Justice Thurgood Marshall's resignation.",
      evidence:
        "Itemized from page 33 of the NARA direct folder scan using the pool report heading, date, byline, OCR, and rendered-page review.",
    },
    {
      slug: "marshall-retirement-president-statement",
      documentType: "Presidential Statement Release",
      category: "presidential-statement-release",
      disposition: "itemized-presidential-statement-release",
      title: "Office of the Press Secretary statement by the President on Justice Thurgood Marshall",
      documentDate: "1991-06-27",
      pages: 1,
      excerpt:
        "President Bush praises Justice Thurgood Marshall's distinguished service as a civil-rights lawyer, judge, Solicitor General, and Supreme Court justice, and says he intends to nominate a successor very soon.",
      evidence:
        "Itemized from page 34 of the NARA direct folder scan using the Office of the Press Secretary release heading, date, statement text, OCR, and rendered-page review.",
    },
    {
      slug: "june-26-house-republicans-senators-pool-reports",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report",
      title: "Pool reports on June 26 meetings with House Republicans and Senators",
      documentDate: "1991-06-26",
      pages: 2,
      excerpt:
        "Charlie Green's pool reports cover President Bush's June 26 meetings with House Republicans and senators, including questions on Yugoslavia, abortion counseling, MFN, and China.",
      evidence:
        "Itemized from pages 35-36 of the NARA direct folder scan using pool report headings, meeting titles, byline, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-june-27-1991-updates",
      documentType: "White House News Summary Updates",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary updates, June 27, 1991",
      documentDate: "1991-06-27",
      pages: 5,
      excerpt:
        "White House News Summary updates for June 27 cover Yugoslavia, recession comments, Supreme Court decisions, Justice Marshall's retirement, the Middle East peace process, and related wire coverage.",
      evidence:
        "Itemized from pages 37-41 of the NARA direct folder scan using the 10:30 a.m., 1:30 p.m., and 4:30 p.m. update headings, OCR, and rendered-page review.",
    },
    {
      slug: "transferred-white-house-photographs-transfer-sheet",
      documentType: "Transfer Sheet and Photograph Photocopies",
      category: "transferred-white-house-photographs",
      disposition: "itemized-transferred-white-house-photographs",
      title: "George Bush Presidential Library transfer sheet and photocopies of transferred White House photographs",
      documentDate: "2013-01-16",
      pages: 7,
      excerpt:
        "A Bush Library transfer sheet records White House photographs transferred to the audiovisual collection, followed by photocopies of the images in the daily-file scan.",
      evidence:
        "Itemized from pages 43-49 of the NARA direct folder scan using the transfer sheet description, photograph photocopies, OCR, and rendered-page review.",
    },
    {
      slug: "us-savings-bonds-1991-campaign-booklet",
      documentType: "Campaign Booklet",
      category: "us-savings-bonds-campaign",
      disposition: "itemized-us-savings-bonds-campaign",
      title: "U.S. Savings Bonds: The Great American Investment, 1991 Campaign booklet",
      documentDate: "1991",
      pages: 28,
      excerpt:
        "The 1991 U.S. Savings Bonds campaign booklet includes messages from President Bush, Secretary Nicholas Brady, and national chairman John Clendenin; campaign goals; volunteer committee rosters; honor rolls; and savings bond explanations.",
      evidence:
        "Itemized from pages 50-77 of the NARA direct folder scan using the color booklet cover, presidential message, campaign sections, rosters, honor-roll tables, OCR, and rendered-page review.",
    },
  ],
  470417253: [
    {
      slug: "london-economic-summit-tower-dinner-program-invitation",
      documentType: "Event Program and Invitation",
      category: "london-economic-summit-dinner",
      disposition: "itemized-london-economic-summit-dinner",
      title: "London Economic Summit dinner program and invitation for H.M. Tower of London",
      documentDate: "1991-07-15",
      pages: 5,
      excerpt:
        "The London Economic Summit dinner packet includes the Prime Minister's Tower of London invitation for George Bush, dinner program pages, notes on H.M. Tower of London, and menu and wine-list pages.",
      evidence:
        "Itemized from pages 2-6 of the NARA direct folder scan using the summit dinner cover, Tower of London notes, menu/wine-list page, Prime Minister invitation, OCR, and rendered-page review.",
    },
    {
      slug: "presidential-movements-london-july-15-1991",
      documentType: "Presidential Movements",
      category: "presidential-movements",
      disposition: "itemized-presidential-movements",
      title: "Presidential movements in London, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 1,
      excerpt:
        "A Presidential Movements page records President Bush's London, England movements for July 15, 1991.",
      evidence:
        "Itemized from page 7 of the NARA direct folder scan using the Presidential Movements heading, London location line, date, OCR, and rendered-page review.",
    },
    {
      slug: "telephone-memoranda-president-signal-switchboard-july-15",
      documentType: "Telephone Memoranda",
      category: "telephone-memoranda",
      disposition: "itemized-telephone-memoranda",
      title: "White House telephone memoranda for President Bush and Signal Switchboard, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 2,
      excerpt:
        "Two telephone memorandum pages for President Bush and the Signal Switchboard record no calls for July 15, 1991.",
      evidence:
        "Itemized from pages 8-9 of the NARA direct folder scan using the telephone memorandum forms, President Bush and Signal Switchboard labels, no-calls entries, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-july-15-1991-6am",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 6:00 a.m. EDT edition, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 26,
      excerpt:
        "The 6:00 a.m. White House News Summary covers the London economic summit, Gorbachev's appeal for aid, Iraq, Clarence Thomas, Cuomo, network news, and Sunday political programs.",
      evidence:
        "Itemized from pages 10-35 of the NARA direct folder scan using the White House News Summary masthead, 6:00 a.m. EDT edition line, section headings, OCR, and rendered-page review.",
    },
    {
      slug: "congressional-monitor-july-15-1991",
      documentType: "Congressional Monitor",
      category: "congressional-monitor",
      disposition: "itemized-congressional-monitor",
      title: "Congressional Monitor: This Week in Congress, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 26,
      excerpt:
        "Congressional Monitor, Vol. 27 No. 144, surveys the week in Congress, including House and Senate schedules, committee action, floor business, and legislative coverage.",
      evidence:
        "Itemized from pages 36-61 of the NARA direct folder scan using the Congressional Monitor cover, Vol. 27 No. 144 issue line, This Week in Congress heading, OCR, and rendered-page review.",
    },
    {
      slug: "buckingham-palace-dinner-invitation",
      documentType: "Royal Invitation Packet",
      category: "london-economic-summit-dinner",
      disposition: "itemized-london-economic-summit-dinner",
      title: "Buckingham Palace dinner invitation for President and Mrs. Bush",
      documentDate: "1991-07-16",
      pages: 3,
      excerpt:
        "The Buckingham Palace invitation packet invites President and Mrs. Bush, by command of Queen Elizabeth II and the Duke of Edinburgh, to dinner on July 16, 1991.",
      evidence:
        "Itemized from pages 63-65 of the NARA direct folder scan using the Master of the Household invitation text, President and Mrs. Bush envelope page, seal page, OCR, and rendered-page review.",
    },
    {
      slug: "acland-event-planning-packet",
      documentType: "Correspondence and Note Packet with President Bush Handwriting",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Acland event planning packet with Mrs. Bush note and President Bush handwriting",
      documentDate: "1991",
      pages: 9,
      excerpt:
        "The Acland event planning packet includes Mrs. Bush's request, notes to Patty, and President Bush handwriting about continuing an event for the Aclands before their July departure.",
      evidence:
        "Itemized from pages 66-74 of the NARA direct folder scan using the Acland event cover, Mrs. Bush note, White House note pages with Bush handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "fitzwater-statement-palestinian-federation-syrian-acceptance",
      documentType: "Press Secretary Statement",
      category: "press-secretary-statement",
      disposition: "itemized-press-secretary-statement",
      title: "Marlin Fitzwater statement on Palestinian federation and Syrian acceptance at London",
      documentDate: "1991-07-15",
      pages: 1,
      excerpt:
        "Marlin Fitzwater issues a London statement on Palestinian federation and Syrian acceptance in connection with Middle East peace diplomacy.",
      evidence:
        "Itemized from page 75 of the NARA direct folder scan using the Office of the Press Secretary London heading, Fitzwater statement title, London Hilton time line, OCR, and rendered-page review.",
    },
    {
      slug: "fitzwater-london-press-briefing-july-15-1991",
      documentType: "Press Briefing Transcript",
      category: "press-briefing-transcript",
      disposition: "itemized-press-briefing-transcript",
      title: "Marlin Fitzwater press briefing at London Hilton Hotel, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 10,
      excerpt:
        "The Marlin Fitzwater press briefing transcript covers London summit questions, Middle East peace diplomacy, Soviet issues, START, and related foreign-policy questions.",
      evidence:
        "Itemized from pages 76-85 of the NARA direct folder scan using the Office of the Press Secretary London heading, press briefing title, London Hilton Hotel location, numbered transcript pages, OCR, and rendered-page review.",
    },
    {
      slug: "pool-reports-bush-bilaterals-winfield-house",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title: "Pool reports on Bush bilaterals and press logistics at Winfield House",
      documentDate: "1991-07-15",
      pages: 3,
      excerpt:
        "Pool reports cover President Bush's July 15 bilaterals at Winfield House, including meetings with Mitterrand, Mulroney, Kohl, and Andreotti, plus press logistics and summit observations.",
      evidence:
        "Itemized from pages 86-88 of the NARA direct folder scan using Pool Report #3, #10, and #11 headings, Winfield House bilateral descriptions, OCR, and rendered-page review.",
    },
    {
      slug: "ap-lederer-british-bar-reporters-summit",
      documentType: "Wire Story",
      category: "summit-press-coverage",
      disposition: "itemized-summit-press-coverage",
      title: "AP Wire Story by Edith M. Lederer: British bar reporters from covering leaders and spouses",
      documentDate: "1991-07-15",
      pages: 1,
      excerpt:
        "Edith M. Lederer's Associated Press wire story reports that British officials barred reporters from covering leaders and spouses during the London economic summit.",
      evidence:
        "Itemized from page 89 of the NARA direct folder scan using the AP wire layout, Edith M. Lederer byline, July 15 dateline, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-july-15-1991-530pm-london",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 5:30 p.m. London / 12:30 p.m. EDT edition, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 16,
      excerpt:
        "The 5:30 p.m. London White House News Summary tracks summit coverage, Middle East diplomacy, domestic politics, and morning network news coverage.",
      evidence:
        "Itemized from pages 90-105 of the NARA direct folder scan using the White House News Summary masthead, 5:30 p.m. London / 12:30 p.m. EDT edition line, network-news headings, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-july-15-1991-230pm-update",
      documentType: "White House News Summary Update",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 2:30 p.m. EDT / 7:30 p.m. London update, July 15, 1991",
      documentDate: "1991-07-15",
      pages: 1,
      excerpt:
        "The 2:30 p.m. EDT / 7:30 p.m. London update summarizes census decision coverage, summit developments, Brady, and other late-day news items.",
      evidence:
        "Itemized from page 106 of the NARA direct folder scan using the White House News Summary update heading, 2:30 p.m. EDT / 7:30 p.m. London marker, OCR, and rendered-page review.",
    },
  ],
  470417305: [
    {
      slug: "hector-salazar-shirt-thanks-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Hector Salazar re Kennebunkport shirt",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush thanks Hector Salazar for a shirt, says he expects to use it in Kennebunkport, and notes that Marvin will get the shirt Salazar sent him.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using presidential letterhead, Hector Salazar address page, signature, OCR, and rendered-page review.",
    },
    {
      slug: "mark-yudof-charles-alan-wright-handwritten-note",
      documentType: "Handwritten Presidential Note and Envelope",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush handwritten note to Mark Yudof re New York Times picture and University of Texas law school friends",
      documentDate: "1991-08-21",
      pages: 2,
      excerpt:
        "President Bush writes Mark Yudof about a New York Times picture, Charles Alan Wright, University of Texas law school friends, and sends thanks and regards to Edith.",
      evidence:
        "Itemized from pages 3-4 of the NARA direct folder scan using Walker's Point notecard pages, Mark G. Yudof address page, handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "thomas-moseley-handwritten-note-camp-david-maine",
      documentType: "Handwritten Presidential Note and Envelope",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush handwritten note to Thomas W. Moseley re photographs, Camp David call, and Maine",
      documentDate: "1991-08-21",
      pages: 2,
      excerpt:
        "President Bush thanks Thomas W. Moseley for photographs, mentions a Camp David call with Lud Ashley, says he is back in Maine, and asks about Moseley's fall schedule.",
      evidence:
        "Itemized from pages 5-6 of the NARA direct folder scan using Walker's Point notecard pages, Thomas W. Moseley address page, handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "craig-shergold-card-collection-note",
      documentType: "Handwritten Presidential Note and Envelope",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush handwritten note to Craig Shergold re card collection",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush writes Craig Shergold that Lud Ashley told him about Shergold's card collection and sends one of his cards to add to it.",
      evidence:
        "Itemized from page 7 of the NARA direct folder scan using presidential notecard text, Craig Shergold address page, bcc to Lud Ashley, handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "ted-stevens-salmon-recovery-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Ted Stevens re salmon and recovery",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush thanks Senator Ted Stevens for salmon sent to Kennebunkport and hopes Stevens's recovery is speedy.",
      evidence:
        "Itemized from page 8 of the NARA direct folder scan using presidential letterhead, Ted Stevens address page, Gift Unit note, OCR, and rendered-page review.",
    },
    {
      slug: "jack-guy-georgia-veterans-day-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Jack O. Guy re Southeast Georgia Veterans Day Celebration",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush tells Jack O. Guy that he does not know whether he can attend the Southeast Georgia Veterans Day Celebration but will have schedulers give it close attention.",
      evidence:
        "Itemized from page 9 of the NARA direct folder scan using presidential letterhead, Jack O. Guy address page, scheduler note, OCR, and rendered-page review.",
    },
    {
      slug: "prescott-bush-armando-ferla-william-edgar-copies-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush letter to Prescott S. Bush Jr. transmitting Armando Ferla and William Edgar reply copies",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush sends Prescott S. Bush Jr. copies of letters to Armando Ferla and William Edgar and comments on vacation at Kennebunkport despite events in the Soviet Union.",
      evidence:
        "Itemized from page 10 of the NARA direct folder scan using presidential letterhead, Prescott S. Bush Jr. address page, signature, OCR, and rendered-page review.",
    },
    {
      slug: "charles-black-campaign-organization-counsel-note",
      documentType: "Handwritten Presidential Note and Envelope",
      category: "campaign-organization-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush handwritten note to Charles R. Black Jr. re campaign organization counsel",
      documentDate: "1991-08-21",
      pages: 2,
      excerpt:
        "President Bush thanks Charles Black for helpful input, says he has not finalized campaign organization decisions, and values Black's counsel.",
      evidence:
        "Itemized from pages 11-12 of the NARA direct folder scan using Walker's Point notecard pages, Charles R. Black Jr. address page, handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "philip-grondin-bluefish-tuna-tournament-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Philip H. Grondin re Sturdivant Island Bluefish/Tuna Tournament",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush tells Philip Grondin that he missed the Sturdivant Island Bluefish/Tuna Tournament, appreciates the invitation, and calls it one of the best summers for blue fishing he can recall.",
      evidence:
        "Itemized from page 13 of the NARA direct folder scan using presidential letterhead, Philip H. Grondin address page, OCR, and rendered-page review.",
    },
    {
      slug: "william-kockos-anniversary-letter-note",
      documentType: "Presidential Letter with Staff Note",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Mr. and Mrs. William Kockos re 49th wedding anniversary",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush congratulates Mr. and Mrs. William Kockos on their 49th wedding anniversary, with a handwritten staff note about sending the tie bar and stick pin.",
      evidence:
        "Itemized from page 14 of the NARA direct folder scan using presidential letterhead, William Kockos address page, handwritten note, OCR, and rendered-page review.",
    },
    {
      slug: "armando-ferla-missing-may-letter-response",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Armando Ferla re missing May letter",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush writes Armando Ferla that Pres passed along Ferla's message about a May letter, says no record of the letter was found, and invites him to stay in touch.",
      evidence:
        "Itemized from page 15 of the NARA direct folder scan using White House letterhead, Armando Ferla address page, OCR, and rendered-page review.",
    },
    {
      slug: "william-edgar-westminster-theological-seminary-invitation-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush letter to William Edgar re Westminster Theological Seminary keynote invitation",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush thanks William Edgar for inviting him to keynote the Westminster Theological Seminary luncheon and says a scheduler will be in touch.",
      evidence:
        "Itemized from page 16 of the NARA direct folder scan using presidential letterhead, William Edgar address page, scheduler note, OCR, and rendered-page review.",
    },
    {
      slug: "herbie-surgery-recovery-letter",
      documentType: "Presidential Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter to Herbie re surgery and recovery",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "President Bush tells Herbie that he and Barbara heard about the surgery, are thinking of him, and hope his recovery is speedy.",
      evidence:
        "Itemized from page 17 of the NARA direct folder scan using presidential letterhead, addressee line, signature, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-august-21-1991-330pm-update",
      documentType: "White House News Summary Update",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 3:30 p.m. EDT update, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "The 3:30 p.m. update tracks Gorbachev's television statement, Yazov, Soviet coup developments, Yeltsin, and related wire coverage.",
      evidence:
        "Itemized from page 18 of the NARA direct folder scan using the White House News Summary heading, 3:30 p.m. EDT update marker, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-august-21-1991-100pm-update",
      documentType: "White House News Summary Update",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 1:00 p.m. EDT update, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "The 1:00 p.m. update covers reports about Dmitri Yazov, Soviet army movement, the coup committee, Yeltsin, Gorbachev, and Bush administration reaction.",
      evidence:
        "Itemized from page 19 of the NARA direct folder scan using the White House News Summary heading, 1:00 p.m. EDT update marker, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-august-21-1991-1000am-update",
      documentType: "White House News Summary Update",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 10:00 a.m. news update, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "The 10:00 a.m. news update covers the collapse of the Soviet coup, Yeltsin, Gorbachev, Lithuania, and U.S. administration reaction.",
      evidence:
        "Itemized from page 21 of the NARA direct folder scan using the White House News Summary heading, 10:00 a.m. news update marker, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-august-21-1991-830am-update",
      documentType: "White House News Summary Update",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 8:30 a.m. news update, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "The 8:30 a.m. news update covers the Gang of Eight, Yeltsin, Soviet television, Bush statements, the Baltics, and early coup-collapse reporting.",
      evidence:
        "Itemized from page 22 of the NARA direct folder scan using the White House News Summary heading, 8:30 a.m. news update marker, OCR, and rendered-page review.",
    },
    {
      slug: "romania-jackson-vanik-waiver-release-packet",
      documentType: "Press Release Packet",
      category: "romania-jackson-vanik-waiver",
      disposition: "itemized-romania-jackson-vanik-waiver",
      title:
        "Romania Jackson-Vanik waiver release packet, letter, executive order, determination, and duplicate copies",
      documentDate: "1991-08-21",
      pages: 8,
      excerpt:
        "The Romania waiver packet includes press secretary statements, the President's transmittal letter to Congress, an executive order, and Presidential Determination No. 91-48 waiving Trade Act emigration provisions for Romania.",
      evidence:
        "Itemized from pages 23, 39-44, and 46 of the NARA direct folder scan using White House Press Secretary headings, Romania Jackson-Vanik waiver text, executive order, presidential determination, duplicate copies, OCR, and rendered-page review.",
    },
    {
      slug: "walkers-point-press-availability-gorbachev-duplicate-transcripts",
      documentType: "Press Availability Transcript Copies",
      category: "presidential-press-availability",
      disposition: "itemized-presidential-press-availability",
      title:
        "Remarks by President Bush during Walker's Point press availability on Gorbachev, duplicate transcript copies",
      documentDate: "1991-08-21",
      pages: 8,
      excerpt:
        "Two transcript copies record President Bush's Walker's Point press availability on the Soviet coup, Gorbachev's status, popular elections, the five plotters, and the coup's collapse.",
      evidence:
        "Itemized from pages 24-27 and 47-50 of the NARA direct folder scan using Office of the Press Secretary release headings, Walker's Point location line, duplicate transcript copies, OCR, and rendered-page review.",
    },
    {
      slug: "pool-report-24-post-press-conference",
      documentType: "Pool Report",
      category: "pool-report-packet",
      disposition: "itemized-pool-report",
      title: "Pool Report #24: post-press conference, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 2,
      excerpt:
        "Pool Report #24 covers the motorcade back to Walker's Point, Fitzwater comments after the press conference, the Gorbachev call, and the President's informal shirt appearance.",
      evidence:
        "Itemized from pages 28-29 of the NARA direct folder scan using Pool Report #24 heading, K-Port Press Office fax line, OCR, and rendered-page review.",
    },
    {
      slug: "president-press-conference-shawmut-inn-august-21-1991",
      documentType: "Press Conference Transcript",
      category: "press-conference-transcript",
      disposition: "itemized-press-conference-transcript",
      title: "Press conference by President Bush at the Shawmut Inn, August 21, 1991",
      documentDate: "1991-08-21",
      pages: 9,
      excerpt:
        "The Shawmut Inn press conference transcript covers Bush's response to the Soviet coup, Gorbachev, Yeltsin, Baker's European consultations, the Baltics, democracy, and U.S. policy toward the Soviet Union.",
      evidence:
        "Itemized from pages 30-38 of the NARA direct folder scan using the Press Conference by the President heading, Shawmut Inn location line, K-Port Press Office fax pages, OCR, and rendered-page review.",
    },
    {
      slug: "chemical-safety-board-budget-amendment-statement",
      documentType: "Press Secretary Statement",
      category: "budget-amendment-statement",
      disposition: "itemized-budget-amendment-statement",
      title: "Press Secretary statement on FY 1992 budget amendment for Chemical Safety and Hazard Investigation Board",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "The statement announces that President Bush transmitted an FY 1992 budget amendment to establish the Chemical Safety and Hazard Investigation Board authorized by the Clean Air Act Amendments of 1990.",
      evidence:
        "Itemized from page 45 of the NARA direct folder scan using the Office of the Press Secretary heading, budget amendment text, OCR, and rendered-page review.",
    },
    {
      slug: "washington-times-inside-beltway-banzhaf-clipping",
      documentType: "Newspaper Clipping",
      category: "press-clipping",
      disposition: "itemized-press-clipping",
      title: "Washington Times Inside the Beltway clipping re John Banzhaf and lawyer jokes",
      documentDate: "1991-08-21",
      pages: 1,
      excerpt:
        "A Washington Times Inside the Beltway clipping includes item text on John Banzhaf and reactions to a lawyer-joke item.",
      evidence:
        "Itemized from page 51 of the NARA direct folder scan using the Washington Times masthead, Inside the Beltway column title, clipping layout, OCR, and rendered-page review.",
    },
    {
      slug: "transferred-white-house-photographs-august-21-1991-transfer-sheet",
      documentType: "Transfer Sheet and Photograph Photocopies",
      category: "transferred-white-house-photographs",
      disposition: "itemized-transferred-white-house-photographs",
      title: "George Bush Presidential Library transfer sheet and photocopies of transferred White House photographs, August 21, 1991",
      documentDate: "2013-01-11",
      pages: 19,
      excerpt:
        "A Bush Library transfer sheet records White House photographs transferred to the audiovisual collection, followed by photocopies of official White House photographs from August 21, 1991.",
      evidence:
        "Itemized from pages 53-71 of the NARA direct folder scan using the transfer sheet, official White House photograph captions, photocopied images, OCR, and rendered-page review.",
    },
  ],
  470417364: [
    {
      slug: "white-house-news-summary-post-address-network-coverage-duplicate-copies",
      documentType: "White House News Summary Duplicate Copies",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: network coverage following the President's address, duplicate copies",
      documentDate: "1991-09-27",
      pages: 2,
      excerpt:
        "Duplicate copies of a White House News Summary page excerpt ABC, CNN, and NBC commentary after President Bush's address on nuclear arms and defense policy.",
      evidence:
        "Itemized from pages 2 and 36 of the NARA direct folder scan using duplicate White House News Summary headings, network coverage following the President's address title, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-evening-coverage-defense-policy-duplicate-copies",
      documentType: "White House News Summary Duplicate Copies",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 6:30 p.m. network evening news coverage of upcoming defense policy address, duplicate copies",
      documentDate: "1991-09-27",
      pages: 10,
      excerpt:
        "Duplicate five-page copies summarize ABC, NBC, and CBS evening news coverage before the President's address on defense policy and nuclear-arms reductions.",
      evidence:
        "Itemized from pages 3-7 and 37-41 of the NARA direct folder scan using duplicate White House News Summary headings, 6:30 p.m. network evening coverage title, OCR, and rendered-page review.",
    },
    {
      slug: "ap-democratic-response-mitchell-nuclear-threat",
      documentType: "Wire Story Duplicate Copies",
      category: "defense-policy-wire-story",
      disposition: "itemized-wire-story",
      title: "AP Wire Story: Democratic response to Bush nuclear-arms address",
      documentDate: "1991-09-27",
      pages: 2,
      excerpt:
        "Associated Press copy reports Senate Majority Leader George Mitchell saying Democrats welcome President Bush's nuclear-threat-reduction efforts and emphasizing economic growth.",
      evidence:
        "Itemized from duplicate AP Democratic Response pages 8 and 18 of the NARA direct folder scan using the AP-TV heading, George Mitchell text, OCR, and rendered-page review.",
    },
    {
      slug: "ap-terence-hunt-bush-abandons-tactical-nuclear-weapons-bulletins",
      documentType: "Wire Story and Bulletins",
      category: "defense-policy-wire-story",
      disposition: "itemized-wire-story",
      title:
        "AP Wire Story and bulletins by Terence Hunt: Bush abandons sea and land-based tactical nuclear weapons",
      documentDate: "1991-09-27",
      pages: 7,
      excerpt:
        "Associated Press urgent, bulletin, and lead-copy pages by Terence Hunt report Bush's order to eliminate land-based and sea-based tactical nuclear weapons, stand down strategic bombers, and seek Soviet reciprocal steps.",
      evidence:
        "Itemized from pages 9-12 and duplicate/fax-copy pages 42-44 of the NARA direct folder scan using AP-Bush urgent and bulletin headings, Terence Hunt byline, OCR, and rendered-page review.",
    },
    {
      slug: "upi-bob-lewis-bush-seeks-slash-nuclear-arsenal",
      documentType: "Wire Story Duplicate Copies",
      category: "defense-policy-wire-story",
      disposition: "itemized-wire-story",
      title: "UPI Wire Story by Bob Lewis: Bush seeks to slash nuclear arsenal",
      documentDate: "1991-09-27",
      pages: 4,
      excerpt:
        "UPI copy by Bob Lewis reports President Bush's post-Cold War defense initiative to eliminate thousands of nuclear weapons and seek Soviet matching steps.",
      evidence:
        "Itemized from pages 13-14 and duplicate/fax-copy pages 45-46 of the NARA direct folder scan using the UPI complete writethru heading, Bob Lewis byline, OCR, and rendered-page review.",
    },
    {
      slug: "reuters-arms-bush-speech-nuclear-cuts-soviet-match",
      documentType: "Wire Story and Bulletins",
      category: "defense-policy-wire-story",
      disposition: "itemized-wire-story",
      title: "Reuters Wire Stories: Bush announces sweeping nuclear cuts and asks Soviets to match",
      documentDate: "1991-09-27",
      pages: 7,
      excerpt:
        "Reuters urgent and lead-copy pages report Bush's sweeping nuclear-arms reductions, deactivation of long-range land-based missiles, tactical nuclear weapon withdrawals, and call for Soviet matching steps.",
      evidence:
        "Itemized from pages 15-17 and duplicate/fax-copy pages 47-50 of the NARA direct folder scan using Reuters AM-ARMS-BUSH-SPEECH headings, rotated-page review, OCR, and rendered-page review.",
    },
    {
      slug: "president-address-to-nation-defense-policy-september-27-1991",
      documentType: "Presidential Address Release",
      category: "presidential-address-release",
      disposition: "itemized-presidential-address-release",
      title: "Office of the Press Secretary release of President Bush's address to the nation on defense policy",
      documentDate: "1991-09-27",
      pages: 5,
      excerpt:
        "The released address from the Oval Office announces major nuclear-arms reductions, tactical nuclear weapon withdrawals, strategic bomber stand-downs, and a call for Soviet reciprocal steps.",
      evidence:
        "Itemized from pages 19-23 of the NARA direct folder scan using the Office of the Press Secretary release heading, Address by the President to the Nation title, Oval Office line, OCR, and rendered-page review.",
    },
    {
      slug: "senior-administration-official-background-briefing-defense-policy",
      documentType: "Background Briefing Transcript",
      category: "background-briefing-transcript",
      disposition: "itemized-background-briefing-transcript",
      title: "Background briefing by Senior Administration Official on defense policy address",
      documentDate: "1991-09-27",
      pages: 12,
      excerpt:
        "A senior administration official briefs reporters on the President's nuclear-arms initiative, tactical weapons, strategic systems, sea-based weapons, missile defenses, Soviet reciprocity, budget implications, and implementation timelines.",
      evidence:
        "Itemized from pages 24-35 of the NARA direct folder scan using the White House background briefing heading, Senior Administration Official label, transcript page sequence, OCR, and rendered-page review.",
    },
  ],
  470417389: [
    {
      slug: "mcclure-weekly-legislative-report-october-7-11",
      documentType: "Weekly Legislative Report",
      category: "legislative-affairs-report",
      disposition: "itemized-legislative-affairs-report",
      title: "Memorandum from Frederick D. McClure to the President re Weekly Legislative Report, October 7-11, 1991",
      documentDate: "1991-10-11",
      pages: 5,
      excerpt:
        "Frederick D. McClure briefs the President on House and Senate floor action, committee activity, appropriations, the foreign aid authorization veto threat, upcoming crime and transportation bills, and pending congressional correspondence.",
      evidence:
        "Itemized from pages 2-6 of the NARA direct folder scan using the White House memorandum heading, McClure signature line, Weekly Legislative Report subject line, OCR, and rendered-page review.",
    },
    {
      slug: "presidential-log-selected-congressional-mail",
      documentType: "Congressional Mail Log",
      category: "congressional-correspondence-log",
      disposition: "itemized-congressional-correspondence-log",
      title: "Presidential Log of Selected Congressional Mail: Week of October 4-10, 1991",
      documentDate: "1991-10-10",
      pages: 2,
      excerpt:
        "The congressional mail log summarizes selected correspondence from John Kerry, Hank Brown, Vin Weber, Claiborne Pell, Edward Feighan, Kit Bond, and Christopher Dodd.",
      evidence:
        "Itemized from a Presidential Log of Selected Congressional Mail heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "cabinet-report-highlights-october-13-19",
      documentType: "Cabinet Report Highlights",
      category: "cabinet-affairs-report",
      disposition: "itemized-cabinet-affairs-report",
      title: "Memorandum from Ede Holiday to the President re Cabinet Report Highlights, October 13-19, 1991",
      documentDate: "1991-10-11",
      pages: 2,
      excerpt:
        "Ede Holiday highlights the week ahead for the Cabinet, including Baker travel, Sullivan travel, economic releases, wetlands testimony, and education testimony.",
      evidence:
        "Itemized from the Cabinet Affairs cover page and Cabinet Report Highlights memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "cabinet-report-october-13-19",
      documentType: "Cabinet Report",
      category: "cabinet-affairs-report",
      disposition: "itemized-cabinet-affairs-report",
      title: "Memorandum from Ede Holiday to the President re Cabinet Report, October 13-19, 1991",
      documentDate: "1991-10-11",
      pages: 8,
      excerpt:
        "Ede Holiday's Cabinet Report previews agency travel, meetings, releases, testimony, and horizon items for the week of October 13-19, 1991.",
      evidence:
        "Itemized from the Cabinet Report memorandum heading and eight-page report sequence found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "cabinet-schedule-october-13-19",
      documentType: "Cabinet Schedule",
      category: "cabinet-affairs-schedule",
      disposition: "itemized-cabinet-affairs-schedule",
      title: "Cabinet Schedule for the Week of October 13-19, 1991",
      documentDate: "1991-10-11",
      pages: 3,
      excerpt:
        "Office of Cabinet Affairs schedule tables list Cabinet travel, meetings, testimony, fundraisers, and public appearances for October 13-19, 1991.",
      evidence:
        "Itemized from a three-page Cabinet Schedule table found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-sally-and-eddy-country-music-awards",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Sally and Eddy re Country Music Awards",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank Sally and Eddy for the Country Music Awards evening in Nashville.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-mark-country-music-awards",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Mark re Country Music Awards",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank Mark for the Country Music Awards evening and add a fishing wish.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-naomi-and-wynonna-judd",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Naomi Judd and Wynonna Judd re Country Music Awards",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank Naomi and Wynonna Judd for the Country Music Awards evening and send prayers to Naomi.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-david-mcconnell-school-of-excellence-pins",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to David M. McConnell re Kennebunk High School School of Excellence pins",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank David McConnell for School of Excellence pins from Kennebunk High School.",
      evidence:
        "Itemized from a presidential letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-victor-supportive-letter",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Victor re supportive words",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President thanks Victor for kind and supportive words and for staying in touch.",
      evidence:
        "Itemized from a presidential letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-october-11-update",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Friday, October 11, 1991, 1:15 P.M. EDT Update",
      documentDate: "1991-10-11",
      pages: 2,
      excerpt:
        "The White House News Summary update covers Anita Hill and Clarence Thomas testimony, Bush reelection steps, economic confidence, and news headlines.",
      evidence:
        "Itemized from a White House News Summary heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "point-of-light-youth-development-incorporated",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press Release: Youth Development, Incorporated named the 585th Daily Point of Light",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The White House announces Youth Development, Incorporated of Albuquerque, New Mexico, as the 585th Daily Point of Light.",
      evidence:
        "Itemized from an Office of the Press Secretary release heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "veto-message-s1722-emergency-unemployment-compensation",
      documentType: "Veto Message",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title: "Message to the Senate returning S. 1722, Emergency Unemployment Compensation Act of 1991, without approval",
      documentDate: "1991-10-11",
      pages: 2,
      excerpt:
        "President Bush returns S. 1722 without approval, arguing that the emergency unemployment compensation bill would breach the budget agreement and threaten recovery.",
      evidence:
        "Itemized from an Office of the Press Secretary message heading and signed continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "fitzwater-press-briefing-october-11-1991",
      documentType: "Press Briefing Transcript",
      category: "press-briefing-transcript",
      disposition: "itemized-press-briefing-transcript",
      title: "Press Briefing by Marlin Fitzwater, October 11, 1991",
      documentDate: "1991-10-11",
      pages: 10,
      excerpt:
        "The Marlin Fitzwater press briefing covers the unemployment-compensation veto, the President's schedule, the Bush-Quayle campaign committee, Judge Thomas hearings, retail prices, and the Middle East peace process.",
      evidence:
        "Itemized from the press-briefing index and transcript pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "apn-daily-briefing-american-politics-october-11-1991",
      documentType: "Daily Political Briefing",
      category: "daily-political-briefing-item",
      disposition: "itemized-daily-political-briefing",
      title: "The Daily Briefing on American Politics: Friday, October 11, 1991",
      documentDate: "1991-10-11",
      pages: 20,
      excerpt:
        "The American Political Network Daily Briefing covers White House '92, Democratic candidates, Clarence Thomas, Casolaro, state campaigns, Senate watch, polling, and television monitoring.",
      evidence:
        "Itemized from The Daily Briefing on American Politics heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-october-11-1991",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Friday, October 11, 1991",
      documentDate: "1991-10-11",
      pages: 10,
      excerpt:
        "Mrs. Bush's Press Office clipping packet includes coverage of Barbara Bush, Governor Sununu, Marlin Fitzwater, and related First Lady press material.",
      evidence:
        "Itemized from a Mrs. Bush's Press Office Daily Press Clippings cover page and clipping run found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-ricky-country-music-awards",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Ricky re Country Music Awards",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank Ricky for the Country Music Awards evening and for keeping the President in his prayers.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-trisha-yearwood-country-music-awards",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Trisha Yearwood re Country Music Awards",
      documentDate: "1991-10-11",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush thank Trisha Yearwood for the Country Music Awards evening and note that country and western music will continue to play in the White House.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
  470417446: [
    {
      slug: "pool-report-one-going-to-kansas-city",
      documentType: "Pool Report",
      category: "travel-pool-report",
      disposition: "itemized-pool-report",
      title: "Pool Report #1: Going to Kansas City",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "The first pool report from the November 13 trip notes the Air Force One flight to Kansas City, Senators Christopher Bond and John Danforth aboard, and travel chatter before the FFA convention stop.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using the Pool Report #1 heading, Going to Kansas City title, OCR, and rendered-page review.",
    },
    {
      slug: "ffa-convention-kansas-city-remarks-draft",
      documentType: "Speech/Remarks Draft",
      category: "speech-remarks-draft",
      disposition: "itemized-speech-remarks-draft",
      title: "Draft remarks for the FFA Convention in Kansas City, Missouri",
      documentDate: "1991-11-13",
      pages: 12,
      excerpt:
        "The draft FFA Convention remarks cover agricultural education, America 2000, rural leadership, competitiveness, capital gains, banking reform, trade, GATT, NAFTA, and post-Communist market openings.",
      evidence:
        "Itemized from pages 3-14 of the NARA direct folder scan using the FFA Convention heading, page sequence, OCR, and rendered-page review.",
    },
    {
      slug: "pool-report-st-louis-to-andrews-cardinals-note",
      documentType: "Pool Report and Presidential Handwriting",
      category: "travel-pool-report",
      disposition: "itemized-pool-report",
      title: "Pool report from St. Louis to Andrews with President Bush's Cardinals response",
      documentDate: "1991-11-13",
      pages: 3,
      excerpt:
        "The return-flight pool report reproduces the pool's football note to the President, Bush's handwritten response about the Houston Oilers and St. Louis Cardinals, and a marked-up FFA speech page.",
      evidence:
        "Itemized from pages 15-17 of the NARA direct folder scan using the St. Louis to Andrews pool report, Bush Library handwriting photocopies, OCR, and rendered-page review.",
    },
    {
      slug: "possible-questions-press-availability-november-13",
      documentType: "Press Availability Q&A",
      category: "press-availability-qa",
      disposition: "itemized-press-availability-qa",
      title: "Possible questions for press availability, November 13, 1991",
      documentDate: "1991-11-13",
      pages: 3,
      excerpt:
        "The press-availability Q&A anticipates questions on Soviet humanitarian aid, Prime Minister Shamir, Saudi Arabia blood donation, foreign policy, and domestic policy.",
      evidence:
        "Itemized from pages 18-20 of the NARA direct folder scan using the Possible Questions for Press Availability heading, dated Q&A pages, OCR, and rendered-page review.",
    },
    {
      slug: "st-louis-affiliates-interview-questions-and-answers",
      documentType: "Local Affiliate Interview Q&A",
      category: "press-availability-qa",
      disposition: "itemized-local-affiliate-qa",
      title: "Possible questions and answers for St. Louis affiliates interviews",
      documentDate: "1991-11-13",
      pages: 4,
      excerpt:
        "The St. Louis affiliates Q&A prepares answers on McDonnell Douglas layoffs, Zenith production, tax deductions, violent crime, HUD matters, Cochran Gardens, and education reform.",
      evidence:
        "Itemized from pages 21-24 of the NARA direct folder scan using the Possible Questions and Answers for St. Louis Affiliates Interviews heading, OCR, and rendered-page review.",
    },
    {
      slug: "bond-fundraiser-st-louis-marked-remarks-draft",
      documentType: "Speech/Remarks Draft with Handwriting",
      category: "fundraiser-remarks-draft",
      disposition: "itemized-speech-remarks-draft",
      title: "Marked draft remarks for Senator Kit Bond fundraiser in St. Louis",
      documentDate: "1991-11-13",
      pages: 15,
      excerpt:
        "The marked fundraiser draft introduces Missouri Republican figures, praises Kit Bond, attacks congressional inaction, argues for domestic and international leadership, and closes with Bond's campaign motto.",
      evidence:
        "Itemized from pages 25-39 of the NARA direct folder scan using the Bond Fundraiser St. Louis heading, Bush handwriting photocopies, page sequence, OCR, and rendered-page review.",
    },
    {
      slug: "kit-bond-thank-you-note-and-presidential-reply",
      documentType: "Incoming Note and Presidential Reply",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Kit Bond thank-you note and President Bush reply note after St. Louis fundraiser",
      documentDate: "1991-11-14",
      pages: 1,
      excerpt:
        "Kit Bond thanks the President for the St. Louis Celebrate America appearance, with a Bush handwritten reply thanking Bond and apologizing for missing Margaret Kelly.",
      evidence:
        "Itemized from page 40 of the NARA direct folder scan using the Kit Bond note, The President Has Seen stamp, Bush reply note, OCR, and rendered-page review.",
    },
    {
      slug: "press-release-remarks-kit-bond-fundraiser-st-louis",
      documentType: "Presidential Remarks Release",
      category: "presidential-remarks-release",
      disposition: "itemized-presidential-remarks-release",
      title: "Office of the Press Secretary release of President Bush's remarks at fundraiser for Senator Kit Bond",
      documentDate: "1991-11-13",
      pages: 6,
      excerpt:
        "The released remarks at Riverport Amphitheater praise Kit Bond, criticize congressional inaction, discuss capital gains, banking, crime, energy, education, transportation, trade, and foreign policy.",
      evidence:
        "Itemized from pages 41-46 of the NARA direct folder scan using the Office of the Press Secretary heading, St. Louis dateline, remarks title, transcript page sequence, OCR, and rendered-page review.",
    },
    {
      slug: "bert-walker-bond-event-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "George H. Walker III correspondence with President Bush re Bond event",
      documentDate: "1991-11-20",
      pages: 3,
      excerpt:
        "The packet includes President Bush's letter to Bert Walker after missing him at the Bond event, Walker's note praising the Riverport appearance, and a photocopied handwritten Bush note.",
      evidence:
        "Itemized from pages 47-49 of the NARA direct folder scan using the From the President stationery, Walker note, Bush handwriting photocopy, OCR, and rendered-page review.",
    },
    {
      slug: "magic-johnson-aids-commission-correspondence-packet",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Magic Johnson AIDS Commission correspondence packet",
      documentDate: "1991-11-13",
      pages: 5,
      excerpt:
        "The packet routes and transmits President Bush's letter urging Magic Johnson to join the National AIDS Commission and offering a White House announcement if he accepts.",
      evidence:
        "Itemized from pages 50-54 of the NARA direct folder scan using the Phillip Brady routing sheet, Patty Presock note, Magic Johnson letter pages, photocopy, OCR, and rendered-page review.",
    },
    {
      slug: "ted-sanders-resignation-response-packet",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Ted Sanders resignation response packet",
      documentDate: "1991-11-13",
      pages: 3,
      excerpt:
        "The packet includes a handwritten presidential note, President Bush's formal letter accepting Ted Sanders's resignation as Deputy Secretary of Education, and Sanders's August 8 resignation letter.",
      evidence:
        "Itemized from pages 55-57 of the NARA direct folder scan using the presidential note, White House letter, Department of Education letterhead, OCR, and rendered-page review.",
    },
    {
      slug: "domenici-letter-forwarded-to-frank-donatelli",
      documentType: "Incoming Congressional Letter with Presidential Note",
      category: "congressional-correspondence",
      disposition: "itemized-congressional-correspondence",
      title: "Pete Domenici letter forwarded by President Bush to Frank Donatelli",
      documentDate: "1991-10-28",
      pages: 2,
      excerpt:
        "President Bush forwards Senator Pete Domenici's letter on savings incentives and tax policy to Frank Donatelli, asking him to review Domenici's comments.",
      evidence:
        "Itemized from pages 58-59 of the NARA direct folder scan using the From the desk of George Bush note, United States Senate letterhead, handwritten annotations, OCR, and rendered-page review.",
    },
    {
      slug: "bill-grant-call-note-florida-senate-race",
      documentType: "Telephone Message Note",
      category: "telephone-message",
      disposition: "itemized-telephone-message",
      title: "Bill Grant call note re Florida Senate race",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "A White House note reports that former Congressman Bill Grant wanted to speak only to the President about the Florida Senate race, with handwritten routing to Ron Kaufman.",
      evidence:
        "Itemized from page 60 of the NARA direct folder scan using the White House note, Bill Grant text, handwritten routing, OCR, and rendered-page review.",
    },
    {
      slug: "tommy-thompson-economic-policy-correspondence-packet",
      documentType: "Presidential Correspondence Packet",
      category: "economic-policy-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Tommy Thompson economic-policy correspondence packet",
      documentDate: "1991-11-13",
      pages: 6,
      excerpt:
        "The packet includes President Bush's note to Governor Tommy Thompson, Staff Secretary routing to Ede Holiday, a presidential instruction to share Thompson's letter with EPC members, and Thompson's economic-policy letter.",
      evidence:
        "Itemized from pages 61-66 of the NARA direct folder scan using White House notes, Tommy Thompson letterhead, handwritten photocopy, OCR, and rendered-page review.",
    },
    {
      slug: "dorrance-smith-post-mortem-coverage-cbs-oo-interviews",
      documentType: "Media Coverage Memorandum",
      category: "media-coverage-memorandum",
      disposition: "itemized-media-coverage-memorandum",
      title: "Memorandum from Dorrance Smith to the President re post-mortem coverage of CBS O&O interviews",
      documentDate: "1991-11-08",
      pages: 1,
      excerpt:
        "Dorrance Smith reports how the President's October 17 interviews played on CBS owned-and-operated stations in New York, Philadelphia, Chicago, Detroit, Boston, and Miami.",
      evidence:
        "Itemized from page 67 of the NARA direct folder scan using the White House memorandum heading, Smith signature line, CBS O&O subject line, OCR, and rendered-page review.",
    },
    {
      slug: "boskin-note-october-cpi-retail-sales",
      documentType: "Economic Briefing Note",
      category: "economic-analysis-memorandum",
      disposition: "itemized-economic-analysis-memorandum",
      title: "Note from Michael Boskin to the President re October Consumer Price Index and retail sales",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "Michael Boskin summarizes October CPI and retail sales, noting that inflation was about as expected while retail sales were slightly down.",
      evidence:
        "Itemized from page 68 of the NARA direct folder scan using the Council of Economic Advisers heading, Boskin signature line, handwritten note, OCR, and rendered-page review.",
    },
    {
      slug: "boskin-consumer-price-indexes-october",
      documentType: "Economic Analysis Memorandum",
      category: "economic-analysis-memorandum",
      disposition: "itemized-economic-analysis-memorandum",
      title: "Memorandum from Michael J. Boskin to the President re Consumer Price Indexes for October",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "Boskin reports the October CPI increase, the lowest year-over-year consumer price inflation since June 1987, with a chart on consumer price inflation.",
      evidence:
        "Itemized from page 69 of the NARA direct folder scan using the Council of Economic Advisers memorandum heading, CPI subject line, chart, OCR, and rendered-page review.",
    },
    {
      slug: "boskin-october-retail-sales",
      documentType: "Economic Analysis Memorandum",
      category: "economic-analysis-memorandum",
      disposition: "itemized-economic-analysis-memorandum",
      title: "Memorandum from Michael J. Boskin to the President re October retail sales",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "Boskin reports that October retail sales fell 0.1 percent, with charts on total retail sales and real sales excluding autos.",
      evidence:
        "Itemized from page 70 of the NARA direct folder scan using the Council of Economic Advisers memorandum heading, retail sales subject line, charts, OCR, and rendered-page review.",
    },
    {
      slug: "john-silber-letter-vietnamese-repatriation",
      documentType: "Incoming Letter with Presidential Handwriting",
      category: "human-rights-correspondence",
      disposition: "itemized-incoming-correspondence",
      title: "Letter from John Silber to President Bush re Vietnamese repatriation",
      documentDate: "1991-11-09",
      pages: 1,
      excerpt:
        "John Silber writes after the President's visit with the Pope to express concern about British and Hong Kong policy on forced Vietnamese repatriation.",
      evidence:
        "Itemized from page 71 of the NARA direct folder scan using the dated incoming letter, handwritten presidential annotations, OCR, and rendered-page review.",
    },
    {
      slug: "cardinal-law-fax-vietnamese-repatriation",
      documentType: "Incoming Faxed Letter",
      category: "human-rights-correspondence",
      disposition: "itemized-incoming-correspondence",
      title: "Faxed letter from Bernard Cardinal Law to President Bush re Vietnamese repatriation",
      documentDate: "1991-11-09",
      pages: 3,
      excerpt:
        "Cardinal Law faxes a handwritten letter thanking the President for his visit with the Pope and urging action on Vietnamese repatriation from Hong Kong camps.",
      evidence:
        "Itemized from pages 72-74 of the NARA direct folder scan using the Cardinal's Residence fax cover, handwritten letter pages, OCR, and rendered-page review.",
    },
    {
      slug: "sharon-bush-flight-of-the-avenger-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Sharon Bush correspondence re Flight of the Avenger",
      documentDate: "1991-11-13",
      pages: 5,
      excerpt:
        "The packet includes President Bush's note to Sharon Bush about John R. Bruning's Flight of the Avenger, related envelope or backing pages, a Sharon Bush note, and the book cover photocopy.",
      evidence:
        "Itemized from pages 75-79 of the NARA direct folder scan using White House stationery, Bush handwriting photocopies, the Flight of the Avenger cover, OCR, and rendered-page review.",
    },
    {
      slug: "fred-zeder-addressed-envelope",
      documentType: "Envelope",
      category: "presidential-correspondence-envelope",
      disposition: "itemized-envelope",
      title: "Envelope addressed to Fred M. Zeder II at the Overseas Private Investment Corporation",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "A White House envelope is addressed to Fred M. Zeder II, President and Chief Executive Officer of the Overseas Private Investment Corporation.",
      evidence:
        "Itemized from page 80 of the NARA direct folder scan using the White House envelope address block, OCR, and rendered-page review.",
    },
    {
      slug: "president-to-heinz-prechter-commercial-issues",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from President Bush to Heinz Prechter re commercial issues in foreign contacts",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "President Bush thanks Heinz Prechter for appreciating the Administration's increased focus on commercial issues in official contacts with foreign countries.",
      evidence:
        "Itemized from page 81 of the NARA direct folder scan using White House letterhead, Heinz Prechter addressee block, OCR, and rendered-page review.",
    },
    {
      slug: "president-to-bebe-and-harold-point-mugu",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from President Bush to Bebe and Harold re Point Mugu greeting",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "President Bush thanks Bebe and Harold for coming to Point Mugu to greet the President and Mrs. Bush the previous week.",
      evidence:
        "Itemized from page 82 of the NARA direct folder scan using presidential stationery, Bebe and Harold salutation, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-november-13-1115-update",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Wednesday, November 13, 1991, 11:15 a.m. EST update",
      documentDate: "1991-11-13",
      pages: 2,
      excerpt:
        "The 11:15 a.m. update covers wholesale prices, General Motors, Judge Thomas, Middle East peace talks, savings and loan matters, and President Bush's schedule.",
      evidence:
        "Itemized from pages 83-84 of the NARA direct folder scan using the White House News Summary heading, update time, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-november-13-kansas-city-update",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Wednesday, November 13, 1991, 3:00 p.m. EST/2:00 p.m. Kansas City update",
      documentDate: "1991-11-13",
      pages: 2,
      excerpt:
        "The Kansas City update covers jobless benefits, President Bush's trip, Thomas hearing stories, congressional activity, crime and drugs, Dan Quayle, FDA drug approval, and related items.",
      evidence:
        "Itemized from pages 85-86 of the NARA direct folder scan using the White House News Summary heading, Kansas City update time, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-november-13-445-update",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: Wednesday, November 13, 1991, 4:45 p.m. EST/3:45 p.m. CST update",
      documentDate: "1991-11-13",
      pages: 1,
      excerpt:
        "The late afternoon update summarizes wire coverage of President Bush's FFA speech, the Congress in print, Secretary Baker, Middle East peace talks, and other news items.",
      evidence:
        "Itemized from page 87 of the NARA direct folder scan using the White House News Summary heading, 4:45 p.m. update time, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-bulletin-todays-briefing-november-13",
      documentType: "White House Bulletin",
      category: "white-house-bulletin",
      disposition: "itemized-white-house-bulletin",
      title: "The White House Bulletin: Today's Briefing, November 13, 1991",
      documentDate: "1991-11-13",
      pages: 6,
      excerpt:
        "The White House Bulletin briefing covers morning papers, FDA drug-review policy, health care reform, Bush's congressional critique, campaign staffing, census data, polling, political analysis, schedules, and late jokes.",
      evidence:
        "Itemized from pages 88-93 of the NARA direct folder scan using The White House Bulletin heading, Today's Briefing subject line, page sequence, OCR, and rendered-page review.",
    },
    {
      slug: "mrs-bush-press-clippings-november-13-1991",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Wednesday, November 13, 1991",
      documentDate: "1991-11-13",
      pages: 17,
      excerpt:
        "Mrs. Bush's Press Office clipping packet includes coverage of Barbara Bush's Read Aloud appearance, National Education Goals coverage, Oprah Winfrey child-abuse testimony, health stories, and related clippings.",
      evidence:
        "Itemized from pages 94-110 of the NARA direct folder scan using the Mrs. Bush's Press Office Daily Press Clippings cover page, clipping sequence, OCR, and rendered-page review.",
    },
    {
      slug: "transferred-ffa-white-house-photograph",
      documentType: "Transfer Sheet and Photograph",
      category: "transferred-photograph",
      disposition: "itemized-transferred-photograph",
      title: "Transfer sheet and White House photograph from Future Farmers of America event",
      documentDate: "1991-11-13",
      pages: 2,
      excerpt:
        "The audiovisual transfer sheet describes a White House photograph from the Future Farmers of America event, followed by a photocopied photograph with attached note.",
      evidence:
        "Itemized from pages 111-112 of the NARA direct folder scan using the George Bush Presidential Library transfer sheet, photograph page, attached note, OCR, and rendered-page review.",
    },
  ],
  470417483: [
    {
      slug: "december-5-press-conference-room-layout",
      documentType: "Press Conference Room Layout",
      category: "press-conference-briefing-material",
      disposition: "itemized-press-conference-briefing-material",
      title: "Lower Press Office room layout for December 5 press conference",
      documentDate: "1991-12-05",
      pages: 1,
      excerpt:
        "The room layout maps the Lower Press Office setup for the President's December 5 press conference, including advisers, correspondents, cameras, and still photographers.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using rendered-page review of the press-conference layout diagram.",
    },
    {
      slug: "possible-questions-december-5-press-conference",
      documentType: "Press Conference Q&A",
      category: "press-conference-briefing-material",
      disposition: "itemized-press-conference-qa",
      title: "Possible questions for December 5 press conference",
      documentDate: "1991-12-05",
      pages: 2,
      excerpt:
        "The question sheet prepares the President for likely press-conference questions on campaign politics, national security, foreign policy, the economy, hostages, and unemployment.",
      evidence:
        "Itemized from pages 3-4 of the NARA direct folder scan using OCR and rendered-page review of the possible-questions sheet.",
    },
    {
      slug: "president-statement-new-advisers-economic-steps",
      documentType: "Statement",
      category: "presidential-statement",
      disposition: "itemized-presidential-statement",
      title:
        "Statement by the President re new White House and campaign advisers and economic acceleration steps",
      documentDate: "1991-12-05",
      pages: 11,
      excerpt:
        "President Bush introduces Sam Skinner as Chief of Staff, names senior campaign advisers, discusses John Sununu's transition, and previews economic growth proposals.",
      evidence:
        "Itemized from statement pages, handwriting pages, and a clean statement copy found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "nam-executive-committee-event-briefing",
      documentType: "Event Briefing",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title:
        "Event briefing for meeting with National Association of Manufacturers Executive Committee",
      documentDate: "1991-12-05",
      pages: 3,
      excerpt:
        "The event briefing outlines the President's Roosevelt Room meeting with NAM leaders, including purpose, background, participants, press plan, and a seating diagram.",
      evidence:
        "Itemized from pages 16-18 of the NARA direct folder scan using OCR and rendered-page review of the event briefing and seating diagram.",
    },
    {
      slug: "nam-meeting-talking-points",
      documentType: "Talking Points",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title: "Talking Points for meeting with National Association of Manufacturers",
      documentDate: "1991-12-05",
      pages: 3,
      excerpt:
        "Talking points for the President's Roosevelt Room meeting with NAM discuss the economy, manufacturing productivity, exports, regulatory relief, taxes, and the coming Asia trip.",
      evidence:
        "Itemized from the Meeting with National Association of Manufacturers attachment sequence found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "porter-memo-nam-executive-committee",
      documentType: "Memorandum",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title:
        "Memorandum from Roger B. Porter to the President re meeting with National Association of Manufacturers Executive Committee",
      documentDate: "1991-12-04",
      pages: 3,
      excerpt:
        "Roger Porter briefs the President on the NAM Executive Committee meeting and calls attention to letters sent on the President's behalf to NAM leaders.",
      evidence:
        "Itemized from the Porter memorandum and following handwritten-note pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "nam-executive-committee-attendees",
      documentType: "Participant List",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title: "Attendees at NAM Executive Committee meeting, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 3,
      excerpt:
        "The attendee list names administration participants and NAM Executive Committee members scheduled for the December 5 Roosevelt Room meeting.",
      evidence:
        "Itemized from the three-page attendee list in the NAM meeting materials found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-response-nam-team-b-japan",
      documentType: "Letter",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title:
        "White House response to Jerry Jasinowski re NAM proposal for a Team B on U.S. economic policy toward Japan",
      documentDate: "1991-06-12",
      pages: 3,
      excerpt:
        "The White House response thanks Jerry Jasinowski and NAM for trade-policy work and discusses Japan, market access, competitiveness, and U.S.-Japan relations.",
      evidence:
        "Itemized from the June 12, 1991 response letter attached to the NAM meeting materials in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "jasinowski-letter-economic-team-b-japan",
      documentType: "Incoming Letter",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title:
        "Letter from Jerry J. Jasinowski to the President re an economic Team B on U.S. international economic policy toward Japan",
      documentDate: "1991-03-13",
      pages: 3,
      excerpt:
        "Jerry Jasinowski urges the President to create a special task force to reassess U.S. international economic goals and objectives, especially as they relate to Japan.",
      evidence:
        "Itemized from the March 13, 1991 NAM letter attached to the meeting materials in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "porter-response-nam-economic-policy-letter",
      documentType: "Letter",
      category: "meeting-briefing-attachment",
      disposition: "itemized-meeting-briefing-attachment",
      title: "Letter from Roger B. Porter to Dexter Baker and Jerry Jasinowski re NAM economic policy views",
      documentDate: "1991-11-12",
      pages: 2,
      excerpt:
        "Roger Porter thanks Dexter Baker and Jerry Jasinowski for NAM's views on economic policy and discusses fiscal restraint and growth policy.",
      evidence:
        "Itemized from the November 12, 1991 Porter letter attached to the NAM meeting materials in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "rogich-memo-no-greater-love-hostages",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum from Sig Rogich to Governor Sununu re unannounced stop at No Greater Love headquarters",
      documentDate: "1991-12-04",
      pages: 2,
      excerpt:
        "Sig Rogich proposes that the President make an unannounced stop at No Greater Love headquarters, with presidential handwriting discussing released hostages.",
      evidence:
        "Itemized from the Rogich memorandum and attached presidential note page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "president-note-brent-mosbacher-japan-trip",
      documentType: "President's Note",
      category: "president-note-item",
      disposition: "itemized-president-note",
      title: "Note from the President to Brent re Robert Mosbacher's Japan trip and Sam Skinner",
      documentDate: "1991-12-06",
      pages: 1,
      excerpt:
        "The President notes that Robert Mosbacher will continue with plans to travel to Japan, that the trip will emphasize jobs, and that Sam Skinner will not go.",
      evidence:
        "Itemized from a December 6, 1991 note headed 'FROM THE PRESIDENT' found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "hooks-minority-scholarships-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Correspondence packet re Benjamin Hooks and minority scholarships policy",
      documentDate: "1991-12-04",
      pages: 4,
      excerpt:
        "The packet includes a presidential reply to Benjamin Hooks, an Ede Holiday memorandum to the President, Hooks's incoming letter on Education Department minority-scholarship policy, and related handwritten routing.",
      evidence:
        "Itemized from the presidential reply, Ede Holiday memorandum, Benjamin Hooks incoming letter, and handwritten routing page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "zamaria-combined-federal-campaign-memo",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum from Rose Zamaria to White House staff re 1991 Combined Federal Campaign",
      documentDate: "1991-12-05",
      pages: 2,
      excerpt:
        "Rose Zamaria extends the White House Combined Federal Campaign deadline because the White House had not yet met its 1991 goal.",
      evidence:
        "Itemized from the December 5, 1991 Combined Federal Campaign memorandum and routing page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bush-quayle-1992-fundraising-summary",
      documentType: "Campaign Finance Summary",
      category: "campaign-finance-item",
      disposition: "itemized-campaign-finance-summary",
      title: "Bush-Quayle '92 Fundraising Summary, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 4,
      excerpt:
        "The fundraising summary compares 1984 and 1992 presidential primary funds raised, projects amounts to be raised, and lists fundraising by time period and solicitation type.",
      evidence:
        "Itemized from the Bush-Quayle '92 Fundraising Summary pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "clayton-yeutter-fundraiser-correspondence",
      documentType: "Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Clayton Yeutter correspondence packet re offer to host a Bush-Quayle fundraiser",
      documentDate: "1991-12-05",
      pages: 5,
      excerpt:
        "The packet includes routing material, an incoming offer to host a fundraiser, and a presidential response to Clayton about the fundraising proposal.",
      evidence:
        "Itemized from the routing pages, incoming November 26 letter, and December 5 presidential response found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "republican-eagles-economic-issues-correspondence",
      documentType: "Memorandum Packet",
      category: "economic-policy-correspondence",
      disposition: "itemized-economic-policy-correspondence",
      title: "Republican Eagles Economic Issues Committee correspondence and analysis packet",
      documentDate: "1991-12-04",
      pages: 11,
      excerpt:
        "The packet includes a Roger Porter memorandum to the President, Yeutter and Laughery forwarding material, the Republican Eagles economic-growth letter, signatures, and a presidential reply to Clayton.",
      evidence:
        "Itemized from the Republican Eagles memorandum, forwarding notes, incoming committee letter, signature pages, and presidential response found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "torricelli-letter-to-president-december-1991",
      documentType: "Incoming Letter",
      category: "congressional-correspondence",
      disposition: "itemized-congressional-correspondence",
      title: "Letter from Representative Robert G. Torricelli to President Bush re Japan and World War II comments",
      documentDate: "1991-12-05",
      pages: 1,
      excerpt:
        "Representative Robert G. Torricelli thanks President Bush for recent comments concerning Japan and the historic events of World War II.",
      evidence:
        "Itemized from the congressional letterhead page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "warburg-memorial-program-letter",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Mr. and Mrs. Warburg re Max Warburg Memorial Program",
      documentDate: "1991-12-04",
      pages: 2,
      excerpt:
        "The President writes to Mr. and Mrs. Warburg about the Max Warburg Memorial Program for sixth graders in the Boston Public Schools, with a related routing note.",
      evidence:
        "Itemized from the presidential letter and related note page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "president-letter-betsy-walter-walkers-point",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Betsy and Walter re Walker's Point",
      documentDate: "1991-12-05",
      pages: 2,
      excerpt:
        "The President and Mrs. Bush thank Betsy and Walter for their note of concern about the Bush house in Kennebunkport after storm damage at Walker's Point, with a related handwritten note page.",
      evidence:
        "Itemized from the December 5, 1991 presidential letter and related handwritten-note page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "lake-superior-center-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Correspondence packet re Peter's project for the Lake Superior Center",
      documentDate: "1991-12-05",
      pages: 3,
      excerpt:
        "The packet includes a presidential reply about Peter's Lake Superior Center project, an incoming ARCO letter from L. M. Cook, and related handwritten routing material.",
      evidence:
        "Itemized from the presidential reply, ARCO incoming letter, and handwritten routing page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "daily-tally-comments-december-5-1991",
      documentType: "Public Comment Tally",
      category: "public-comment-tally",
      disposition: "itemized-public-comment-tally",
      title: "Daily Tally Sheet and comments for Thursday, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 5,
      excerpt:
        "The tally sheet and continuation comments summarize public calls and comments to the White House on the President, Haiti, the Soviet Union, capital gains, health insurance, and other topics.",
      evidence:
        "Itemized from the Daily Tally Sheet and continuation comment pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "acceleration-project-fact-sheet",
      documentType: "Fact Sheet",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Fact Sheet: Acceleration Project",
      documentDate: "1991-12-05",
      pages: 2,
      excerpt:
        "The Office of the Press Secretary fact sheet explains criteria and agency examples for accelerating already-appropriated funds for earliest possible expenditure.",
      evidence:
        "Itemized from the December 5, 1991 Office of the Press Secretary fact sheet found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-updates-december-5-1991",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary updates, Thursday, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 4,
      excerpt:
        "White House News Summary updates at 10:30 a.m., 1:00 p.m., and 4:45 p.m. cover jobless claims, factory orders, the press conference, EPA pollution allowances, and Middle East talks.",
      evidence:
        "Itemized from the White House News Summary update pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "wire-clipping-packet-december-5-1991",
      documentType: "Wire Clipping Packet",
      category: "wire-clipping-packet",
      disposition: "itemized-wire-clipping-packet",
      title: "Wire service clipping packet, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 24,
      excerpt:
        "The wire-clipping run includes AP, UPI, and Reuters stories on economic recovery planning, Bush and Mandela, Middle East talks, Libya, the campaign team, Japan, Kuwait, and Venezuela.",
      evidence:
        "Itemized as a packet from rendered page review of the low-confidence OCR wire-story run in the NARA direct folder scan.",
    },
    {
      slug: "fitzwater-memo-bush-family-wsj-article",
      documentType: "Memorandum and Press Statement",
      category: "press-office-memorandum",
      disposition: "itemized-press-office-memorandum",
      title: "Memorandum from Marlin Fitzwater to the President's family re Wall Street Journal article",
      documentDate: "1991-12-05",
      pages: 3,
      excerpt:
        "Marlin Fitzwater briefs the President's family on a forthcoming Wall Street Journal article about Bush family business activities and attaches the White House statement.",
      evidence:
        "Itemized from the Fitzwater memorandum and attached December 4 press statement found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-office-daily-clippings-december-5-1991",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Thursday, December 5, 1991",
      documentDate: "1991-12-05",
      pages: 13,
      excerpt:
        "The First Lady press-clipping packet includes White House holiday coverage, Bush family and shopping stories, Sununu coverage, Prescott Bush coverage, and absentee-voting stories.",
      evidence:
        "Itemized from the Mrs. Bush's Press Office Daily Press Clippings cover page and clipping run found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "transferred-white-house-photographs-december-5-1991",
      documentType: "Transfer Sheet and Photographs",
      category: "transferred-photograph",
      disposition: "itemized-transferred-photograph",
      title:
        "Transfer sheet and White House photograph photocopies from December 5 press-conference packet",
      documentDate: "1991-12-05",
      pages: 9,
      excerpt:
        "The audiovisual transfer sheet and photocopied White House photographs document visual material separated from the December 5 press-conference packet.",
      evidence:
        "Itemized from pages 124-132 of the NARA direct folder scan using the George Bush Presidential Library transfer sheet, photograph photocopies, OCR, and rendered-page review.",
    },
  ],
  470417505: [
    {
      slug: "presock-memo-peggy-noonan-letter",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum for the file from Patricia Presock re Peggy Noonan's letter",
      documentDate: "1991-12-17",
      pages: 1,
      excerpt:
        "Patricia Presock records that Peggy Noonan's letter surfaced while POTUS was traveling, that she spoke with Noonan, and that no further action was required.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using OCR and rendered-page review of the Presock memorandum.",
    },
    {
      slug: "transferred-nancy-bush-ellis-photograph",
      documentType: "Transfer Sheet and Photograph",
      category: "transferred-photograph",
      disposition: "itemized-transferred-photograph",
      title: "Transfer sheet and photocopied photograph of Nancy Bush Ellis with child",
      documentDate: "1991-12-17",
      pages: 3,
      excerpt:
        "The audiovisual transfer sheet describes a photograph of Nancy Bush Ellis with a child on her lap, followed by photocopied photograph pages.",
      evidence:
        "Itemized from pages 3-5 of the NARA direct folder scan using the George Bush Presidential Library transfer sheet and rendered-page review.",
    },
    {
      slug: "peggy-noonan-lesley-stahl-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Peggy Noonan correspondence re Lesley Stahl birthday request",
      documentDate: "1991-12-12",
      pages: 3,
      excerpt:
        "Peggy Noonan asks President Bush to telephone Lesley Stahl for her fiftieth birthday and sends Patty Presock a related handwritten note and address page.",
      evidence:
        "Itemized from pages 6-8 of the NARA direct folder scan using OCR and rendered-page review of the Noonan letter, handwritten note, and address page.",
    },
    {
      slug: "rocco-martino-support-letter-response",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Rocco Leonard Martino support letter and presidential reply",
      documentDate: "1991-12-12",
      pages: 2,
      excerpt:
        "The packet includes a presidential reply to Rocco Leonard Martino and Martino's incoming letter to Jane Leonard praising the President's remarks.",
      evidence:
        "Itemized from pages 9-10 of the NARA direct folder scan using OCR and rendered-page review of the presidential reply and incoming XRT Financial Systems letter.",
    },
    {
      slug: "craig-thomas-support-correspondence",
      documentType: "Congressional Correspondence Packet",
      category: "congressional-correspondence",
      disposition: "itemized-congressional-correspondence",
      title: "Craig Thomas support letter and presidential reply",
      documentDate: "1991-12-17",
      pages: 2,
      excerpt:
        "Representative Craig Thomas thanks the President for his 1991 leadership and urges Republicans to set concrete goals; President Bush replies with thanks and good wishes.",
      evidence:
        "Itemized from pages 11-12 of the NARA direct folder scan using OCR and rendered-page review of the presidential reply and Thomas incoming letter.",
    },
    {
      slug: "diplomatic-holiday-photo-correspondence-salah-ould-daddah",
      documentType: "Diplomatic Correspondence Packet",
      category: "diplomatic-correspondence",
      disposition: "itemized-diplomatic-correspondence",
      title:
        "Diplomatic holiday and photograph correspondence re Fadwa and Abdullah Salah and Abdella Ould Daddah",
      documentDate: "1991-12-17",
      pages: 5,
      excerpt:
        "The diplomatic packet includes Barbara Bush handwriting, a presidential note to Fadwa and Abdullah Salah, a handwritten holiday message, and signed photograph material for Abdella Ould Daddah.",
      evidence:
        "Itemized from pages 13-17 of the NARA direct folder scan using OCR and rendered-page review of the handwritten card material, Salah correspondence, and Ould Daddah photograph page.",
    },
    {
      slug: "saint-johns-hospital-weintraub-gift-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Saint John's Hospital gift correspondence with Jerome Weintraub",
      documentDate: "1991-12-17",
      pages: 3,
      excerpt:
        "President Bush writes Jerome Weintraub about the Saint John's Hospital gift made in the President and Mrs. Bush's name, with the hospital's incoming notification letter.",
      evidence:
        "Itemized from pages 18-20 of the NARA direct folder scan using OCR and rendered-page review of the presidential letter, note page, and Saint John's Hospital letter.",
    },
    {
      slug: "douglas-dillon-brady-domestic-policy-letter",
      documentType: "Correspondence Packet",
      category: "economic-policy-correspondence",
      disposition: "itemized-economic-policy-correspondence",
      title: "Douglas Dillon letter to Nicholas Brady re domestic policy and congressional affairs",
      documentDate: "1991-12-17",
      pages: 5,
      excerpt:
        "The packet includes a presidential reply to Douglas Dillon, Nicholas Brady forwarding material, and Dillon's letter on the domestic-policy opening after the White House staff change.",
      evidence:
        "Itemized from pages 21-25 of the NARA direct folder scan using OCR and rendered-page review of the presidential reply, Brady note, and Dillon letter.",
    },
    {
      slug: "willard-heminway-bluefish-cup-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Willard S. Heminway Jr. note re proposed Bush Bluefish Cup",
      documentDate: "1991-12-17",
      pages: 2,
      excerpt:
        "Willard S. Heminway Jr. suggests a Bush Bluefish Cup for Kennebunkporters and attaches a bluefish newspaper clipping and travel note for Betsy and Spike.",
      evidence:
        "Itemized from pages 26-27 of the NARA direct folder scan using OCR and rendered-page review of the note, clipping, and travel routing page.",
    },
    {
      slug: "jimmy-walker-christmas-reception-memo",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title: "Memorandum from Patty Presock re Jimmy Walker attending White House Christmas reception",
      documentDate: "1991-12-12",
      pages: 1,
      excerpt:
        "Patty Presock informs the President and Mrs. Bush that Jimmy Walker will be in Washington and will attend the White House Christmas reception.",
      evidence:
        "Itemized from page 28 of the NARA direct folder scan using OCR and rendered-page review of the December 12 memorandum.",
    },
    {
      slug: "kilpatrick-column-pat-buchanan-challenge",
      documentType: "Column Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "James Jackson Kilpatrick letter and column re Pat Buchanan presidential challenge",
      documentDate: "1991-12-17",
      pages: 5,
      excerpt:
        "James Jackson Kilpatrick asks Marlin Fitzwater to thank the President for a note and forwards his column criticizing Pat Buchanan's presidential challenge.",
      evidence:
        "Itemized from pages 29-33 of the NARA direct folder scan using OCR and rendered-page review of the Kilpatrick letter and 'Awww, Pat!' column.",
    },
    {
      slug: "skinner-resignation-exchange-material",
      documentType: "Press Release and Correspondence",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press release and letters re Samuel Skinner's resignation as Secretary of Transportation",
      documentDate: "1991-12-16",
      pages: 5,
      excerpt:
        "The packet includes a Staff Secretary routing note and the White House press release attaching Samuel Skinner's resignation letter and President Bush's response.",
      evidence:
        "Itemized from pages 34-38 of the NARA direct folder scan using OCR and rendered-page review of the routing note, press release, Skinner letter, and presidential response.",
    },
    {
      slug: "saint-johns-hospital-weintraub-gift-copy",
      documentType: "Correspondence Copy",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Additional copy of Saint John's Hospital gift correspondence with Jerome Weintraub",
      documentDate: "1991-12-17",
      pages: 2,
      excerpt:
        "A second copy of the Weintraub/Saint John's Hospital correspondence appears later in the packet with the presidential note and hospital notification letter.",
      evidence:
        "Itemized from pages 39-40 of the NARA direct folder scan using OCR and rendered-page review of the duplicate correspondence copy.",
    },
    {
      slug: "russell-clark-davis-appointment-release",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press release re intention to appoint Major General Russell Clark Davis",
      documentDate: "1991-12-16",
      pages: 1,
      excerpt:
        "The White House announces the President's intention to appoint Major General Russell Clark Davis as Commanding General of the Militia of the District of Columbia.",
      evidence:
        "Itemized from page 41 of the NARA direct folder scan using OCR and rendered-page review of the Office of the Press Secretary release.",
    },
    {
      slug: "white-house-news-summary-december-17-1991",
      documentType: "News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary updates, Tuesday, December 17, 1991",
      documentDate: "1991-12-17",
      pages: 3,
      excerpt:
        "The 10:45 a.m., 1:15 p.m., and 5:00 p.m. White House News Summary updates cover the Soviet endgame, Baker travel, Japan, China, Middle East talks, Buchanan, education, and the economy.",
      evidence:
        "Itemized from pages 42-44 of the NARA direct folder scan using OCR and rendered-page review of the White House News Summary update run.",
    },
    {
      slug: "mrs-bush-press-office-clippings-december-17-18",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings, December 17-18, 1991",
      documentDate: "1991-12-17",
      pages: 10,
      excerpt:
        "The First Lady clipping run includes December 17 and 18 cover sheets, Mrs. Bush's New Hampshire filing trip, Chase Story Time, Christmas in Washington, and a Bowie Blade cover story.",
      evidence:
        "Itemized from pages 45-54 of the NARA direct folder scan using OCR and rendered-page review of the Mrs. Bush press office clipping covers and attached clippings.",
    },
    {
      slug: "wire-service-clippings-december-17-18-1991",
      documentType: "Wire Clipping Packet",
      category: "wire-clipping-packet",
      disposition: "itemized-wire-clipping-packet",
      title: "Wire service clipping packet, December 17-18, 1991",
      documentDate: "1991-12-18",
      pages: 8,
      excerpt:
        "The wire run includes UPI, AP, and Reuters stories on Bush's New Hampshire education call, possible tax rebate, Texas transportation-bill trip, and Mrs. Bush filing New Hampshire primary papers.",
      evidence:
        "Itemized from pages 55-62 of the NARA direct folder scan using OCR and rendered-page review of the wire-service clipping run.",
    },
    {
      slug: "newspaper-clippings-bush-economy-new-hampshire",
      documentType: "Newspaper Clipping Packet",
      category: "newspaper-clipping-packet",
      disposition: "itemized-newspaper-clipping-packet",
      title: "Newspaper clippings re Bush economy coverage and New Hampshire politics",
      documentDate: "1991-12-18",
      pages: 5,
      excerpt:
        "The newspaper clippings cover Mrs. Bush's New Hampshire primary filing, Fitzwater's trip announcement, Bush economic messaging, and First Lady press coverage.",
      evidence:
        "Itemized from pages 63-67 of the NARA direct folder scan using rendered-page review of Wall Street Journal, Washington Post, Washington Times, New York Daily News, and related clipping pages.",
    },
    {
      slug: "collin-street-bakery-fruitcake-letter",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Bill and Josephine re Collin Street Bakery fruitcake",
      documentDate: "1991-12-17",
      pages: 1,
      excerpt:
        "President Bush thanks Bill and Josephine for sending a fruitcake in a holiday tin from Collin Street Bakery.",
      evidence:
        "Itemized from page 68 of the NARA direct folder scan using OCR and rendered-page review of the presidential letter.",
    },
    {
      slug: "additional-craig-thomas-reply-copy",
      documentType: "Letter Copy",
      category: "congressional-correspondence",
      disposition: "itemized-congressional-correspondence",
      title: "Additional copy of the President's reply to Craig Thomas",
      documentDate: "1991-12-17",
      pages: 1,
      excerpt:
        "A later copy of the President's reply to Representative Craig Thomas appears with the same thanks for Thomas's letter and good wishes.",
      evidence:
        "Itemized from page 69 of the NARA direct folder scan using OCR and rendered-page review of the additional Craig Thomas reply copy.",
    },
  ],
  470417565: [
    {
      slug: "casse-memo-state-of-union-budget-background-material",
      documentType: "Memorandum",
      category: "memorandum-item",
      disposition: "itemized-memorandum",
      title:
        "Memorandum from Daniel Casse to Patty Presock re background material on the President's State of the Union message",
      documentDate: "1992-01-30",
      pages: 1,
      excerpt:
        "Daniel Casse forwards Patty Presock background material related to the President's State of the Union message and FY 1993 budget.",
      evidence:
        "Itemized from page 2 of the NARA direct folder scan using OCR and rendered-page review of the cover memorandum.",
    },
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
      pages: 2,
      excerpt:
        "The President has a plan to address both the short-term and the long-term problems facing the economy.",
      evidence:
        "Itemized from pages 19-20 of the NARA direct folder scan using OCR and rendered-page review of the two-page highlights sheet.",
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
      pages: 56,
      excerpt:
        "The attached materials present the highlights of the President's budget for Fiscal Year 1993.",
      evidence:
        "Itemized from pages 22-77 of the NARA direct folder scan using OCR and rendered-page review of the first FY 1993 budget fact-sheet packet.",
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
    {
      slug: "fy1993-budget-fact-sheets-second-copy",
      documentType: "Fact Sheets",
      category: "state-of-union-background-attachment",
      disposition: "itemized-state-of-union-background-attachment",
      title: "Second copy of The President's Budget for FY 1993: Fact Sheets",
      documentDate: "1992-01-28",
      pages: 56,
      excerpt:
        "A second copy of the President's Budget for FY 1993 fact-sheet packet appears later in the scan, again covering the growth agenda, incentives, health, defense, education, children, job training, research and development, infrastructure, housing, crime and drugs, the environment, mandatory programs, pensions, block grants, and management improvement.",
      evidence:
        "Itemized from a second For Immediate Release fact-sheet cover page and repeated FY 1993 Budget headings found in full-PDF OCR of the NARA direct folder scan.",
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
  470417851: [
    {
      slug: "president-to-lynn-martin-birthday",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Lynn Martin re birthday greeting",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President thanks Labor Secretary Lynn Martin for her birthday greeting after his return from Rio and sends best wishes from himself and Barbara Bush.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "president-to-mary-ann-fronce-birthday",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from the President to Mary Ann Fronce re birthday card",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President thanks Mary Ann Fronce for a birthday card, saying it brightened his day, and sends best wishes from himself and Barbara Bush.",
      evidence:
        "Itemized from a White House letter page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "congressional-monitor-june-17-1992",
      documentType: "Congressional Monitor",
      category: "congressional-monitor",
      disposition: "itemized-congressional-monitor",
      title: "Congressional Monitor: Wednesday, June 17, 1992",
      documentDate: "1992-06-17",
      pages: 22,
      excerpt:
        "Congressional Quarterly's Congressional Monitor covers motor-voter legislation, tax extenders, POW/MIA hearings, committee schedules, appropriations status, and House and Senate floor action.",
      evidence:
        "Itemized from Congressional Monitor cover, continuation, and back-cover pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "apn-daily-briefing-june-17-1992",
      documentType: "Daily Political Briefing",
      category: "daily-political-briefing-item",
      disposition: "itemized-daily-political-briefing",
      title: "The Daily Briefing on American Politics: Wednesday, June 17, 1992",
      documentDate: "1992-06-17",
      pages: 20,
      excerpt:
        "The American Political Network daily briefing includes White House, Clinton, Quayle, Perot, Iran-Contra, Senate, House, California, polling, and television-monitor sections.",
      evidence:
        "Itemized from The Daily Briefing on American Politics heading, APN Bulletin Board, and Hotline sections found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "us-russian-summit-agreements-cover-list",
      documentType: "Cover List",
      category: "summit-agreements-list",
      disposition: "itemized-summit-agreements-list",
      title: "Cover list for U.S.-Russian summit agreements and statements",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "The Press Secretary cover note attaches U.S.-Russian agreements, statements, and fact sheets to be issued or signed at the summit, including the Charter, Joint Understanding, Global Protection System, chemical weapons, space, Peace Corps, and Bering Sea materials.",
      evidence:
        "Itemized from the Press Secretary cover page and attachment list found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "charter-american-russian-partnership-friendship",
      documentType: "Charter",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "A Charter for American-Russian Partnership and Friendship",
      documentDate: "1992-06-17",
      pages: 7,
      excerpt:
        "The charter sets out U.S.-Russian partnership principles on democracy, human rights, security cooperation, economic reform, trade, science, technology, education, culture, and people-to-people exchanges.",
      evidence:
        "Itemized from the Charter heading and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "fact-sheet-charter-american-russian-partnership",
      documentType: "Fact Sheet",
      category: "summit-fact-sheet",
      disposition: "itemized-summit-fact-sheet",
      title: "Fact Sheet on the Charter for American-Russian Partnership and Friendship",
      documentDate: "1992-06-17",
      pages: 3,
      excerpt:
        "The fact sheet summarizes the Charter's sections on security cooperation, economic cooperation, humanitarian issues, scientific and cultural exchange, and contacts between citizens.",
      evidence:
        "Itemized from a Fact Sheet on the Charter heading and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-understanding-strategic-nuclear-reductions",
      documentType: "Joint Understanding",
      category: "summit-joint-understanding",
      disposition: "itemized-summit-joint-understanding",
      title: "Joint Understanding re substantial strategic nuclear force reductions",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "President Bush and President Yeltsin agree to substantial further reductions in strategic nuclear forces, including warhead totals, heavy ICBMs, SLBMs, MIRVed ICBMs, and heavy bombers.",
      evidence:
        "Itemized from a Joint Understanding heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-statement-global-protection-system",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint U.S.-Russian Statement on a Global Protection System",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The Presidents continue discussion of a Global Protection System against limited ballistic missile strikes and agree to practical steps for cooperation.",
      evidence:
        "Itemized from a Joint U.S.-Russian Statement heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "us-assistance-to-russia-release",
      documentType: "Press Release",
      category: "summit-press-release",
      disposition: "itemized-summit-press-release",
      title: "Press Release: U.S. Assistance to Russia",
      documentDate: "1992-06-17",
      pages: 3,
      excerpt:
        "The release summarizes U.S. assistance supporting democratic change in Russia, including stabilization, humanitarian, technical, privatization, finance, health, and nuclear-safety efforts.",
      evidence:
        "Itemized from a U.S. Assistance to Russia release heading and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "double-taxation-treaty-russia-release",
      documentType: "Treaty Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "Treaty for the Avoidance of Double Taxation of Income between the United States and Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release notes President Bush and President Yeltsin signing a treaty to avoid double taxation of income between the United States and Russia.",
      evidence:
        "Itemized from a treaty release heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bilateral-investment-treaty-russia-release",
      documentType: "Treaty Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "Bilateral Investment Treaty between the United States and the Russian Federation",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release describes the bilateral investment treaty signed by the United States and the Russian Federation to protect and encourage investment.",
      evidence:
        "Itemized from a Bilateral Investment Treaty heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "trade-relations-agreement-russia-release",
      documentType: "Agreement Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "Agreement on Trade Relations between the United States and Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release states that the U.S.-Russian Trade Agreement provides for reciprocal Most Favored Nation treatment and supports expanded trade relations.",
      evidence:
        "Itemized from an Agreement on Trade Relations heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "eximbank-operations-russia-release",
      documentType: "Press Release",
      category: "summit-press-release",
      disposition: "itemized-summit-press-release",
      title: "Press Release: Eximbank Operations in Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release explains Export-Import Bank operations in Russia after legislative restraints on Eximbank activity were repealed in response to President Bush's initiative.",
      evidence:
        "Itemized from an Eximbank Operations in Russia heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "fuels-energy-agreement-fact-sheet",
      documentType: "Fact Sheet",
      category: "summit-fact-sheet",
      disposition: "itemized-summit-fact-sheet",
      title: "Fact Sheet on the Fuels and Energy Agreement",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The fact sheet describes the new U.S.-Russian agreement on scientific and technical cooperation in fuels and energy.",
      evidence:
        "Itemized from a Fuels and Energy Agreement fact-sheet heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bilateral-issues-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Bilateral Issues",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The statement addresses Cold War barriers to official representation and bilateral arrangements between the United States and Russia.",
      evidence:
        "Itemized from a Joint Statement on Bilateral Issues heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "open-lands-mou-russia-release",
      documentType: "Memorandum of Understanding Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "Open Lands Memorandum of Understanding between the United States and Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release describes the Memorandum of Understanding on Open Lands signed by the United States and Russia.",
      evidence:
        "Itemized from an Open Lands Memorandum of Understanding heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "opic-investment-incentive-agreement-russia",
      documentType: "Agreement Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "OPIC Investment Incentive Agreement between the United States and the Russian Federation",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release describes the OPIC investment incentive agreement between the United States and the Russian Federation.",
      evidence:
        "Itemized from an OPIC Investment Incentive Agreement heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "opening-us-russian-consulates-release",
      documentType: "Press Release",
      category: "summit-press-release",
      disposition: "itemized-summit-press-release",
      title: "Press Release: Opening new U.S. and Russian consulates",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release announces agreement during the Bush-Yeltsin meetings to open new U.S. and Russian consulates.",
      evidence:
        "Itemized from an Opening New U.S. and Russian Consulates heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "personnel-ceilings-fact-sheet",
      documentType: "Fact Sheet",
      category: "summit-fact-sheet",
      disposition: "itemized-summit-fact-sheet",
      title: "Fact Sheet on Removal of Ceilings on U.S. and Russian Personnel",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The fact sheet explains the removal of ceilings on U.S. and Russian personnel agreed to during the Bush-Yeltsin meetings.",
      evidence:
        "Itemized from a Removal of Ceilings on U.S. and Russian Personnel fact-sheet heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-statement-bosnia-hercegovina",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Bosnia-Hercegovina",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The United States and Russia express deep concern over the humanitarian crisis and violence in Bosnia-Hercegovina.",
      evidence:
        "Itemized from a Joint Statement on Bosnia-Hercegovina heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-statement-chemical-weapons",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Chemical Weapons",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "President Bush and President Yeltsin stress their commitment to eliminating chemical weapons and advancing a comprehensive ban.",
      evidence:
        "Itemized from a Joint Statement on Chemical Weapons heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "chemical-weapons-issues-fact-sheet",
      documentType: "Fact Sheet",
      category: "summit-fact-sheet",
      disposition: "itemized-summit-fact-sheet",
      title: "Fact Sheet on Chemical Weapons Issues",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The fact sheet summarizes chemical-weapons transparency, destruction, nonproliferation, and confidence-building issues.",
      evidence:
        "Itemized from a Chemical Weapons Issues fact-sheet heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "cocom-issues-russia-release",
      documentType: "Press Release",
      category: "summit-press-release",
      disposition: "itemized-summit-press-release",
      title: "Press Release: COCOM Issues",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release discusses Russia's democratic reform, economic integration with the West, and export-control adjustments under COCOM.",
      evidence:
        "Itemized from a COCOM Issues heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-statement-cooperation-space",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Cooperation in Space",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "The United States and Russia agree on steps to broaden cooperation in space, including missions, rendezvous and docking, science, and long-term space-station work.",
      evidence:
        "Itemized from a Joint Statement on Cooperation in Space heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "destruction-safeguarding-weapons-agreement",
      documentType: "Agreement Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title:
        "Agreement on destruction and safeguarding of weapons and prevention of weapons proliferation",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "The release describes an agreement between the United States and Russia on destroying and safeguarding weapons and preventing weapons proliferation.",
      evidence:
        "Itemized from an Agreement on the Destruction and Safeguarding of Weapons heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "peace-corps-program-russia-release",
      documentType: "Agreement Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "Agreement on establishing a Peace Corps program between the United States and Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release announces an agreement establishing a Peace Corps program between the United States and Russia.",
      evidence:
        "Itemized from a Peace Corps program agreement heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "korean-nuclear-nonproliferation-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Korean Nuclear Non-Proliferation",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "Russia and the United States support international efforts to address Korean nuclear non-proliferation.",
      evidence:
        "Itemized from a Joint Statement on Korean Nuclear Non-Proliferation heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "nuclear-reactor-safety-assistance-fact-sheet",
      documentType: "Fact Sheet",
      category: "summit-fact-sheet",
      disposition: "itemized-summit-fact-sheet",
      title: "Fact Sheet on Nuclear Reactor Safety Assistance for Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The fact sheet describes U.S. work with the former Soviet Union on civilian reactor safety and assistance for Russia.",
      evidence:
        "Itemized from a Nuclear Reactor Safety Assistance fact-sheet heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "us-russian-civil-aviation-mou",
      documentType: "Memorandum of Understanding Release",
      category: "summit-agreement",
      disposition: "itemized-summit-agreement",
      title: "U.S.-Russian Civil Aviation Memorandum of Understanding",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release describes a civil-aviation memorandum of understanding signed by the governments of the United States and Russia.",
      evidence:
        "Itemized from a U.S.-Russian Civil Aviation M.O.U. heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "technical-migration-assistance-russia",
      documentType: "Press Release",
      category: "summit-press-release",
      disposition: "itemized-summit-press-release",
      title: "Press Release: Technical Migration Assistance for Russia",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The release describes U.S. technical migration assistance for Russia through the International Organization for Migration appeal.",
      evidence:
        "Itemized from a Technical Migration Assistance for Russia heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "defense-conversion-declaration",
      documentType: "Joint Declaration",
      category: "summit-joint-declaration",
      disposition: "itemized-summit-joint-declaration",
      title: "Joint Russian-American Declaration on Defense Conversion",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "The United States and Russia recognize that defense conversion can support economic restructuring and commercial engagement in Russia.",
      evidence:
        "Itemized from a Joint Russian-American Declaration on Defense Conversion heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "beringia-international-park-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Beringia International Park",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The Presidents support creating Beringia International Park and preserving natural and cultural resources across the Bering Strait region.",
      evidence:
        "Itemized from a Joint Statement on Beringia International Park heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "lake-baikal-conservation-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Conservation of Lake Baikal",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The United States and Russia reaffirm readiness to promote conservation of Lake Baikal.",
      evidence:
        "Itemized from a Joint Statement on Conservation of Lake Baikal heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "central-bering-sea-fishing-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on voluntary suspension of fishing in the Central Bering Sea",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The United States and Russia recall the need for voluntary suspension of fishing in the Central Bering Sea.",
      evidence:
        "Itemized from a Joint Statement on the Need for Voluntary Suspension on Fishing heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bering-sea-ecosystem-research-conservation",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on research and conservation of the Bering Sea ecosystem",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The United States and Russia state their common interest in wise use of natural resources and conservation of the Bering Sea ecosystem.",
      evidence:
        "Itemized from a Joint Statement on Research and Conservation of the Bering Sea Ecosystem heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "science-technology-cooperation-joint-statement",
      documentType: "Joint Statement",
      category: "summit-joint-statement",
      disposition: "itemized-summit-joint-statement",
      title: "Joint Statement on Science and Technology Cooperation",
      documentDate: "1992-06-17",
      pages: 2,
      excerpt:
        "The Presidents note long-standing cooperation in science and technology and set principles for shared responsibilities, contributions, and benefits.",
      evidence:
        "Itemized from a Joint Statement on Science and Technology Cooperation heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "richard-monroe-miles-azerbaijan-nomination",
      documentType: "Nomination Release",
      category: "nomination-release",
      disposition: "itemized-nomination-release",
      title: "Nomination release: Richard Monroe Miles to be Ambassador to Azerbaijan",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President announces his intention to nominate Richard Monroe Miles to be Ambassador to the Republic of Azerbaijan.",
      evidence:
        "Itemized from a presidential nomination release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "ruth-davis-benin-nomination",
      documentType: "Nomination Release",
      category: "nomination-release",
      disposition: "itemized-nomination-release",
      title: "Nomination release: Ruth A. Davis to be Ambassador to Benin",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President announces his intention to nominate Ruth A. Davis to be Ambassador to the Republic of Benin.",
      evidence:
        "Itemized from a presidential nomination release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "vernon-parker-presidential-personnel-appointment",
      documentType: "Appointment Release",
      category: "appointment-release",
      disposition: "itemized-appointment-release",
      title: "Appointment release: Vernon B. Parker as Special Assistant to the President",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President announces the appointment of Vernon B. Parker as Special Assistant to the President and Associate Director of Presidential Personnel.",
      evidence:
        "Itemized from a presidential appointment release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joseph-hulings-turkmenistan-nomination",
      documentType: "Nomination Release",
      category: "nomination-release",
      disposition: "itemized-nomination-release",
      title: "Nomination release: Joseph S. Hulings III to be Ambassador to Turkmenistan",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President announces his intention to nominate Joseph S. Hulings III to be Ambassador to the Republic of Turkmenistan.",
      evidence:
        "Itemized from a presidential nomination release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "jon-huntsman-singapore-nomination",
      documentType: "Nomination Release",
      category: "nomination-release",
      disposition: "itemized-nomination-release",
      title: "Nomination release: Jon M. Huntsman, Jr. to be Ambassador to Singapore",
      documentDate: "1992-06-17",
      pages: 1,
      excerpt:
        "The President announces his intention to nominate Jon M. Huntsman, Jr. to be Ambassador to Singapore.",
      evidence:
        "Itemized from a presidential nomination release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "remarks-us-russian-business-summit",
      documentType: "Remarks",
      category: "presidential-remarks",
      disposition: "itemized-presidential-remarks",
      title: "Remarks by the President in address to U.S./Russian Business Summit",
      documentDate: "1992-06-17",
      pages: 7,
      excerpt:
        "The President and President Yeltsin address the U.S./Russian Business Summit at the J.W. Marriott Hotel, discussing trade, investment, OPIC, Eximbank, and Russia's economic opening.",
      evidence:
        "Itemized from Office of the Press Secretary remarks heading and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "fathers-day-proclamation-duplicate-copies",
      documentType: "Proclamation",
      category: "presidential-proclamation",
      disposition: "itemized-presidential-proclamation",
      title: "Father's Day, 1992 proclamation, duplicate copies",
      documentDate: "1992-06-17",
      pages: 4,
      excerpt:
        "Duplicate copies of the Father's Day, 1992 proclamation honor fathers and describe fatherhood as a cornerstone of home and family life.",
      evidence:
        "Itemized from two Office of the Press Secretary copies of the Father's Day proclamation found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joint-signing-ceremony-remarks-bush-yeltsin",
      documentType: "Remarks",
      category: "presidential-remarks",
      disposition: "itemized-presidential-remarks",
      title: "Remarks by President Bush and President Yeltsin in joint signing ceremony",
      documentDate: "1992-06-17",
      pages: 10,
      excerpt:
        "President Bush and President Yeltsin speak at the East Room joint signing ceremony on a new U.S.-Russia partnership, strategic arms, POW/MIAs, aid, and cooperation.",
      evidence:
        "Itemized from an Office of the Press Secretary joint signing ceremony remarks heading and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "exchange-toasts-bush-yeltsin-duplicate-copies",
      documentType: "Remarks",
      category: "presidential-remarks",
      disposition: "itemized-presidential-remarks",
      title: "Remarks by President Bush and President Yeltsin in exchange of toasts, duplicate copies",
      documentDate: "1992-06-16",
      pages: 6,
      excerpt:
        "Duplicate copies of the State Dining Room exchange of toasts include remarks by President Bush and President Yeltsin at the Russian-American state dinner.",
      evidence:
        "Itemized from two Office of the Press Secretary copies of the exchange-of-toasts remarks found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-june-17-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Wednesday, June 17, 1992",
      documentDate: "1992-06-17",
      pages: 26,
      excerpt:
        "Mrs. Bush's Press Office clipping packet covers the Bush-Yeltsin state dinner, Barbara Bush and Naina Yeltsin at Martha's Table, White House dinner guest lists, Ford's Theatre, White House Christmas needlepoint, and Prescott Bush coverage.",
      evidence:
        "Itemized from a Mrs. Bush's Press Office Daily Press Clippings cover page and clipping sequence found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-july-17-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Friday, July 17, 1992",
      documentDate: "1992-07-17",
      pages: 16,
      excerpt:
        "Mrs. Bush's Press Office clipping packet includes Ross Perot timeline material, Barbara Bush and Hillary Clinton cookie coverage, Hillary Clinton and Chelsea Clinton stories, Tipper Gore coverage, Jimmy Carter, and women's caucus reporting.",
      evidence:
        "Itemized from a second Mrs. Bush's Press Office Daily Press Clippings cover page and clipping sequence found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
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
  470417970: [
    {
      slug: "treasury-forwarding-note-brady-houston-club-materials",
      documentType: "Forwarding Note",
      category: "treasury-forwarding-note",
      disposition: "itemized-treasury-forwarding-note",
      title:
        "Treasury forwarding note from Nicholas F. Brady re Houston Club remarks and Wall Street Journal articles",
      documentDate: "1992-08-11",
      pages: 1,
      excerpt:
        "Nicholas F. Brady forwards two Wall Street Journal articles and the Houston Club speech material, noting that the articles collect points the administration had been making.",
      evidence:
        "Itemized from the Treasury forwarding page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "wall-street-journal-small-business-debt-articles",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title: "Wall Street Journal articles on small business jobs and debt reduction",
      documentDate: "1992-08-10",
      pages: 2,
      excerpt:
        "The Wall Street Journal packet includes 'For New Jobs, Help Small Business' and a companion article on the end of the American borrowing binge and debt reduction.",
      evidence:
        "Itemized from Wall Street Journal article starts found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bill-signing-release-zuni-catawba",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press Release: President signs H.R. 4026 and H.R. 5566",
      documentDate: "1992-08-11",
      pages: 1,
      excerpt:
        "The White House press release announces the President's signing of H.R. 4026, the Zuni River Watershed Act, and H.R. 5566, concerning Catawba Indian Tribe land claims.",
      evidence:
        "Itemized from an Office of the Press Secretary release heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "presidential-determination-zambia-defense-articles",
      documentType: "Presidential Determination",
      category: "presidential-determination",
      disposition: "itemized-presidential-determination",
      title: "Presidential Determination No. 92-38 re Zambia defense articles and services",
      documentDate: "1992-08-11",
      pages: 1,
      excerpt:
        "Presidential Determination No. 92-38 finds Zambia eligible to be furnished defense articles and services under the Foreign Assistance Act and Arms Export Control Act.",
      evidence:
        "Itemized from a Presidential Determination release heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "radiation-control-health-safety-message",
      documentType: "Message to Congress",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Message to Congress transmitting HHS report on the Radiation Control for Health and Safety Act",
      documentDate: "1992-08-11",
      pages: 1,
      excerpt:
        "The message transmits the Department of Health and Human Services report pursuant to section 540 of the Federal Food, Drug, and Cosmetic Act regarding radiation control.",
      evidence:
        "Itemized from a White House message-to-Congress release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "materials-forwarded-to-president-august-11-1992",
      documentType: "Forwarded Materials List",
      category: "forwarded-materials-list",
      disposition: "itemized-forwarded-materials-list",
      title: "Materials Forwarded to the President: August 11, 1992",
      documentDate: "1992-08-11",
      pages: 2,
      excerpt:
        "The forwarded-materials list identifies action items, classified information, and information items, including the Zuni and Catawba bills, a Derwinski certificate, a Jonathan Moore resignation acceptance, a Bolten Federal Implementation Plan memo, a Chernomyrdin item, campaign press material, procurement rules, the President's block schedule, and July producer-price numbers.",
      evidence:
        "Itemized from a Materials Forwarded to the President cover list found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "nafta-call-points-salinas-mulroney",
      documentType: "Telephone Call Points",
      category: "telephone-call-points",
      disposition: "itemized-telephone-call-points",
      title: "Points for calls to President Salinas and Prime Minister Mulroney re NAFTA agreement",
      documentDate: "1992-08-11",
      pages: 6,
      excerpt:
        "The call-points packet reports that negotiators had reached agreement on NAFTA and frames the agreement as a historic step toward a hemisphere-wide free trade area.",
      evidence:
        "Itemized from a telephone-call points packet and routing pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-august-11-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Tuesday, August 11, 1992",
      documentDate: "1992-08-11",
      pages: 21,
      excerpt:
        "The Mrs. Bush press-clippings packet includes GOP platform coverage, Clinton polling, New York Post Bush-affair stories, cartoons, and family-values and campaign coverage.",
      evidence:
        "Itemized from a Mrs. Bush's Press Office Daily Press Clippings cover and clipping run found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-september-12-14-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: September 12-14, 1992",
      documentDate: "1992-09-12",
      pages: 34,
      excerpt:
        "The September 12-14 Mrs. Bush press-clippings packet includes John Major campaign strategy, Al Gore and family leave, Barbara Bush on Social Security and literacy, Clinton coverage, and a Bob Teeter memorandum.",
      evidence:
        "Itemized from a second Mrs. Bush's Press Office Daily Press Clippings cover and clipping run found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "daily-news-clips-august-11-1992",
      documentType: "Daily News Clips",
      category: "daily-news-clips-item",
      disposition: "itemized-daily-news-clips",
      title: "Daily News Clips: Tuesday, August 11, 1992",
      documentDate: "1992-08-11",
      pages: 100,
      excerpt:
        "Office of Media Affairs Daily News Clips for August 11, 1992, draw from the Los Angeles Times, USA Today, The Wall Street Journal, The Washington Post, The New York Times, and The Washington Times, with coverage of Bosnia, Iraq, health care, the GOP platform, James Baker, Israel, and the Clinton economic plan.",
      evidence:
        "Itemized from an Office of Media Affairs Daily News Clips cover and clipping sequence found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-august-1992",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages, August 1992",
      documentDate: "1992-08-11",
      pages: 8,
      excerpt:
        "Official White House photograph pages and transfer placeholders appear at the end of the direct folder scan.",
      evidence:
        "Itemized from official White House photograph pages and transfer placeholders found in rendered page review of the NARA direct folder scan.",
    },
  ],
  470417978: [
    {
      slug: "materials-forwarded-to-president-august-14-1992",
      documentType: "Forwarded Materials List",
      category: "forwarded-materials-list",
      disposition: "itemized-forwarded-materials-list",
      title: "Materials Forwarded to the President: August 14, 1992, to Camp David",
      documentDate: "1992-08-14",
      pages: 1,
      excerpt:
        "The forwarded-materials list identifies action, classified-information, and remarks items, including an Indiana disaster declaration, a Yeutter minivans tariff memorandum, and VFW convention remarks.",
      evidence:
        "Itemized from a Materials Forwarded to the President cover list found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "vfw-speech-plan-government-restructuring",
      documentType: "Speech Planning Material",
      category: "speech-planning-material",
      disposition: "itemized-speech-planning-material",
      title:
        "Selected issues, government restructuring language, and plan language for Veterans of Foreign Wars remarks",
      documentDate: "1992-08-14",
      pages: 7,
      excerpt:
        "The speech-planning pages ask whether to include 'The Plan,' government restructuring, a domestic and economic agenda, tax policy, and debt-and-spending reduction ideas.",
      evidence:
        "Itemized from selected-issues, Government Restructuring Language, and plan.scr pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "leonard-garment-character-campaign-correspondence",
      documentType: "Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Leonard Garment correspondence packet re character, Clinton, and campaign themes",
      documentDate: "1992-08-07",
      pages: 4,
      excerpt:
        "The packet includes White House routing material and Leonard Garment's faxed thoughts on Clinton, moral values, trustworthiness, character, and the 1992 presidential campaign.",
      evidence:
        "Itemized from the Leonard Garment routing page and faxed pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "anthony-dolan-campaign-thoughts",
      documentType: "Correspondence and Talking Points",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Anthony R. Dolan correspondence and campaign thoughts for President Bush",
      documentDate: "1992-08-07",
      pages: 7,
      excerpt:
        "Anthony Dolan praises the President's recent attacks, discusses the campaign, and attaches further thoughts on drawing contrasts with Clinton and the Democratic Party.",
      evidence:
        "Itemized from American Enterprise Institute letterhead, Dolan's August 7 letter, and attached campaign-thought pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "oscar-jeb-bush-campaign-correspondence",
      documentType: "Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Oscar and Jeb Bush correspondence packet re campaign support and fundraising",
      documentDate: "1992-08-14",
      pages: 4,
      excerpt:
        "The packet includes a presidential reply to Oscar, a July 29 personal and confidential letter copied to Jeb Bush, and a Spanish-language note to Jeb about a campaign contribution.",
      evidence:
        "Itemized from presidential correspondence, Jeb Bush routing material, and incoming Spanish-language pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "august-14-telephone-memoranda",
      documentType: "Telephone Memoranda",
      category: "telephone-log-item",
      disposition: "itemized-telephone-log",
      title: "Telephone memoranda and Signal Switchboard log: August 14, 1992",
      documentDate: "1992-08-14",
      pages: 4,
      excerpt:
        "White House telephone memoranda list calls with Robert Mosbacher, Samuel Skinner, Nicholas Brady, John Paul Hammerschmidt, George W. Bush, Brent Scowcroft, and others, plus a no-calls memorandum.",
      evidence:
        "Itemized from White House telephone memorandum and Signal Switchboard headings found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "august-14-presidential-movements",
      documentType: "Presidential Movements",
      category: "presidential-movements-item",
      disposition: "itemized-presidential-movements",
      title: "Presidential Movements: Camp David and Frederick, Maryland, August 14, 1992",
      documentDate: "1992-08-14",
      pages: 2,
      excerpt:
        "The movement logs record the President at Camp David, jogging, Aspen and Laurel movements, and the Marine One trip to Harry Grove Stadium in Frederick.",
      evidence:
        "Itemized from two Presidential Movements headings found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "recommended-call-republican-convention-walkthrough",
      documentType: "Recommended Telephone Call",
      category: "recommended-call-item",
      disposition: "itemized-recommended-telephone-call",
      title:
        "Recommended telephone call to participants attending the Republican National Convention final walk-through",
      documentDate: "1992-08-14",
      pages: 1,
      excerpt:
        "Ronald C. Kaufman recommends a presidential call to thank staff and volunteers attending the final walk-through for the Republican National Convention at the Houston Astrodome.",
      evidence:
        "Itemized from a Recommended Telephone Call heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "susan-watkins-camp-david-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Susan Elizabeth Watkins correspondence packet re Camp David reunion and videotapes",
      documentDate: "1992-08-14",
      pages: 4,
      excerpt:
        "The President thanks Susan Elizabeth Watkins for her note, says he was glad her family had a reunion at Camp David, and thanks her for the video tapes.",
      evidence:
        "Itemized from presidential correspondence and related low-confidence handwritten pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "joe-ramirez-lynwood-sheriffs-youth-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Joe Ramirez and Lynwood Sheriff's Youth Athletic League correspondence packet",
      documentDate: "1992-08-14",
      pages: 2,
      excerpt:
        "The packet includes a presidential response and Joe Ramirez's July 29 letter thanking the President for visiting the Lynwood Sheriff's Youth Athletic League.",
      evidence:
        "Itemized from White House routing material and Joe Ramirez's incoming letter found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "justin-dart-disabilities-committee-correspondence",
      documentType: "Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Justin Dart correspondence packet re President's Committee on Employment of People with Disabilities",
      documentDate: "1992-08-14",
      pages: 2,
      excerpt:
        "The packet includes a White House routing page and Justin Dart letterhead from the President's Committee on Employment of People with Disabilities.",
      evidence:
        "Itemized from the Justin Dart routing page and letterhead page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "daily-news-clips-august-14-1992",
      documentType: "Daily News Clips",
      category: "daily-news-clips-item",
      disposition: "itemized-daily-news-clips",
      title: "Daily News Clips: Friday, August 14, 1992",
      documentDate: "1992-08-14",
      pages: 118,
      excerpt:
        "The press-clips run includes USA Today, Los Angeles Times, The Washington Post, The Wall Street Journal, The New York Times, and The Washington Times coverage of Clinton, NAFTA, Bosnia, Baker, the Republican platform, abortion, and the campaign.",
      evidence:
        "Itemized as a Daily News Clips packet from the continuous newspaper-clipping run found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
  ],
  470417997: [
    {
      slug: "marked-branson-rally-remarks",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "campaign-rally-remarks",
      disposition: "itemized-campaign-rally-remarks",
      title:
        "Marked presidential remarks for Branson rally, August 22, 1992",
      documentDate: "1992-08-22",
      pages: 18,
      excerpt:
        "Marked Branson, Missouri rally remarks use country-music references and argue that Bush had changed the world and would change America, with George Bush handwriting visible throughout the copy.",
      evidence:
        "Itemized from Bush Library handwriting markers and the Branson rally heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-handwritten-routing-nyt-clips",
      documentType: "Handwritten Routing Note",
      category: "press-clipping-routing",
      disposition: "itemized-press-clipping-routing",
      title:
        "From the desk of George Bush handwritten routing page re New York Times clips on Clinton",
      documentDate: "1992-08-22",
      pages: 1,
      excerpt:
        "A From the desk of George Bush page with presidential handwriting routes New York Times clips on Clinton, including a note about whether the items were helpful for debate.",
      evidence:
        "Itemized from rendered-page review of a From the desk of George Bush routing page marked Document Originally Attached to Following Page.",
    },
    {
      slug: "new-york-times-clips-index-front-pages-july-1992",
      documentType: "Press Clipping Packet",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clips index and selected front-page clippings, July 17-18, 1992",
      documentDate: "1992-07-18",
      pages: 3,
      excerpt:
        "Faxed New York Times clip materials include an index to items on Perot backers, Clinton's post-convention boost, Reagan Democrats, abortion, Iraq, Havel, and a front-page clipping spread.",
      evidence:
        "Itemized from faxed New York Times clip index and front-page clipping images confirmed by rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "birmingham-rally-staffing-proposed-remarks",
      documentType: "Staffing Memorandum and Speech Draft",
      category: "campaign-rally-remarks",
      disposition: "itemized-campaign-rally-remarks",
      title:
        "White House staffing memorandum and proposed remarks for Bush-Quayle rally in Birmingham, Alabama",
      documentDate: "1992-08-20",
      pages: 8,
      excerpt:
        "A White House staffing memorandum and Andy Ferguson memorandum forward proposed remarks for the August 22 Bush-Quayle rally in Birmingham, Alabama.",
      evidence:
        "Itemized from the White House staffing memorandum, Andy Ferguson memorandum, and Birmingham rally remarks heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "moe-bandy-americana-show-remarks-handwriting",
      documentType: "Remarks Notes with President Bush Handwriting",
      category: "event-remarks-notes",
      disposition: "itemized-event-remarks-notes",
      title:
        "Moe Bandy's Americana Show remarks notes with President Bush handwriting",
      documentDate: "1992-08-22",
      pages: 2,
      excerpt:
        "Remarks notes for Moe Bandy's Americana Show thank Bandy and other performers and note the Barbara Bush Foundation for Family Literacy, with a second page of presidential handwritten notes.",
      evidence:
        "Itemized from the Moe Bandy's Americana Show heading, Bush Library handwriting marker, and rendered-page review of handwritten notes in the NARA direct folder scan.",
    },
    {
      slug: "air-force-one-notes-criswell-gregory",
      documentType: "Handwritten Note Drafts",
      category: "presidential-handwritten-notes",
      disposition: "itemized-presidential-handwritten-notes",
      title:
        "Aboard Air Force One handwritten thank-you note drafts to Dr. Criswell and Dr. Gregory",
      documentDate: "1992-08-22",
      pages: 1,
      excerpt:
        "An Aboard Air Force One page contains handwritten thank-you note drafts after the First Baptist Dallas visit, including notes to Dr. Criswell and Dr. Gregory.",
      evidence:
        "Itemized from rendered-page review of Aboard Air Force One handwritten note drafts in the NARA direct folder scan.",
    },
    {
      slug: "first-baptist-church-dallas-brochure",
      documentType: "Church Brochure",
      category: "event-background-material",
      disposition: "itemized-event-background-material",
      title: "First Baptist Church Dallas visitor and membership brochure",
      documentDate: "1992-08-22",
      pages: 6,
      excerpt:
        "First Baptist Church Dallas materials include visitor information, membership guidance, a prayer text, and a welcome/contact form.",
      evidence:
        "Itemized from First Baptist Church Dallas brochure pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-15-national-affairs-briefing-dallas",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title:
        "Pool Report #15: National Affairs Briefing, Dallas, Texas, with duplicate copy",
      documentDate: "1992-08-22",
      pages: 2,
      excerpt:
        "Pool Report #15 covers the short motorcade to the Dallas Convention Center, National Affairs Briefing audience, and Peter Teeley's comments on Pat Robertson and Evangelicals.",
      evidence:
        "Itemized from two Pool Report #15 pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-en-route-to-dallas",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #1: En route to Dallas, Texas, with duplicate copy",
      documentDate: "1992-08-22",
      pages: 2,
      excerpt:
        "Pool Report #1 covers the Hoover rope line, motorcade to the airport, and flight en route to Dallas, with a duplicate copy later in the packet.",
      evidence:
        "Itemized from two en route to Dallas pool-report pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-11-air-force-one-branson-dobbins",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title:
        "Pool Report #11: Air Force One Branson-Dobbins, with duplicate copy",
      documentDate: "1992-08-22",
      pages: 4,
      excerpt:
        "Pool Report #11 covers Marlin Fitzwater comments aboard Air Force One, speculation about Iraq no-fly-zone announcements, polling, the School of the Ozarks stop, and student-made gifts.",
      evidence:
        "Itemized from two two-page copies of Pool Report #11 found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-woodstock-georgia-to-birmingham",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title:
        "Pool Report: Woodstock, Georgia to Birmingham, Alabama, with Teeter addendum and duplicate copy",
      documentDate: "1992-08-22",
      pages: 4,
      excerpt:
        "The Woodstock-to-Birmingham pool report covers Newt Gingrich's family-values remarks, a flight delay, and a Bob Teeter Air Force One addendum on polling and the post-convention bounce.",
      evidence:
        "Itemized from two two-page copies of the Woodstock, Georgia to Birmingham, Alabama pool report found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "august-22-telephone-memoranda",
      documentType: "Telephone Memoranda",
      category: "telephone-log",
      disposition: "itemized-telephone-log",
      title: "Telephone memoranda for President Bush, August 22, 1992",
      documentDate: "1992-08-22",
      pages: 2,
      excerpt:
        "Two White House telephone memorandum pages record signal-switchboard call fields for President Bush on August 22, 1992.",
      evidence:
        "Itemized from White House telephone memorandum forms found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "august-22-presidential-movements",
      documentType: "Presidential Movements",
      category: "presidential-movements-log",
      disposition: "itemized-presidential-movements",
      title:
        "Presidential movements log: Branson, Woodstock, Birmingham, and Dallas, August 22, 1992",
      documentDate: "1992-08-22",
      pages: 2,
      excerpt:
        "Presidential movements pages list the August 22 travel sequence from Branson through Woodstock, Birmingham, and Dallas, ending at the Hyatt Regency Reunion.",
      evidence:
        "Itemized from Presidential Movements forms found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "official-white-house-photo-packet-august-22-trip",
      documentType: "Official White House Photo Packet",
      category: "white-house-photo",
      disposition: "itemized-white-house-photo",
      title:
        "Official White House photo packet from August 22, 1992 campaign trip",
      documentDate: "1992-08-22",
      pages: 14,
      excerpt:
        "Official White House photo pages and stamp backs show the August 22 trip, including Branson, Missouri; Hoover or Birmingham, Alabama; and the National Affairs Briefing in Dallas, Texas.",
      evidence:
        "Itemized from rendered-page review of color photo pages, handwritten sticky labels, and Official White House Photo stamp backs in the NARA direct folder scan.",
    },
  ],
  470418007: [
    {
      slug: "response-to-claims-clinton-is-raising-again",
      documentType: "Campaign Rebuttal Talking Points",
      category: "campaign-rebuttal-talking-points",
      disposition: "itemized-campaign-rebuttal-talking-points",
      title: "Response to Claims Clinton is Raising Again",
      documentDate: "1992-08-25",
      pages: 13,
      excerpt:
        "A campaign rebuttal packet answers claims raised by Bill Clinton, with point-by-point responses on the economy, taxes, jobs, trade, wages, welfare, children, the environment, agriculture, regulation, and education.",
      evidence:
        "Itemized from the Response to Claims heading and claim/response pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-august-25-1992",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages, August 25, 1992",
      documentDate: "1992-08-25",
      pages: 5,
      excerpt:
        "Official White House photo pages and transfer placeholders appear in the direct scan, including color photographs and Official White House Photo backing pages.",
      evidence:
        "Itemized from rendered-page review of color photo pages and Official White House Photo transfer placeholders in the NARA direct folder scan.",
    },
    {
      slug: "washington-post-campaign-economy-clippings-august-25-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Post clippings on campaign economics, Iraq, Quayle, peace talks, job training, arms control, and television",
      documentDate: "1992-08-25",
      pages: 15,
      excerpt:
        "The Washington Post clipping packet includes articles and columns on Bush's economic-revival argument, Clinton's economic attacks, low-wage earners, Iraq, Quayle, peace talks, Pat Buchanan, job training, arms control, and television coverage.",
      evidence:
        "Itemized from Washington Post mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "wall-street-journal-libya-iraq-economy-articles",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on Libya, Iraq, markets, Thomas, Japan, and Iraqi weapons",
      documentDate: "1992-08-25",
      pages: 8,
      excerpt:
        "The Wall Street Journal article packet covers Libya sanctions and oil companies, Bush campaign strategy, Iraqi dissidents and weapons, the dollar and the Bundesbank, Clarence Thomas, and Japan.",
      evidence:
        "Itemized from Wall Street Journal article starts and continuation pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "new-york-times-clippings-august-25-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on remedial math, campaigns, Cambodia, courts, voting, and jobs",
      documentDate: "1992-08-25",
      pages: 7,
      excerpt:
        "The New York Times clipping packet includes opinion and news items on Bush and Clinton economics, campaign claims, Cambodia, New York courts, voting restrictions, and Bush's job-training proposal.",
      evidence:
        "Itemized from New York Times clipping pages, article starts, and continuation pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "washington-times-campaign-foreign-policy-clippings",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on Bush travel, Baker, foreign policy, U.N., chemical weapons, and campaign themes",
      documentDate: "1992-08-25",
      pages: 17,
      excerpt:
        "The Washington Times clipping packet covers Bush campaign travel, Baker's campaign role, foreign policy, chemical weapons, football and price-fixing commentary, Horn of Africa drought, the U.N., Mexico, and job training.",
      evidence:
        "Itemized from Washington Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "usa-today-and-loose-campaign-clippings",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "USA Today and loose campaign clippings",
      documentDate: "1992-08-25",
      pages: 3,
      excerpt:
        "Loose clipping pages include USA Today campaign and economics items and an additional color or graphic clipping page in the August 25 packet.",
      evidence:
        "Itemized from USA Today clipping pages and a loose color/graphic page confirmed by rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "los-angeles-times-middle-east-campaign-clippings",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on Middle East policy, Orange County, job training, Clinton, education, and Saddam",
      documentDate: "1992-08-25",
      pages: 11,
      excerpt:
        "The Los Angeles Times clipping packet includes articles and commentary on Israeli border negotiations, Saddam Hussein, Orange County politics, Bush's job-training plan, Clinton and Tsongas, education, and Middle East policy.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "august-25-presidential-correspondence-packet",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Presidential correspondence packet: August 25, 1992",
      documentDate: "1992-08-25",
      pages: 3,
      excerpt:
        "A low-OCR presidential correspondence packet includes White House letter copies to supporters or constituents, including a letter to Major Donald P. Warren and a condolence note.",
      evidence:
        "Itemized from rendered-page review of photocopied White House correspondence pages at the end of the NARA direct folder scan; OCR is low-confidence on some recipients.",
    },
  ],
  470418010: [
    {
      slug: "letter-to-congress-budget-deferral",
      documentType: "Presidential Letter to Congress",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Text of a letter to Congress reporting one budget-authority deferral",
      documentDate: "1992-08-26",
      pages: 1,
      excerpt:
        "The President reports one deferral of budget authority, totaling $17.6 million, under the Congressional Budget and Impoundment Control Act of 1974.",
      evidence:
        "Itemized from the White House press-release page headed Text of a Letter from the President to the Speaker and President of the Senate in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "letter-to-congress-gsp-former-yugoslav-republics",
      documentType: "Presidential Letter to Congress",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Text of a letter to Congress on GSP benefits for former Yugoslav republics",
      documentDate: "1992-08-25",
      pages: 1,
      excerpt:
        "The President informs Congress of his intent to add former Yugoslav republics, other than Serbia and Montenegro, to the list of Generalized System of Preferences beneficiaries.",
      evidence:
        "Itemized from the August 26 White House press-release page containing the President's August 25 letter to congressional leaders.",
    },
    {
      slug: "hurricane-andrew-administrative-dismissal-memorandum",
      documentType: "Presidential Memorandum",
      category: "presidential-memorandum",
      disposition: "itemized-presidential-memorandum",
      title:
        "Memorandum to department and agency heads on administrative dismissal for employees affected by Hurricane Andrew",
      documentDate: "1992-08-26",
      pages: 1,
      excerpt:
        "The President asks department and agency heads to excuse affected federal civilian employees in Hurricane Andrew disaster areas when appropriate.",
      evidence:
        "Itemized from the White House memorandum headed Administrative Dismissal of Employees Affected by Hurricane Andrew in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "august-26-bill-signing-release",
      documentType: "Bill Signing Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title:
        "Press release listing legislation signed by the President, August 26, 1992",
      documentDate: "1992-08-26",
      pages: 3,
      excerpt:
        "The White House lists legislation signed by the President, including National Rehabilitation Week, technical corrections, the Jefferson National Expansion Memorial, CPB authorization, voting-rights language assistance, animal-enterprise penalties, land transfers, food-stamp benefits, and health-service amendments.",
      evidence:
        "Itemized from the three-page White House signed-legislation release found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "statement-sentencing-commission-members",
      documentType: "Presidential Statement",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Statement on S. 1963 and United States Sentencing Commission members",
      documentDate: "1992-08-26",
      pages: 1,
      excerpt:
        "The President signs S. 1963 while stating his understanding that it does not allow current Sentencing Commission members to extend their own terms.",
      evidence:
        "Itemized from the White House Statement by the President page on S. 1963 in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "statement-albania-most-favored-nation-status",
      documentType: "Presidential Statement",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Statement on H.J.Res. 507 approving most-favored-nation status for Albania",
      documentDate: "1992-08-26",
      pages: 1,
      excerpt:
        "The President signs H.J.Res. 507 approving extension of nondiscriminatory, most-favored-nation treatment to the Republic of Albania.",
      evidence:
        "Itemized from the White House Statement by the President page on Albania MFN status in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "national-dare-day-proclamation-1992",
      documentType: "Presidential Proclamation",
      category: "presidential-proclamation",
      disposition: "itemized-presidential-proclamation",
      title: "National D.A.R.E. Day, 1992 proclamation",
      documentDate: "1992-08-26",
      pages: 2,
      excerpt:
        "The proclamation recognizes Drug Abuse Resistance Education and its role in drug prevention, safe schools, and the National Drug Control Strategy.",
      evidence:
        "Itemized from the two-page White House National D.A.R.E. Day proclamation found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "ardeshir-zahedi-flowers-gift-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Ardeshir Zahedi flowers and gift-unit correspondence",
      documentDate: "1992-08-26",
      pages: 2,
      excerpt:
        "The packet includes a presidential thank-you letter to Ardeshir Zahedi for flowers and support, with a related White House gift-unit arrival form.",
      evidence:
        "Itemized from the White House outgoing letter page and attached gift-unit arrival form found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "emile-j-roy-campaign-buttons-correspondence",
      documentType: "Presidential Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Emile J. Roy campaign-buttons correspondence",
      documentDate: "1992-08-26",
      pages: 1,
      excerpt:
        "The President thanks Emile J. Roy for limited-edition campaign buttons and notes that they will be added to the collection and eventually sent to the Presidential Library.",
      evidence:
        "Itemized from the White House outgoing letter page to Emile J. Roy found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "shirley-green-noonan-routing-correspondence",
      documentType: "Routing Note and Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Shirley M. Green routing page and Margaret Noonan correspondence packet",
      documentDate: "1992-08-26",
      pages: 3,
      excerpt:
        "A low-confidence correspondence packet includes a Shirley M. Green routing page and materials addressed to Margaret Noonan, with handwritten or photocopied pages that OCR only partially reads.",
      evidence:
        "Itemized from rendered-page review of the Shirley M. Green routing page, Margaret Noonan address page, and attached low-confidence page in the NARA direct folder scan.",
    },
    {
      slug: "strom-thurmond-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Strom Thurmond correspondence packet",
      documentDate: "1992-08-25",
      pages: 2,
      excerpt:
        "The packet includes a White House transmittal page and Senator Strom Thurmond's August 25 letter to the President after seeing the President and Mrs. Bush.",
      evidence:
        "Itemized from the White House address/transmittal page and Strom Thurmond letterhead found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "john-mckernan-campaign-strategy-fax-memo",
      documentType: "Campaign Strategy Memorandum",
      category: "campaign-strategy-memorandum",
      disposition: "itemized-campaign-strategy-memorandum",
      title: "Governor John R. McKernan Jr. faxed memorandum on campaign strategy",
      documentDate: "1992-08-24",
      pages: 3,
      excerpt:
        "Governor John R. McKernan Jr. faxes the President a memorandum on campaign strategy after the Republican convention, with a White House transmittal page.",
      evidence:
        "Itemized from the Maine Governor fax cover sheet, White House transmittal page, and McKernan memorandum pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "mrs-bush-daily-press-clippings-august-26-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings, August 26, 1992",
      documentDate: "1992-08-26",
      pages: 15,
      excerpt:
        "Mrs. Bush's Daily Press clipping packet includes coverage of Barbara Bush, Republican family-values attacks, Hillary Clinton, Tipper Gore, Molly Ivins, George Will, David Broder, Pat Buchanan, and campaign commentary.",
      evidence:
        "Itemized from the Mrs. Bush Daily Press cover page and clipping sequence found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "douglas-coe-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Douglas E. Coe correspondence packet",
      documentDate: "1992-08-26",
      pages: 2,
      excerpt:
        "The President replies to Douglas E. Coe that he is confident the American people will support him in November; Coe's incoming handwritten letter is attached.",
      evidence:
        "Itemized from George Bush letterhead and the attached Douglas E. Coe incoming letter page found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "your-questions-note-jack-stein-mason-dixon-poll",
      documentType: "Presidential Note Packet",
      category: "presidential-note-packet",
      disposition: "itemized-presidential-note-packet",
      title:
        "Note for the President re Your Questions, Jack Stein meeting, and Mason-Dixon poll",
      documentDate: "1992-08-26",
      pages: 4,
      excerpt:
        "A note packet marked President Has Seen addresses the President's questions, a possible Jack Stein meeting, and a Ron Kaufman report on an August 21-24 Mason-Dixon poll.",
      evidence:
        "Itemized from the Note for the President page, handwriting-marked pages, and Mason-Dixon poll note found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "low-confidence-correspondence-and-jerry-weintraub-fax",
      documentType: "Correspondence and Fax Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Low-confidence correspondence page and Jerry Weintraub fax packet",
      documentDate: "1992-08-26",
      pages: 3,
      excerpt:
        "The packet includes a low-confidence handwritten/address page and correspondence with Jerry Weintraub, including an incoming personal fax and a presidential response.",
      evidence:
        "Itemized from rendered-page review and partial OCR of the Ghaffari address page, Jerry Weintraub fax page, and outgoing White House letter.",
    },
    {
      slug: "illinois-ceo-foul-up-governor-edgar-correspondence",
      documentType: "Campaign Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Illinois CEO foul-up correspondence packet with Governor Jim Edgar and business leaders",
      documentDate: "1992-08-26",
      pages: 24,
      excerpt:
        "The packet includes the President's note to Governor Jim Edgar, address and attendee lists, and apology letters to Illinois business leaders after a campaign-event scheduling foul-up.",
      evidence:
        "Itemized from the Jim Edgar correspondence, Presidential Event attendee list, Bush-Quayle address pages, and outgoing apology-letter sequence found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-august-26-1992-a",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages, August 26, 1992 [1]",
      documentDate: "1992-08-26",
      pages: 4,
      excerpt:
        "A photo-transfer cluster includes color campaign-event photographs, blank or backing pages, and an Official White House Photo transfer page.",
      evidence:
        "Itemized from rendered-page review of color photo pages and Official White House Photo transfer/backing pages in the NARA direct folder scan.",
    },
    {
      slug: "washington-post-clippings-august-26-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Post clippings on Balkan policy, campaign politics, Iran-Contra, Iraq, and family values",
      documentDate: "1992-08-26",
      pages: 18,
      excerpt:
        "The Washington Post clipping run covers State Department dissent on Balkans policy, congressional spending charges, Clinton draft issues, Iraq, CNN audiences, Iran-Contra, the no-fly zone, auto jobs, family values, Brazil, and Clinton trade questions.",
      evidence:
        "Itemized from Washington Post mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "los-angeles-times-clippings-august-26-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on Orange County, famine relief, China, Korea, Iran-Contra, veterans, Iraq, and Baker",
      documentDate: "1992-08-26",
      pages: 14,
      excerpt:
        "The Los Angeles Times clipping packet covers Bush's Orange County troubles, U.N. famine relief, campaign attacks, one-China policy, Korea, Iran-Contra documents, veterans, the Gulf War, Baker's campaign role, and the Iraq no-fly zone.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "usa-today-clippings-august-26-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "USA Today clippings on veterans, Clinton, education, protests, and Hurricane Andrew",
      documentDate: "1992-08-26",
      pages: 6,
      excerpt:
        "USA Today clippings include veterans-campaign coverage, Clinton and Bush, education initiatives, protesters, Hurricane Andrew, and veterans' reactions to Clinton.",
      evidence:
        "Itemized from USA Today mastheads and article starts found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "wall-street-journal-articles-august-26-1992",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on veterans, the Fed, Japan, the Intifada, and Korea-China relations",
      documentDate: "1992-08-26",
      pages: 6,
      excerpt:
        "The Wall Street Journal packet covers veteran concerns, political pressure on the Federal Reserve, Japan's financial system, the Intifada, and Korea-China relations.",
      evidence:
        "Itemized from Wall Street Journal mastheads and article starts found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "new-york-times-clippings-august-26-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on campaign infidelity, U.N. forces, family life, scholarships, polls, chemical weapons, and autos",
      documentDate: "1992-08-26",
      pages: 9,
      excerpt:
        "The New York Times clipping packet includes articles and commentary on campaign infidelity, a standing U.N. force, family life, scholarships, Bush's convention bounce, convention rhetoric, chemical-weapons bans, autos, and trade.",
      evidence:
        "Itemized from New York Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "washington-times-clippings-august-26-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on foreign policy, taxation, trade, Hillary Clinton, veterans, Baker, and autoworkers",
      documentDate: "1992-08-26",
      pages: 17,
      excerpt:
        "The Washington Times clipping packet includes columns and articles on foreign policy, tax failure, trade, Hillary Clinton, the American Legion, Baker's campaign role, Bush and autoworkers, and campaign themes.",
      evidence:
        "Itemized from Washington Times mastheads, column/article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "convention-thank-you-correspondence-gatlins-mcraney-sanford",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Convention thank-you correspondence to the Gatlin Brothers, Gerald McRaney, and Emile J. Roy",
      documentDate: "1992-08-26",
      pages: 3,
      excerpt:
        "The correspondence packet includes thank-you letters after the Republican convention to the Gatlin Brothers and Gerald McRaney, plus a repeated campaign-buttons thank-you letter to Emile J. Roy.",
      evidence:
        "Itemized from White House outgoing correspondence pages found in full-PDF OCR and rendered-page review near the end of the NARA direct folder scan.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-august-26-1992-b",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages, August 26, 1992 [2]",
      documentDate: "1992-08-26",
      pages: 8,
      excerpt:
        "A final photo-transfer cluster includes color photographs and backing or transfer pages from an Oval Office or White House meeting sequence.",
      evidence:
        "Itemized from rendered-page review of color photo pages and blank/backing transfer pages at the end of the NARA direct folder scan.",
    },
  ],
  470418028: [
    {
      slug: "richard-vigilante-bush-economic-record-column",
      documentType: "Press Column",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title:
        "Richard Vigilante column: Bush's economic record among century's best",
      documentDate: "1992-08-28",
      pages: 1,
      excerpt:
        "A Houston Chronicle column by Richard Vigilante argues that President Bush should run on his domestic economic record, including inflation, trade, and post-Cold War markets.",
      evidence:
        "Itemized from the clipped Houston Chronicle column attached to the John B. Ashmun correspondence in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "william-prescott-bush-whataburger-poll-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "William Prescott Bush Whataburger poll correspondence",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "The packet includes the President's response to William Prescott Bush, thanking him for Whataburger poll results, and the H&Q Asia Pacific letter reporting informal consumer confidence in George Bush after the convention speech.",
      evidence:
        "Itemized from the White House outgoing letter and H&Q Asia Pacific incoming letter found after the catalog OCR cutoff in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "pool-reports-humbolt-lubbock-fort-worth",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title: "Pool reports: Humbolt to Lubbock and Lubbock to Fort Worth, September 2, 1992",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "Two pool reports cover the President after the Humbolt speech, the arrival in Lubbock, remarks to military personnel, and the Lubbock-to-Fort Worth leg.",
      evidence:
        "Itemized from Pool Report headings and trip-leg pages found after the catalog OCR cutoff in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "mrs-bush-daily-press-clippings-september-2-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings, September 2, 1992",
      documentDate: "1992-09-02",
      pages: 20,
      excerpt:
        "Mrs. Bush's Daily Press clipping packet covers Barbara Bush campaign appearances, New Mexico stops, first-lady commentary, Hurricane Andrew response, and related campaign coverage.",
      evidence:
        "Itemized from the Mrs. Bush Daily Press cover page and clipping sequence found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "hurricane-andrew-response-clippings-with-president-handwriting",
      documentType: "Press Clipping Packet with President Bush Handwriting",
      category: "hurricane-andrew-clippings",
      disposition: "itemized-hurricane-andrew-clippings",
      title: "Hurricane Andrew response clippings with President Bush handwriting",
      documentDate: "1992-09-02",
      pages: 6,
      excerpt:
        "A clipping packet marked with President Bush handwriting collects coverage of Bush touring areas hit by Hurricane Andrew, federal aid, reconstruction, and storm-response problems.",
      evidence:
        "Itemized from a Document Originally Attached marker, Bush handwriting markers, and Washington Times and Los Angeles Times Hurricane Andrew clippings in rendered-page review.",
    },
    {
      slug: "raymond-price-florida-fax-packet",
      documentType: "Presidential Fax and Note Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Raymond K. Price fax packet on Florida storm response",
      documentDate: "1992-08-31",
      pages: 4,
      excerpt:
        "The packet includes a September 2 note to the President about a call from Blitz Robinson and a Ray Price fax on Florida after a damage-assessment trip to Miami.",
      evidence:
        "Itemized from the typed note, Raymond K. Price transmittal page, fax memorandum, and fax cover sheet found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "secret-service-magaw-peake-air-force-one-correspondence",
      documentType: "Correspondence and Handwriting Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Secret Service, John W. Magaw, David W. Peake, and Air Force One correspondence packet",
      documentDate: "1992-09-02",
      pages: 8,
      excerpt:
        "A low-confidence correspondence packet includes pages addressed to Secret Service Director John W. Magaw, a Treasury Secret Service envelope page, David W. Peake correspondence, Aboard Air Force One notes, and President Bush handwriting asking for media-study summaries.",
      evidence:
        "Itemized from rendered-page review and partial OCR of White House transmittal pages, Secret Service material, Air Force One notes, and Bush Library handwriting markers.",
    },
    {
      slug: "christen-smith-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Christen Smith correspondence packet",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "A White House correspondence packet is addressed to Christen Smith of Idalou, Texas, with a low-OCR attached page or drawing.",
      evidence:
        "Itemized from the White House address page and attached low-confidence visual page found in rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "daily-news-clips-office-media-affairs-september-2-1992",
      documentType: "Daily News Clips",
      category: "daily-news-clips",
      disposition: "itemized-daily-news-clips",
      title: "Office of Media Affairs Daily News Clips, September 2, 1992",
      documentDate: "1992-09-02",
      pages: 19,
      excerpt:
        "The Office of Media Affairs daily clips packet opens with Washington Post coverage and columns on the Shultz memorandum, candidates' road shows, media coverage, capital gains, F-16 sales to Taiwan, peace talks, Gulf press rules, federal spending, Russia uranium, and television coverage.",
      evidence:
        "Itemized from the Daily News Clips cover page, Washington Post mastheads, and article starts found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "wall-street-journal-articles-september-2-1992",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on grain exports, F-16s, stock exchanges, agriculture, the ABA, scandal, and Kimba Wood",
      documentDate: "1992-09-02",
      pages: 7,
      excerpt:
        "The Wall Street Journal packet covers a possible grain-export program, F-16 sales to Taiwan, stock-exchange rules, farm regulation, the ABA, corruption and scandal, and Judge Kimba Wood.",
      evidence:
        "Itemized from Wall Street Journal mastheads and article starts found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "new-york-times-clippings-september-2-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on Russian uranium, South Florida, China, Bosnia, Hurricane Andrew, and Al Gore",
      documentDate: "1992-09-02",
      pages: 10,
      excerpt:
        "The New York Times clipping packet covers Russian bomb uranium, post-hurricane South Florida, Chinese prisoners, Bosnia, Hurricane Andrew and incumbency, rebuilding in South Florida, an unannounced Bush visit, and Al Gore.",
      evidence:
        "Itemized from New York Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "washington-times-clippings-september-2-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on campaigns, social policy, flood insurance, taxes, environment, veterans, arms cuts, and global peace",
      documentDate: "1992-09-02",
      pages: 18,
      excerpt:
        "The Washington Times clipping packet includes columns and articles on Clarence Page, social policy, nuclear power, hurricanes and flood insurance, clear contrasts between parties, environment, veterans, Florida cleanup, arms cuts and jobs, and global peace.",
      evidence:
        "Itemized from Washington Times mastheads, column starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "los-angeles-times-clippings-september-2-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on Hurricane Andrew, Clinton draft issues, Iraq loans, Quayle, taxes, Gore, Woody Allen, the Middle East, and chemical weapons",
      documentDate: "1992-09-02",
      pages: 17,
      excerpt:
        "The Los Angeles Times clipping packet covers Hurricane Andrew aid and troop relief, Clinton draft issues, Iraq loan investigations, Quayle on Clinton's jobs plan, Bush tax-loophole attacks, Gore and state budgets, Woody Allen commentary, Palestinian negotiations, culture, economic expertise, chemical weapons, and air power.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
  ],
  470418030: [
    {
      slug: "nicholas-brady-ashmun-vigilante-case-for-bush-packet",
      documentType: "Article Routing Packet with President Bush Handwriting",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title:
        "Nicholas Brady and John Ashmun routing packet with Richard Vigilante article, 'The Case for Bush'",
      documentDate: "1992-09-03",
      pages: 4,
      excerpt:
        "The packet includes a routing note marked with President Bush handwriting, Nicholas Brady and John B. Ashmun references, and Richard Vigilante's article arguing that Bush's economic record was stronger than the campaign debate allowed.",
      evidence:
        "Itemized from routing-page handwriting, the 'Have shared cc of article with JABIII' note, article heading, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "nicaraguan-president-chamorro-hurricane-andrew-response",
      documentType: "Diplomatic Correspondence and Cable Packet",
      category: "foreign-leader-correspondence",
      disposition: "itemized-diplomatic-correspondence",
      title: "Nicaraguan President Violeta Chamorro Hurricane Andrew correspondence packet",
      documentDate: "1992-09-03",
      pages: 4,
      excerpt:
        "A confidential memorandum and outgoing response thank President Violeta Chamorro for concern over Hurricane Andrew, with State Department cable text and Spanish-language incoming message pages attached.",
      evidence:
        "Itemized from the confidential action memorandum, White House outgoing letter, State cable pages, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-2pm-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 2:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 3,
      excerpt:
        "The 2:00 p.m. wire summary covers Hurricane Andrew generosity politics, F-16 sales to Taiwan, a dissident Foreign Service officer, and Sen. Barbara Mikulski's criticism of FEMA response.",
      evidence:
        "Itemized from the 2:00 p.m. White House News Summary heading and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "schedule-of-the-president-september-3-1992",
      documentType: "Presidential Schedule",
      category: "presidential-schedule",
      disposition: "itemized-presidential-schedule",
      title: "Schedule of the President, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 1,
      excerpt:
        "The schedule page lists the President's September 3 meetings, interviews, private office time, remarks, and calls at the White House.",
      evidence:
        "Itemized from the Schedule of the President page found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "meeting-with-administrator-saiki-sba-disaster-assistance",
      documentType: "Meeting Briefing",
      category: "meeting-briefing",
      disposition: "itemized-meeting-briefing",
      title: "Briefing for meeting with SBA Administrator Patricia Saiki on disaster assistance",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "The briefing describes a September 3 Oval Office meeting with SBA Administrator Patricia Saiki on her trip and the Small Business Administration's Hurricane Andrew disaster-assistance programs.",
      evidence:
        "Itemized from the meeting memorandum, participants and sequence pages, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "briefing-for-agriculture-interviews-september-3-1992",
      documentType: "Interview Briefing",
      category: "media-briefing",
      disposition: "itemized-media-briefing",
      title: "Briefing for agriculture television interviews, September 3, 1992",
      documentDate: "1992-09-02",
      pages: 3,
      excerpt:
        "The briefing lays out the President's interviews with agricultural reporters, including objectives, participants, sequence of events, press plan, and themes around disaster and farm policy.",
      evidence:
        "Itemized from White House briefing pages for agriculture interviews found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-8am-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 8:00 a.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 2,
      excerpt:
        "The 8:00 a.m. wire summary covers mental-health workers and Hurricane Andrew relief, Gloria Estefan's benefit plans, housing and federal response, and overnight campaign news.",
      evidence:
        "Itemized from the 8:00 a.m. White House News Summary heading and continuation page found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-1030-news-update-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 10:30 a.m. news update, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 2,
      excerpt:
        "The 10:30 a.m. update includes Hurricane Andrew coverage, wheat and Australia, Russian uranium, Bosnia, and China's reaction to the Taiwan F-16 sale.",
      evidence:
        "Itemized from the 10:30 a.m. News Update heading and continuation page found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "fred-steeper-trust-issue-memo-and-president-note-to-baker",
      documentType: "Campaign Strategy Memorandum with President Bush Handwriting",
      category: "campaign-strategy-memorandum",
      disposition: "itemized-campaign-strategy-memorandum",
      title: "Fred Steeper memorandum on the trust issue and President Bush note to Jim Baker",
      documentDate: "1992-09-02",
      pages: 3,
      excerpt:
        "Fred Steeper warns that 'trust' carries a job-performance liability in focus groups; President Bush forwards questions to Jim Baker about why convention themes that seemed to close the gap were no longer persuasive.",
      evidence:
        "Itemized from the note to POTUS, Fred Steeper memorandum marked 'The President Has Seen,' and the President's September 2 note to Jim Baker in rendered-page review.",
    },
    {
      slug: "white-house-news-summary-noon-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 12:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 7,
      excerpt:
        "The noon wire packet covers capital-gains indexing, the AFL-CIO endorsement of Clinton, EC concerns over wheat subsidies, retail sales, Taiwan F-16 analysis, Israeli-Palestinian autonomy, and other wire items.",
      evidence:
        "Itemized from the 12:00 p.m. wires heading, wire-story starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "cea-unemployment-productivity-poverty-memos-september-2-1992",
      documentType: "Economic Memoranda with President Bush Handwriting",
      category: "economic-briefing-memorandum",
      disposition: "itemized-economic-briefing",
      title: "Council of Economic Advisers memoranda on unemployment claims, productivity, and poverty",
      documentDate: "1992-09-02",
      pages: 2,
      excerpt:
        "Michael Boskin and the Council of Economic Advisers brief the President on initial unemployment claims, second-quarter productivity, poverty and family income data, and productivity and cost indicators.",
      evidence:
        "Itemized from Council of Economic Advisers memorandum headings, chart page, Bush handwriting markers, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-1pm-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 1:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 10,
      excerpt:
        "The 1:00 p.m. wires cover White House reaction to China over the F-16 sale, Hurricane Andrew aid, disaster-response criticism, Mario Cuomo in Israel, SSI recommendations, Hollywood donors, conservation ratings, the AFL-CIO, Bosnia, and chemical weapons.",
      evidence:
        "Itemized from the 1:00 p.m. White House News Summary heading, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-130-news-update-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 1:30 p.m. news update, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 1,
      excerpt:
        "The 1:30 p.m. update summarizes chemical-weapons treaty movement, Sen. Mikulski and FEMA, Middle East peace, wheat and Ohio farmers, and related wire developments.",
      evidence:
        "Itemized from the 1:30 p.m. News Update page found in full-PDF OCR and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "ron-kaufman-andy-williams-campaign-rally-correspondence",
      documentType: "Campaign Correspondence Packet with President Bush Handwriting",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Ron Kaufman and Andy Williams campaign-rally correspondence packet",
      documentDate: "1992-09-03",
      pages: 3,
      excerpt:
        "President Bush asks Ron Kaufman to contact supporter Andy Williams about a Branson rally and performance issue, with address and handwritten drafting material attached.",
      evidence:
        "Itemized from the President's note to Ron K., Andy Williams address page, handwriting page, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-international-and-clipping-pages-september-3-1992",
      documentType: "White House News Summary Clipping Pages",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary international and newspaper highlight pages, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 4,
      excerpt:
        "The summary pages excerpt international and newspaper coverage on Iraq, Palestinian negotiations, Taiwan and China, capital gains, the Bush Justice Department, wheat farmers, arms workers, and campaign largesse.",
      evidence:
        "Itemized from White House News Summary A-page headings, source attributions, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "hotline-daily-briefing-september-3-1992",
      documentType: "Campaign News Digest",
      category: "campaign-news-digest",
      disposition: "itemized-campaign-news-digest",
      title: "The Hotline Daily Briefing, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 24,
      excerpt:
        "The Hotline Daily Briefing packet covers national polls, family-values fallout, Clinton and Bush campaign themes, Hurricane Andrew politics, Senate races, electoral scoreboard notes, state races, and television-monitor items.",
      evidence:
        "Itemized from The Hotline Daily Briefing masthead, section headings, scoreboard pages, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "sheila-tate-weta-broadcasts-correspondence",
      documentType: "Presidential Correspondence Packet with President Bush Handwriting",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Sheila Tate and WETA broadcasts correspondence packet",
      documentDate: "1992-09-03",
      pages: 5,
      excerpt:
        "President Bush writes Sheila Tate about WETA and post-convention broadcast criticism, with a Powell Tate note and Sharon Percy Rockefeller/WETA correspondence attached.",
      evidence:
        "Itemized from the note to the President, presidential letter copies, Powell Tate and WETA pages, and rendered-page review.",
    },
    {
      slug: "jack-guy-appointments-correspondence",
      documentType: "Presidential Correspondence Packet with President Bush Handwriting",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Jack O. Guy appointments and scheduling correspondence packet",
      documentDate: "1992-09-03",
      pages: 4,
      excerpt:
        "The packet includes an appointments-and-scheduling routing note, Bush handwriting, the President's response to Jack O. Guy, and Guy's incoming letter from Atlanta.",
      evidence:
        "Itemized from the scheduling memorandum, Bush Library handwriting marker, Jack O. Guy address and letter pages, and rendered-page review.",
    },
    {
      slug: "bobbie-kilberg-marion-chambers-iaia-note",
      documentType: "Staff Note with President Bush Handwriting",
      category: "staff-note",
      disposition: "itemized-staff-note",
      title: "Bobbie Kilberg note on Marion Chambers and the Institute of American Indian Art",
      documentDate: "1992-09-01",
      pages: 1,
      excerpt:
        "Bobbie Kilberg reports to the President and Mrs. Bush on Marion Chambers, the Institute of American Indian Art, and a possible San Diego picnic, with Bush routing to Connie Horner.",
      evidence:
        "Itemized from the Bobbie Kilberg memorandum page, sticky-note routing, President Bush handwriting, and rendered-page review.",
    },
    {
      slug: "bob-macaulay-americares-donation-note",
      documentType: "Personal Note and Donation Check",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title: "President Bush note and AmeriCares donation check to Bob Macaulay",
      documentDate: "1992-09-03",
      pages: 1,
      excerpt:
        "President Bush sends Bob Macaulay an AmeriCares donation check with a handwritten note thanking him and Barbara for helping others.",
      evidence:
        "Itemized from the President's handwritten note, Riggs check image, AmeriCares payee line, and rendered-page review.",
    },
    {
      slug: "shirley-green-health-update-note",
      documentType: "Staff Note with President Bush Handwriting",
      category: "staff-note",
      disposition: "itemized-staff-note",
      title: "Shirley Green health update note",
      documentDate: "1992-09-03",
      pages: 1,
      excerpt:
        "A short RZ note tells the President that Shirley Green's tests came back negative, with President Bush handwriting directing the update to the First Lady's office.",
      evidence:
        "Itemized from the September 3 note page and handwriting visible in rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "boston-globe-family-values-aids-letter-routing",
      documentType: "Incoming Letter and Routing Packet with President Bush Handwriting",
      category: "incoming-correspondence",
      disposition: "itemized-incoming-correspondence",
      title: "Boston Globe letter packet on family values, AIDS, and presidential response routing",
      documentDate: "1992-09-03",
      pages: 3,
      excerpt:
        "The packet includes President Bush handwriting and an incoming Boston Globe Washington Bureau letter about family values, AIDS, and the President's public comments, with routing notes to Marlin Fitzwater and others.",
      evidence:
        "Itemized from the President's handwritten routing page, Boston Globe letterhead and envelope page, and rendered-page review.",
    },
    {
      slug: "tom-stroock-guatemala-immigration-los-angeles-cost-impact-packet",
      documentType: "Immigration Policy Correspondence Packet with President Bush Handwriting",
      category: "immigration-policy-correspondence",
      disposition: "itemized-immigration-policy-correspondence",
      title: "Tom Stroock, Guatemala, immigration, and Los Angeles County cost-impact packet",
      documentDate: "1992-09-03",
      pages: 13,
      excerpt:
        "The packet includes President Bush's note to Phil Brady about Tom Stroock, Embassy Guatemala correspondence, a Roger Porter memorandum, and Los Angeles County Supervisor Michael D. Antonovich material on deportable aliens and public-service costs.",
      evidence:
        "Itemized from the President's note to Phil Brady, embassy pages, Roger Porter memorandum heading, Antonovich fax pages, cost-impact appendix pages, and rendered-page review.",
    },
    {
      slug: "verta-hardegree-devan-anderson-fort-worth-message-packet",
      documentType: "Phone Message and Correspondence Packet",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title: "Verta Hardegree phone message and Devan Anderson Fort Worth correspondence packet",
      documentDate: "1992-09-03",
      pages: 3,
      excerpt:
        "A phone message from Verta Hardegree about the President's Shallowater visit appears with Fort Worth correspondence and a low-confidence attached visual page.",
      evidence:
        "Itemized from the phone-message page, White House address page, attached visual page, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-4pm-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 4:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 1,
      excerpt:
        "The 4:00 p.m. wire page leads with an Italian cargo plane crash near Sarajevo and includes additional wire coverage in the late-afternoon news cycle.",
      evidence:
        "Itemized from the 4:00 p.m. White House News Summary heading and rendered-page review.",
    },
    {
      slug: "amir-kuwait-red-cross-hurricane-andrew-thank-you-call",
      documentType: "Diplomatic Call Note and Telegram Packet with President Bush Handwriting",
      category: "foreign-leader-correspondence",
      disposition: "itemized-diplomatic-correspondence",
      title: "Amir of Kuwait Red Cross donation thank-you call and telegram packet",
      documentDate: "1992-09-03",
      pages: 4,
      excerpt:
        "President Bush notes that he called Kuwait's ambassador to thank the Amir for a $10 million Red Cross contribution for Hurricane Andrew, with handwriting marker and Kuwait Embassy telegram pages attached.",
      evidence:
        "Itemized from the President's note to Brent Scowcroft and Jim Baker, Bush Library handwriting marker, Kuwait Embassy telegram pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-3pm-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 3:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 10,
      excerpt:
        "The 3:00 p.m. wires cover Bush's election-season policy moves, White House criticism of poll coverage, Labor Day campaign travel, Clinton's Florida hurricane visit, Hurricane Andrew relief funding, chemical weapons, Hispanic Heritage Month, and Glass Ceiling Commission appointments.",
      evidence:
        "Itemized from the 3:00 p.m. White House News Summary heading, article starts, and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "dan-king-japan-correspondence-packet",
      documentType: "Presidential Correspondence Packet with President Bush Handwriting",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Dan King Japan correspondence packet",
      documentDate: "1992-09-03",
      pages: 5,
      excerpt:
        "The packet includes a Bush Library handwriting marker, President Bush correspondence to Dan King in Aichi-ken, Japan, a photograph or low-confidence visual attachment, and King's incoming letter to the President.",
      evidence:
        "Itemized from the attached-marker page, Dan King address page, photograph page, incoming letter, President Bush handwriting, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-5pm-wires-september-3-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 5:00 p.m. wires, September 3, 1992",
      documentDate: "1992-09-03",
      pages: 5,
      excerpt:
        "The 5:00 p.m. wires cover the Bush campaign's rejection of a debate proposal, charges over Bush's claim that Clinton raised taxes 128 times, and U.S. aid for Nicaragua after tidal-wave damage.",
      evidence:
        "Itemized from the 5:00 p.m. White House News Summary heading, wire-story starts, and rendered-page review.",
    },
    {
      slug: "ronald-kaufman-florida-nevada-primary-activity-report",
      documentType: "Political Briefing Report with President Bush Handwriting",
      category: "political-briefing-report",
      disposition: "itemized-political-briefing-report",
      title: "Ronald C. Kaufman addendum and Florida/Nevada primary activity report",
      documentDate: "1992-09-02",
      pages: 6,
      excerpt:
        "Ronald C. Kaufman sends the President an addendum on Broward County Sheriff Nick Navarro and the Florida primary election briefing, followed by a primary activity report covering Florida and Nevada races.",
      evidence:
        "Itemized from the Kaufman memorandum heading, President Bush handwriting, Primary Activity Report pages, and rendered-page review.",
    },
    {
      slug: "john-gardner-resignation-correspondence",
      documentType: "Resignation Correspondence",
      category: "staff-correspondence",
      disposition: "itemized-staff-correspondence",
      title: "John S. Gardner resignation correspondence packet",
      documentDate: "1992-09-03",
      pages: 2,
      excerpt:
        "The packet includes President Bush's letter accepting John S. Gardner's resignation as Special Assistant to the President and Deputy Staff Secretary, with Gardner's August 24 resignation letter attached.",
      evidence:
        "Itemized from the President's signed acceptance letter, John S. Gardner incoming resignation letter, and rendered-page review.",
    },
    {
      slug: "bob-teeter-richard-kerr-campaign-surrogate-memo",
      documentType: "Campaign Memorandum with President Bush Handwriting",
      category: "campaign-strategy-memorandum",
      disposition: "itemized-campaign-strategy-memorandum",
      title: "Bob Teeter memorandum on Richard Kerr's campaign surrogate assistance",
      documentDate: "1992-09-02",
      pages: 1,
      excerpt:
        "Bob Teeter tells the President that Richard Kerr's interest in helping the campaign will be used for future national-security policy opportunities, noting Kerr's participation in a September 15 scientists' committee briefing for public information.",
      evidence:
        "Itemized from the Bob Teeter memorandum page, President Bush handwriting to Brent Scowcroft, and rendered-page review.",
    },
  ],
  470418041: [
    {
      slug: "russell-sellers-asheville-visit-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Russell Sellers Asheville and Hendersonville visit correspondence packet",
      documentDate: "1992-09-08",
      pages: 2,
      excerpt:
        "President Bush thanks Russell Sellers for support and prayers after the Asheville and Hendersonville visit, with Sellers's handwritten incoming note attached.",
      evidence:
        "Itemized from the President's outgoing letter to Russell Sellers, incoming handwritten note, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "bnai-brith-international-convention-remarks-september-8-1992",
      documentType: "Speech Text",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title: "Remarks to the B'nai B'rith International Convention, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 21,
      excerpt:
        "The speech text thanks B'nai B'rith, invokes George Washington's letter to the Hebrew Congregation of Rhode Island, discusses anti-Semitism, Madrid peace talks, loan guarantees, Israel's security, and the post-Cold War world.",
      evidence:
        "Itemized from the B'nai B'rith speech heading, numbered remarks pages, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-10am-wires-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 10:00 a.m. wires, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 3,
      excerpt:
        "The 10:00 a.m. wires cover President Bush's request for Hurricane Andrew aid and the death of Sen. Quentin Burdick of North Dakota.",
      evidence:
        "Itemized from the 10:00 a.m. White House News Summary heading and continuation pages found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-11am-wires-and-cnn-candidates-report-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 11:00 a.m. wires and CNN candidates report, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 3,
      excerpt:
        "The 11:00 a.m. summary repeats Hurricane Andrew aid coverage and includes a CNN report comparing candidate economic claims, campaign themes, and typical stump-speech lines.",
      evidence:
        "Itemized from the 11:00 a.m. White House News Summary heading, CNN report pages, and rendered-page review.",
    },
    {
      slug: "congressional-monitor-september-8-1992",
      documentType: "Legislative Digest",
      category: "legislative-digest",
      disposition: "itemized-legislative-digest",
      title: "Congressional Monitor, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 20,
      excerpt:
        "The Congressional Monitor packet covers legislative outlook, Senate primaries, the START Treaty, appropriations, House and Senate committee schedules, conference committee future listings, other events, campaign future listings, and floor action.",
      evidence:
        "Itemized from Congressional Monitor masthead, page numbers, section headings, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "congress-in-print-september-8-1992",
      documentType: "Legislative Publications Digest",
      category: "legislative-digest",
      disposition: "itemized-legislative-digest",
      title: "Congress in Print, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 4,
      excerpt:
        "The Congress in Print packet lists recent Senate and House committee publications, Government Printing Office stock numbers, and congressional publication summaries.",
      evidence:
        "Itemized from Congress in Print masthead, publications listings, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "president-handwriting-california-bush-surge-clipping",
      documentType: "Handwritten Note and News Clipping",
      category: "campaign-press-clipping",
      disposition: "itemized-campaign-press-clipping",
      title: "President Bush handwriting note and national-news clipping on Bush surge in California",
      documentDate: "1992-09-08",
      pages: 2,
      excerpt:
        "A President Bush handwriting page notes campaign and media questions, followed by a national-news clipping on a Bush surge in California and Republican plans for the state's presidential race.",
      evidence:
        "Itemized from the Bush Library handwriting page, national-news clipping heading, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-noon-wires-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 12:00 p.m. wires, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 5,
      excerpt:
        "The noon wires cover Bush pushing Israel aid and Clinton courting blue-collar workers, Clinton campaign strategy, Arkansas record coverage, Social Security Commissioner Gwendolyn King's resignation, and related campaign stories.",
      evidence:
        "Itemized from the 12:00 p.m. White House News Summary heading, article starts, and rendered-page review.",
    },
    {
      slug: "hurricane-andrew-typhoon-omar-emergency-supplemental-requests",
      documentType: "Press Release and Budget Tables with President Bush Handwriting",
      category: "hurricane-andrew-disaster-aid",
      disposition: "itemized-disaster-aid-request",
      title: "President's emergency supplemental requests for Hurricane Andrew and Typhoon Omar",
      documentDate: "1992-09-08",
      pages: 26,
      excerpt:
        "The White House press release and attached budget tables describe the President's emergency supplemental requests for Hurricane Andrew and Typhoon Omar across agriculture, commerce, defense, education, FEMA, health and human services, housing, interior, justice, labor, transportation, Treasury, VA, and related agencies.",
      evidence:
        "Itemized from the Office of the Press Secretary release, President Bush handwriting, budget-table title pages, agency/program listings, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-1pm-wires-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 1:00 p.m. wires, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 2,
      excerpt:
        "The 1:00 p.m. wires cover Sen. George Mitchell urging scrutiny of Bush on Iran-Contra and attorneys providing free legal advice after Hurricane Andrew.",
      evidence:
        "Itemized from the 1:00 p.m. White House News Summary heading and continuation page found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "hotline-daily-briefing-september-8-1992",
      documentType: "Campaign News Digest",
      category: "campaign-news-digest",
      disposition: "itemized-campaign-news-digest",
      title: "The Hotline Daily Briefing, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 25,
      excerpt:
        "The Hotline packet covers Labor Day campaign coverage, Los Angeles and California, Gore and Clinton themes, electoral-map analysis, Senate and governors' races, poll updates, and television-monitor items.",
      evidence:
        "Itemized from The Hotline Daily Briefing masthead, numbered section headings, poll tables, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-1130-news-update-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 11:30 a.m. news update, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 1,
      excerpt:
        "The 11:30 a.m. update summarizes Bush's Hurricane Andrew request, POW/MIA materials, and additional wire items in the late-morning news cycle.",
      evidence:
        "Itemized from the 11:30 a.m. News Update page found in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "note-to-jab-uaw-workers-hamtramck-event",
      documentType: "Campaign Event Note with President Bush Handwriting",
      category: "campaign-event-note",
      disposition: "itemized-campaign-event-note",
      title: "Note to JAB on UAW workers and the Hamtramck event",
      documentDate: "1992-09-08",
      pages: 1,
      excerpt:
        "A note to James A. Baker III explains that UAW workers were not seated at the Hamtramck event because there was no seating at the parade, with President Bush handwriting visible.",
      evidence:
        "Itemized from the September 8 note to JAB, Bush Library handwriting marker, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-2pm-news-september-8-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 2:00 p.m. news, September 8, 1992",
      documentDate: "1992-09-08",
      pages: 1,
      excerpt:
        "The 2:00 p.m. news page covers Sen. Mitchell and Iran-Contra, Bush policy or campaign moves, and additional afternoon wire headlines.",
      evidence:
        "Itemized from the 2:00 p.m. White House News Summary page found in full-PDF OCR and rendered-page review.",
    },
  ],
  470418057: [
    {
      slug: "telephone-memoranda-september-14-1992",
      documentType: "Telephone Memoranda",
      category: "telephone-log",
      disposition: "itemized-telephone-log",
      title: "White House telephone memoranda, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "Two White House telephone memorandum pages record President Bush and Signal Switchboard call traffic for September 14.",
      evidence:
        "Itemized from White House telephone memorandum forms found after the Burrill Lumber remarks draft in full-PDF OCR and rendered-page review.",
    },
    {
      slug: "presidential-movements-september-14-1992",
      documentType: "Presidential Movements",
      category: "presidential-schedule",
      disposition: "itemized-presidential-schedule",
      title: "Presidential movements, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "The movements pages trace the President's September 14 stops from San Diego through Spokane, Colville, Medford, and Salt Lake City.",
      evidence:
        "Itemized from Presidential Movements pages and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "hotline-daily-briefing-september-14-1992",
      documentType: "Campaign News Digest",
      category: "campaign-news-digest",
      disposition: "itemized-campaign-news-digest",
      title: "The Hotline Daily Briefing, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 25,
      excerpt:
        "The Hotline Daily Briefing covers Bush campaign moves, the spotted owl and timber issue, Clinton draft questions, California and Ohio polling, Senate and House races, governors' races, Newsweek polling, and television-monitor notes.",
      evidence:
        "Itemized from The Hotline Daily Briefing masthead, numbered section headings, poll tables, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-10am-pdt-1pm-edt-september-14-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 10:00 a.m. PDT / 1:00 p.m. EDT news update, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "The news update includes midday items on the campaign, the Middle East talks, the House agenda, and Hurricane Iniki coverage.",
      evidence:
        "Itemized from the 10:00 a.m. PDT / 1:00 p.m. EDT White House News Summary heading and continuation page.",
    },
    {
      slug: "kennedy-center-board-selection-packet",
      documentType: "Personnel Memorandum with President Bush Handwriting",
      category: "presidential-personnel",
      disposition: "itemized-presidential-personnel",
      title: "Constance Horner memorandum on Kennedy Center Board of Trustees selections",
      documentDate: "1992-09-07",
      pages: 6,
      excerpt:
        "Constance Horner briefs the President on John F. Kennedy Center for the Performing Arts Board of Trustees appointments, with membership lists and recommended nominees including Philip Anschutz, Stuart Bernstein, Alma Powell, Janie R. Ikard, and Barbara Barrett.",
      evidence:
        "Itemized from the original-attached marker, Horner memorandum heading, trustee list pages, President Bush handwriting, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-6am-edition-september-14-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 6:00 a.m. EDT edition, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 24,
      excerpt:
        "The morning News Summary covers trip news, Reagan and Dornan at Yorba Linda, Bush and Clinton campaign attacks, endangered-species and timber coverage, Hurricane Iniki, health care, federal salaries, IRAs, Israel and Saudi arms sales, IMF deficit criticism, Bosnia, network news, and weekend television transcripts.",
      evidence:
        "Itemized from the Office of the Press Secretary News Summary cover page, section headings, A/B/C page numbers, and rendered-page review.",
    },
    {
      slug: "congressional-monitor-september-14-1992",
      documentType: "Legislative Digest",
      category: "legislative-digest",
      disposition: "itemized-legislative-digest",
      title: "Congressional Monitor, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 30,
      excerpt:
        "The Congressional Monitor packet covers the prior week in Congress, upcoming primaries, appropriations, committee meetings, conference committee listings, campaign future listings, appropriations status, House and Senate floor action, and the September 16 weekly schedule.",
      evidence:
        "Itemized from Congressional Monitor masthead, page numbers, section headings, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-730am-trip-update-september-14-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 7:30 a.m. trip update, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 1,
      excerpt:
        "A trip-oriented White House News Summary page from San Diego summarizes early campaign and trip coverage before the President's Pacific Northwest stops.",
      evidence:
        "Itemized from the 7:30 a.m. trip update heading and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-230pm-pdt-530pm-edt-september-14-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title: "White House News Summary: 2:30 p.m. PDT / 5:30 p.m. EDT news, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "The afternoon news summary covers Iranian and congressional items, Taiwan fighters, House debate, and other late-day wires.",
      evidence:
        "Itemized from the 2:30 p.m. PDT / 5:30 p.m. EDT White House News Summary heading and continuation page.",
    },
    {
      slug: "caring-for-americas-forests-fact-sheet",
      documentType: "Fact Sheet",
      category: "environment-policy-fact-sheet",
      disposition: "itemized-environment-policy",
      title: "Fact sheet: Caring for America's Forests",
      documentDate: "1992-09-14",
      pages: 3,
      excerpt:
        "The fact sheet summarizes administration forest policy, national forest jobs, reforestation, management of national forests, and a multi-agency forest research initiative.",
      evidence:
        "Itemized from the rotated White House Office of the Press Secretary fact-sheet pages found in rendered-page review.",
    },
    {
      slug: "colville-washington-remarks-september-14-1992",
      documentType: "Presidential Remarks",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title: "Remarks by the President at Colville, Washington, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 6,
      excerpt:
        "The Colville remarks address the spotted owl, timber jobs, the Endangered Species Act, agriculture, and a brief AIDS exchange during the President's Pacific Northwest campaign swing.",
      evidence:
        "Itemized from the Office of the Press Secretary Colville remarks release, numbered pages, and rendered-page review.",
    },
    {
      slug: "commodore-john-barry-day-proclamation",
      documentType: "Presidential Proclamation",
      category: "presidential-proclamation",
      disposition: "itemized-presidential-proclamation",
      title: "Proclamation: Commodore John Barry Day, September 13, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "The White House release transmits President Bush's proclamation honoring Commodore John Barry and inviting Americans to observe the day.",
      evidence:
        "Itemized from the Office of the Press Secretary proclamation release and continuation page found in rendered-page review.",
    },
    {
      slug: "spotted-owl-timber-supply-crisis-press-materials",
      documentType: "Press Release and Fact Sheet Packet",
      category: "environment-policy-fact-sheet",
      disposition: "itemized-environment-policy",
      title: "Spotted owl and timber supply crisis press materials",
      documentDate: "1992-09-14",
      pages: 6,
      excerpt:
        "The packet includes White House press materials on final critical habitat rules, the spotted owl and timber supply crisis, administration responses, litigation chronology, and timber-policy background.",
      evidence:
        "Itemized from Office of the Press Secretary releases, 'The Spotted Owl/Timber Supply Crisis' heading, chronology pages, and rendered-page review.",
    },
    {
      slug: "orange-county-welcome-rally-remarks-september-15-1992",
      documentType: "Presidential Remarks",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title: "Remarks by the President at Orange County Welcome Rally, September 15, 1992",
      documentDate: "1992-09-15",
      pages: 4,
      excerpt:
        "The Orange County rally remarks cover the economy, MIAs, taxes, missile defense, Clinton, and campaign themes for the California stop.",
      evidence:
        "Itemized from the Office of the Press Secretary Anaheim release, numbered remarks pages, and rendered-page review.",
    },
    {
      slug: "pool-report-3-medford-oregon-september-14-1992",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title: "Pool Report #3, Medford, Oregon, September 14, 1992",
      documentDate: "1992-09-14",
      pages: 2,
      excerpt:
        "Two copies of Pool Report #3 describe the C-9 flight to Medford, Marlin Fitzwater's debate comments, press logistics, and the President's timber-country campaign stop.",
      evidence:
        "Itemized from Pool Report #3 headings and duplicate rendered pages found in the NARA direct folder scan.",
    },
    {
      slug: "burrill-lumber-official-remarks-release-copies",
      documentType: "Presidential Remarks Release Packet",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title: "Office of the Press Secretary copies of Burrill Lumber Company remarks",
      documentDate: "1992-09-14",
      pages: 10,
      excerpt:
        "Two official press-release copies of the Burrill Lumber Company remarks restate the President's timber, endangered species, jobs, and Pacific Northwest environmental themes.",
      evidence:
        "Itemized from two Office of the Press Secretary Medford release copies and rendered-page review; distinct from the earlier speech draft already captured by the automated child record.",
    },
    {
      slug: "miami-school-lamar-alexander-education-call-packet",
      documentType: "Recommended Call and Education Memorandum Packet",
      category: "education-policy-correspondence",
      disposition: "itemized-education-policy",
      title: "Miami school recommended call and Lamar Alexander education memorandum packet",
      documentDate: "1992-09-14",
      pages: 8,
      excerpt:
        "The education packet includes recommended telephone-call material, Lamar Alexander memoranda to the President, related White House News Summary clippings, and routing or fax pages concerning a school or education follow-up.",
      evidence:
        "Itemized from recommended-call forms, Department of Education memorandum pages, President Bush handwriting, news-summary clippings, fax page, and rendered-page review.",
    },
    {
      slug: "campaign-debate-family-values-handwriting-notes",
      documentType: "President Bush Handwriting Notes",
      category: "campaign-strategy-notes",
      disposition: "itemized-campaign-strategy-notes",
      title: "President Bush handwriting notes on debates, family values, and campaign themes",
      documentDate: "1992-09-14",
      pages: 6,
      excerpt:
        "The handwritten note pages collect President Bush's points on debates, Congress, education, media corrections, campaign contrasts, and a Churchill quotation.",
      evidence:
        "Itemized from Bush Library handwriting pages and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "los-angeles-times-clippings-september-14-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on free trade, Iraq, Saudi arms, tax policy, abortion, Reagan, family values, and campaign targeting",
      documentDate: "1992-09-14",
      pages: 8,
      excerpt:
        "The Los Angeles Times packet includes clippings on Bush and Clinton's free-trade positions, Saddam Hussein, F-15 sales to Saudi Arabia, Bush's tax policy, Quayle and abortion, Reagan joining Bush at a rally, vice-presidential and family-values commentary, and state targeting.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article starts, handwritten marks, and rendered-page review.",
    },
    {
      slug: "new-york-times-clippings-september-14-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on Gore, cable legislation, Homestead Air Force Base, timber, Clinton, Peru, China trade, Bush attacks, Quayle, debates, and China policy",
      documentDate: "1992-09-14",
      pages: 11,
      excerpt:
        "The New York Times packet covers Al Gore on the trail, cable legislation, Homestead Air Force Base, Bush in timber country, Clinton's lead, Peru, U.S.-China trade tensions, Bush attacks, Quayle on homosexuality, debate pressure, and William Safire on China policy.",
      evidence:
        "Itemized from New York Times mastheads, article starts, and rendered-page review.",
    },
    {
      slug: "washington-times-clippings-september-14-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on Bush in the West, health care, Quayle, federal salaries, legal reform, Israel, IRAs, debates, GOP roots, Thomas, and Cuba",
      documentDate: "1992-09-14",
      pages: 13,
      excerpt:
        "The Washington Times packet includes campaign coverage from the West, health-care articles, Quayle on abortion, federal salaries, legal reform, Israeli jet-sale protests, IRAs, debate commentary, GOP economic roots, Justice Thomas, and Cuban nuclear concerns.",
      evidence:
        "Itemized from Washington Times mastheads, article starts, rotated clipping pages, and rendered-page review.",
    },
    {
      slug: "wall-street-journal-articles-september-14-1992",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on grain aid, Nicaragua, Catholic voters, and the Cold War",
      documentDate: "1992-09-14",
      pages: 4,
      excerpt:
        "The Wall Street Journal packet covers Bush's grain offer, U.S. pressure on Nicaragua to root out Sandinistas, Catholic voters and Reagan Democrats, and Arthur Schlesinger Jr. on who won the Cold War.",
      evidence:
        "Itemized from Wall Street Journal mastheads, article starts, and rendered-page review.",
    },
    {
      slug: "usa-today-budget-deficit-fireworks-clipping",
      documentType: "Press Clipping",
      category: "press-clipping",
      disposition: "itemized-press-clipping",
      title: "USA Today clipping: Bush vows veto fireworks but fires a dud at deficit",
      documentDate: "1992-09-14",
      pages: 1,
      excerpt:
        "A USA Today clipping critiques Bush's budget-deficit and veto politics in the September 14 campaign cycle.",
      evidence:
        "Itemized from the USA Today masthead and article heading found in rendered-page review.",
    },
    {
      slug: "washington-post-clippings-september-14-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Post clippings on Bush constituencies, Detroit, trade, family values, deficit, Kauai, Reagan attacks, federal pay, tort reform, Baker, taxes, and television",
      documentDate: "1992-09-14",
      pages: 14,
      excerpt:
        "The Washington Post packet includes columns and articles on Bush's angry constituency, Detroit and the economy, free trade, family-values politics, IMF deficit criticism, Hurricane Iniki and Kauai, Reagan attacks on Clinton, federal salaries, tort reform, Baker's campaign role, taxes, and television notes.",
      evidence:
        "Itemized from Washington Post mastheads, article starts, rotated clipping pages, and rendered-page review.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-medford-oregon",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages from Medford, Oregon",
      documentDate: "1992-09-14",
      pages: 3,
      excerpt:
        "A final transfer cluster includes color photographs labeled Medford, Oregon, with a backing or transfer page between photo pages.",
      evidence:
        "Itemized from rendered-page review of color photo pages and backing or transfer page at the end of the NARA direct folder scan.",
    },
  ],
  470418060: [
    {
      slug: "cea-economic-briefing-pages-september-15-1992",
      documentType: "Economic Briefing Pages",
      category: "economic-briefing",
      disposition: "itemized-economic-briefing",
      title: "Council of Economic Advisers briefing pages for the President",
      documentDate: "1992-09-15",
      pages: 3,
      excerpt:
        "Council of Economic Advisers pages addressed to the President appear after the initial Utah National Guard speech draft, including chart or briefing material prepared on September 15.",
      evidence:
        "Itemized from Council of Economic Advisers letterhead pages and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "marked-utah-national-guard-remarks-photocopy",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Marked photocopy of presidential remarks to the Utah National Guard",
      documentDate: "1992-09-15",
      pages: 10,
      excerpt:
        "A White House routing page and marked photocopy of the Utah National Guard remarks show President Bush's edits to the Salt Lake City speech on the Guard, defense downsizing, Clinton, and service to country.",
      evidence:
        "Itemized from the 'From the President' routing page, Utah National Guard speech heading, Bush Library handwriting marker, and rendered-page review.",
    },
    {
      slug: "kygo-radio-interview-air-force-one-call-packet",
      documentType: "Radio Interview and Call Briefing Packet",
      category: "media-interview-briefing",
      disposition: "itemized-media-interview-briefing",
      title: "KYGO-FM radio interview and Air Force One call briefing packet",
      documentDate: "1992-09-14",
      pages: 7,
      excerpt:
        "The packet briefs the President for a live KYGO-FM radio interview from Air Force One, with call forms, Church humanitarian-service material, Salt Lake City notes, logistics, and call-in details.",
      evidence:
        "Itemized from the KYGO-FM radio interview cover page, Presidential Phone Calls forms, logistics page, and rendered-page review.",
    },
    {
      slug: "family-and-medical-leave-talking-points-fax",
      documentType: "Talking Points Fax Packet",
      category: "domestic-policy-talking-points",
      disposition: "itemized-domestic-policy-talking-points",
      title: "White House fax packet on family and medical leave talking points",
      documentDate: "1992-09-15",
      pages: 5,
      excerpt:
        "A White House communications fax packet transmits alternative and draft talking points on family and medical leave during the September 15 campaign day.",
      evidence:
        "Itemized from White House COMMCTR fax headers, talking-points headings, and rendered-page review of the direct scan.",
    },
    {
      slug: "severe-mental-illness-health-insurance-packet",
      documentType: "Health Policy Correspondence Packet",
      category: "health-policy-correspondence",
      disposition: "itemized-health-policy-correspondence",
      title:
        "Severe mental illness health-insurance packet with handwritten note",
      documentDate: "1992-09-14",
      pages: 7,
      excerpt:
        "The packet includes a handwritten note, National Alliance for the Mentally Ill petition material, a message to the President, and section-by-section analysis of S. 2696, the Equitable Health Care for Severe Mental Illnesses Act of 1992.",
      evidence:
        "Itemized from the rotated handwritten note, NAMI petition page, S. 2696 analysis, White House seen marker, and rendered-page review.",
    },
    {
      slug: "michael-deland-washington-focus-packet",
      documentType: "Environmental Policy Fax Packet",
      category: "environment-policy-correspondence",
      disposition: "itemized-environment-policy-correspondence",
      title:
        "Michael Deland and Coleman/Bartlett Washington Focus fax packet",
      documentDate: "1992-09-10",
      pages: 2,
      excerpt:
        "Council on Environmental Quality Chairman Michael R. Deland forwards a Coleman/Bartlett Washington Focus item for the President's attention.",
      evidence:
        "Itemized from Council on Environmental Quality letterhead, Deland note markings, Coleman/Bartlett fax page, and rendered-page review.",
    },
    {
      slug: "personal-correspondence-packet-september-15-1992",
      documentType: "Personal Correspondence Packet",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title: "Personal correspondence packet, September 15, 1992",
      documentDate: "1992-09-15",
      pages: 5,
      excerpt:
        "The correspondence packet includes President Bush letters or address pages for Delores and Bob, Ron, Henry Knoche, Elizabeth Hyerstay, and Stuart W. Barr during the Denver travel day.",
      evidence:
        "Itemized from White House letterhead, salutation pages, address pages, handwritten markings, and rendered-page review.",
    },
    {
      slug: "utah-national-guard-large-type-remarks-draft",
      documentType: "Speech Draft",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Large-type draft of presidential remarks to the Utah National Guard",
      documentDate: "1992-09-15",
      pages: 17,
      excerpt:
        "A large-type draft of the Utah National Guard remarks covers Desert Storm, Hurricane Andrew, Guard readiness, defense downsizing, Clinton's draft record, Dan Quayle, presidential responsibility, and command in wartime.",
      evidence:
        "Itemized from the Utah National Guard heading, numbered large-type draft pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-830am-mdt-september-15-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 8:30 a.m. MDT / 10:30 a.m. EDT news, September 15, 1992",
      documentDate: "1992-09-15",
      pages: 1,
      excerpt:
        "The trip news summary page marks the President as having seen the September 15 morning Utah campaign and news update.",
      evidence:
        "Itemized from the White House News Summary heading, President-has-seen marking, and rendered-page review.",
    },
    {
      slug: "national-guard-association-official-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Office of the Press Secretary release of remarks to the National Guard Association",
      documentDate: "1992-09-15",
      pages: 5,
      excerpt:
        "The Englewood press release reproduces the President's remarks to the 114th General Conference of the National Guard Association of the United States.",
      evidence:
        "Itemized from Office of the Press Secretary release pages, numbered remarks continuation pages, and rendered-page review.",
    },
    {
      slug: "national-commission-employment-policy-appointment-release",
      documentType: "Press Release",
      category: "presidential-appointment",
      disposition: "itemized-presidential-appointment",
      title:
        "Press release: appointments to the National Commission for Employment Policy",
      documentDate: "1992-09-15",
      pages: 1,
      excerpt:
        "The White House release announces presidential appointments to the National Commission for Employment Policy.",
      evidence:
        "Itemized from the Office of the Press Secretary Albuquerque release heading and rendered-page review.",
    },
    {
      slug: "intent-to-nominate-release-september-15-1992",
      documentType: "Press Release",
      category: "presidential-nomination",
      disposition: "itemized-presidential-nomination",
      title: "Press release: intent to nominate individuals, September 15, 1992",
      documentDate: "1992-09-15",
      pages: 2,
      excerpt:
        "The White House release announces the President's intention to nominate individuals, including Parker G. Montgomery of New York.",
      evidence:
        "Itemized from Office of the Press Secretary release pages and rendered-page review.",
    },
    {
      slug: "daily-point-of-light-groveport-madison-link",
      documentType: "Daily Point of Light Release",
      category: "daily-point-of-light",
      disposition: "itemized-daily-point-of-light",
      title: "Daily Point of Light release: Groveport Madison LINK",
      documentDate: "1992-09-15",
      pages: 1,
      excerpt:
        "The White House release recognizes Groveport Madison LINK of Groveport, Ohio, as the 893rd Daily Point of Light.",
      evidence:
        "Itemized from the Office of the Press Secretary Englewood release and rendered-page review.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-colorado-rally-salt-lake-city",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title:
        "Official White House photo transfer pages for a Colorado rally and Salt Lake City meeting",
      documentDate: "1992-09-15",
      pages: 4,
      excerpt:
        "A photo-transfer cluster includes a Colorado Republicans for Bush-Quayle rally photograph and a Salt Lake City meeting photograph with official White House photo labels.",
      evidence:
        "Itemized from rendered-page review of color photograph pages, handwritten photo notes, and official White House photo backing labels.",
    },
    {
      slug: "new-york-times-clippings-september-15-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on Bush in the West, Clinton, debates, trade, Israel, and campaign issues",
      documentDate: "1992-09-15",
      pages: 12,
      excerpt:
        "The New York Times packet includes the Campaign Trail column, Bush and loggers in the Far West, Russell Baker, U.S.-Israel talks, Clinton's draft record, debate ultimatums, trade-pact environmental rifts, and other campaign coverage.",
      evidence:
        "Itemized from New York Times mastheads, article headings, dated clipping pages, and rendered-page review.",
    },
    {
      slug: "los-angeles-times-clippings-september-15-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on the South, Michigan, California polling, jobs, environment, morality, and campaign watches",
      documentDate: "1992-09-15",
      pages: 9,
      excerpt:
        "The Los Angeles Times packet covers the South, Michigan voters, California polling, Bush and Clinton on jobs and the environment, religion and morality, and campaign-watch items.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article headings, poll pages, and rendered-page review.",
    },
    {
      slug: "washington-times-clippings-september-15-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on markets, Murphy Brown, the draft issue, CBS, Bob Levey, tort reform, and campaign cartoons",
      documentDate: "1992-09-15",
      pages: 11,
      excerpt:
        "The Washington Times packet includes articles and columns on German rate cuts, Murphy Brown, Bush focusing on Clinton's draft record, CBS protests, Bob Levey, tort reform, a family-affair jail story, and a Bush-Bush debates cartoon.",
      evidence:
        "Itemized from Washington Times mastheads, article starts, rotated clipping pages, cartoon page, and rendered-page review.",
    },
    {
      slug: "washington-post-clippings-september-15-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Post clippings on veto politics, debates, Clinton's draft record, young voters, school choice, managed care, and television",
      documentDate: "1992-09-15",
      pages: 13,
      excerpt:
        "The Washington Post packet includes clippings on Senate veto bait, James Fallows, the debate negotiations, Clinton's draft issue, young voters, school choice, managed care, cable television, and Washington media notes.",
      evidence:
        "Itemized from Washington Post mastheads, article headings, dated clipping pages, and rendered-page review.",
    },
    {
      slug: "oregonian-forest-and-campaign-editorials-september-15-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Oregonian clippings on Northwest forests, campaign issues, and anti-forest hysteria",
      documentDate: "1992-09-15",
      pages: 3,
      excerpt:
        "The Oregonian packet includes editorial and opinion pieces on Northwest forests, campaign issues, spotted owls, timber jobs, and anti-forest-hysteria arguments.",
      evidence:
        "Itemized from Oregonian dated clipping pages, article headings, and rendered-page review.",
    },
    {
      slug: "wall-street-journal-articles-september-15-1992",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on Texas, BNL, environmental costs, and fiscal policy",
      documentDate: "1992-09-15",
      pages: 6,
      excerpt:
        "The Wall Street Journal packet covers Bush's Texas prospects, the BNL scandal, economic-cost tests in environmental law, and budget gaps in Bush and Clinton fiscal plans.",
      evidence:
        "Itemized from Wall Street Journal mastheads, article starts, rotated continuation pages, and rendered-page review.",
    },
    {
      slug: "official-white-house-photo-national-guard-association",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title:
        "Official White House photograph from the National Guard Association remarks",
      documentDate: "1992-09-15",
      pages: 2,
      excerpt:
        "A final photo-transfer item shows the President at the National Guard Association podium with its official White House photograph label.",
      evidence:
        "Itemized from the color photograph page, official White House photo label page, and rendered-page review.",
    },
  ],
  470418070: [
    {
      slug: "charles-bartlett-massager-lincoln-anecdote",
      documentType: "Personal Fax and Note",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title:
        "Personal fax from Charles L. Bartlett to the President re portable massager and Lincoln anecdote",
      documentDate: "",
      pages: 1,
      excerpt:
        "Charles L. Bartlett sends the President a suggestion for a portable massaging instrument and a Lincoln anecdote about 'pegging away' for possible use in speeches.",
      evidence:
        "Itemized from Charles L. Bartlett letterhead and fax text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "caspar-weinberger-reception-message-packet",
      documentType: "Message Note and Invitation",
      category: "social-correspondence-packet",
      disposition: "itemized-social-correspondence",
      title:
        "Message note and Friends of Caspar Weinberger reception invitation packet",
      documentDate: "1992-09-18",
      pages: 5,
      excerpt:
        "A handwritten message notes Mrs. Bush's question about whether the President wanted to send a message for a Friends of Caspar Weinberger party, with faxed invitation and reply-card pages attached.",
      evidence:
        "Itemized from the Mrs. Bush message note, White House fax cover sheet, and Friends of Caspar Weinberger reception pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-hugh-fenwick-millicent-fenwick",
      documentType: "Condolence Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Letter from the President to Hugh Fenwick re Millicent Fenwick",
      documentDate: "1992-09-18",
      pages: 1,
      excerpt:
        "The President and Mrs. Bush send condolences to Hugh Fenwick after the death of Millicent Fenwick, recalling her service in Congress and at the U.N. Food and Agriculture Organization.",
      evidence:
        "Itemized from a presidential condolence letter marked President to sign in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "james-apfelbaum-golf-etiquette-gift",
      documentType: "Gift Correspondence Packet",
      category: "gift-correspondence-packet",
      disposition: "itemized-gift-correspondence",
      title:
        "James W. Apfelbaum Golf Etiquette gift correspondence packet",
      documentDate: "1992-09-18",
      pages: 4,
      excerpt:
        "The packet includes the President's thank-you letter for James W. Apfelbaum's book Golf Etiquette, Anna Matz's forwarding memorandum, and Apfelbaum's incoming letter about the gift.",
      evidence:
        "Itemized from the presidential thank-you letter, Anna Matz memorandum, and Apfelbaum letter found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "gene-dove-branson-correspondence-clipping",
      documentType: "Correspondence and Clipping Packet",
      category: "constituent-correspondence-packet",
      disposition: "itemized-constituent-correspondence",
      title:
        "Gene Dove Baldknobbers Branson visit correspondence and clipping packet",
      documentDate: "1992-09-18",
      pages: 6,
      excerpt:
        "The President thanks Gene Dove of the Baldknobbers show for his letter and Branson newspaper article, with Dove's August 28 letter and Springfield News-Leader clipping attached.",
      evidence:
        "Itemized from the White House letter, Gene Dove letterhead, and Branson clipping pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "harry-whyel-campaign-check-correspondence",
      documentType: "Correspondence and Check Packet",
      category: "campaign-contribution-correspondence",
      disposition: "itemized-campaign-contribution-correspondence",
      title:
        "Harry W. Whyel campaign contribution correspondence and check packet",
      documentDate: "1992-09-14",
      pages: 6,
      excerpt:
        "A staff note says James A. Baker thought the President might like to see Harry W. Whyel's letter; the packet includes Whyel's September 9 letter and four campaign contribution checks.",
      evidence:
        "Itemized from the staff routing note, Whyel letter, and check images found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "kelly-bass-presidential-trust-check-returns",
      documentType: "Contribution Return Letters",
      category: "campaign-contribution-correspondence",
      disposition: "itemized-campaign-contribution-correspondence",
      title:
        "Shirley Green letters returning Dee Kelly and Bass family Presidential Trust checks",
      documentDate: "1992-09-18",
      pages: 3,
      excerpt:
        "Shirley M. Green returns Dee J. Kelly and Bass family checks for the RNC Presidential Trust, citing White House Counsel guidance on political contributions.",
      evidence:
        "Itemized from Shirley M. Green letters and attached check images found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-rudy-boschwitz-bnai-brith",
      documentType: "Thank-You Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Letter from the President to Rudy Boschwitz re B'nai B'rith event introduction",
      documentDate: "1992-09-18",
      pages: 1,
      excerpt:
        "The President thanks Rudy Boschwitz for introducing him at a B'nai B'rith event and for his continued support.",
      evidence:
        "Itemized from a presidential thank-you letter start found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ann-landers-family-leave-exchange",
      documentType: "Correspondence Exchange",
      category: "press-correspondence",
      disposition: "itemized-press-correspondence",
      title:
        "President Bush and Ann Landers correspondence re family leave legislation",
      documentDate: "1992-09-18",
      pages: 3,
      excerpt:
        "The President writes Ann Landers defending his family-leave tax-credit alternative; Landers replies that her syndicated column schedule prevents publication before October 18.",
      evidence:
        "Itemized from the President's September 18 letter, Ann Landers's September 24 reply, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "official-photo-margaret-thatcher-oval-office",
      documentType: "Official White House Photo",
      category: "white-house-photo",
      disposition: "itemized-white-house-photo",
      title:
        "Official White House photo of President Bush with Margaret Thatcher in the Oval Office",
      documentDate: "1992-09-16",
      pages: 2,
      excerpt:
        "A color Official White House photo shows President Bush with Margaret Thatcher in the Oval Office, with a September 16, 1992 White House photo stamp on the reverse.",
      evidence:
        "Itemized from rendered page review of the color photo and Official White House Photo stamp in the NARA direct folder scan.",
    },
    {
      slug: "president-to-hugo-parkman-finback",
      documentType: "Letter with President Bush Handwriting",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Letter from the President to Hugo Parkman re September 2, 1944 and the USS Finback",
      documentDate: "1992-09-18",
      pages: 1,
      excerpt:
        "The President thanks Hugo Parkman for remembering September 2, 1944, recalls the USS Finback rescue, and adds handwritten thanks.",
      evidence:
        "Itemized from a White House letter page with visible President Bush handwriting confirmed by rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "president-to-victor-hancock-support-jo-ann",
      documentType: "Letter",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Letter from the President to Victor J. Hancock re support and Jo Ann",
      documentDate: "1992-09-18",
      pages: 1,
      excerpt:
        "The President thanks Victor J. Hancock for encouragement and support, promises to pass along Hancock's suggestion, and sends prayers for Jo Ann.",
      evidence:
        "Itemized from a presidential letter page found in full-PDF OCR and confirmed by rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "new-york-times-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "New York Times clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 12,
      excerpt:
        "The New York Times clipping run includes coverage of Bush calling Clinton a social engineer, study authors disputing Bush's use of their work, Clinton's draft record, Iran-Contra, cable television, and campaign strategy.",
      evidence:
        "Itemized from The New York Times mastheads and article starts found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "los-angeles-times-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Los Angeles Times clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 3,
      excerpt:
        "The Los Angeles Times clipping run includes Douglas Jehl on Bush attacking Clinton over the draft and economy, plus a Weed and Seed program story.",
      evidence:
        "Itemized from Los Angeles Times byline and clipping starts found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "wall-street-journal-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Wall Street Journal clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 10,
      excerpt:
        "The Wall Street Journal clipping run includes FHA mortgage-rate coverage, a Journal/NBC News poll, the Washington Wire, campaign advertising analysis, and poll-method tables.",
      evidence:
        "Itemized from Wall Street Journal mastheads, poll tables, and article starts found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "washington-times-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Washington Times clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 9,
      excerpt:
        "The Washington Times clipping run covers Clinton attacking Bush's family-leave veto threat, Bush comparing Clinton plans to Soviet socialism, U.N. peacekeeping proposals, Marilyn Quayle, tort lawyers, and vouchers.",
      evidence:
        "Itemized from Washington Times mastheads and article starts found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "usa-today-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "USA Today clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 4,
      excerpt:
        "The USA Today clipping run covers Bush edging closer to Clinton, difficulty holding the 1988 coalition, and voter views of the candidates and issues.",
      evidence:
        "Itemized from USA Today article starts and voter-summary pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "washington-post-clippings-september-18-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Washington Post clipping run: September 18, 1992",
      documentDate: "1992-09-18",
      pages: 18,
      excerpt:
        "The Washington Post clipping run covers gay-rights employment policy, Bush-Clinton defense positions, Clinton draft memos, family leave, Bush's Texas campaign, Rogich advertising, trade, television interviews, and western campaign coverage.",
      evidence:
        "Itemized from Washington Post mastheads, columns, and article starts found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
  470418071: [
    {
      slug: "stanton-ohio-campaign-assistance-initial-packet",
      documentType: "Campaign Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Bill Stanton Ohio campaign-assistance fax packet with President Bush note",
      documentDate: "1992-09-19",
      pages: 3,
      excerpt:
        "President Bush forwards Bill Stanton's fax to James A. Baker III, asking whether Stanton should take leave from the World Bank to help in Ohio, with a follow-up note from Teeter's office and Stanton's handwritten fax.",
      evidence:
        "Itemized from the President's note to JAB III, Teeter-office follow-up note, Stanton fax page, and rendered-page review.",
    },
    {
      slug: "reuters-maastricht-wire-and-marked-imf-insertion",
      documentType: "Wire Story and Speech Draft Page",
      category: "economic-policy-speech-material",
      disposition: "itemized-economic-policy-speech-material",
      title:
        "Reuters Maastricht referendum wire and marked IMF statement insertion page",
      documentDate: "1992-09-20",
      pages: 2,
      excerpt:
        "A Reuters wire reports the French Maastricht Treaty referendum result while a marked IMF statement page adds G-7 economic-coordination language for the President's Sunday remarks.",
      evidence:
        "Itemized from the Reuters NWSID wire page, marked speech page, and rendered-page review of the NARA direct folder scan.",
    },
    {
      slug: "phillip-brady-speech-cards-transmittal",
      documentType: "Staff Transmittal Note",
      category: "speech-material-transmittal",
      disposition: "itemized-speech-material",
      title:
        "Phillip D. Brady note transmitting September 20 speech cards",
      documentDate: "1992-09-19",
      pages: 1,
      excerpt:
        "Phillip D. Brady tells the President that speech cards for Sunday, September 20 will be at the residence upon his return.",
      evidence:
        "Itemized from the White House note by Phillip D. Brady and rendered-page review.",
    },
    {
      slug: "imf-statement-speech-cards-drafts",
      documentType: "Speech Drafts",
      category: "economic-policy-speech-material",
      disposition: "itemized-economic-policy-speech-material",
      title:
        "IMF statement speech-card drafts for September 20, 1992",
      documentDate: "1992-09-20",
      pages: 9,
      excerpt:
        "Two speech-card drafts of the IMF statement address European financial-market turmoil, the Maastricht vote, European integration, G-7 coordination, commodity indicators, growth, and post-Cold War economic architecture.",
      evidence:
        "Itemized from the IMF Statement headings, numbered speech-card pages, handwritten edits, and rendered-page review.",
    },
    {
      slug: "tailhook-edwards-letter-packet",
      documentType: "Staff Note and Incoming Letter",
      category: "defense-correspondence",
      disposition: "itemized-defense-correspondence",
      title:
        "President Bush note to Brent Scowcroft re Tailhook and Grogan Edwards letter",
      documentDate: "1992-09-19",
      pages: 2,
      excerpt:
        "President Bush asks Brent Scowcroft to get Dick Cheney's update on Tailhook and notes a comment about Lt. Coughlin in Grogan Edwards's letter.",
      evidence:
        "Itemized from the President's note to Brent Scowcroft, New York Life inter-office memo from Grogan Edwards, Bush handwriting marker, and rendered-page review.",
    },
    {
      slug: "camp-david-campaign-filming-schedule-script",
      documentType: "Schedule and Campaign Script Packet",
      category: "campaign-media-production",
      disposition: "itemized-campaign-media-production",
      title:
        "Camp David campaign filming schedule and Plan Courts television script",
      documentDate: "1992-09-19",
      pages: 3,
      excerpt:
        "The packet includes the President's Saturday Camp David schedule, a proposed campaign filming schedule with the First Family, and a revised Plan Courts television ad script.",
      evidence:
        "Itemized from the Saturday schedule page, proposed campaign filming schedule, Plan Courts script page, and rendered-page review.",
    },
    {
      slug: "betty-walker-support-letter",
      documentType: "Incoming Correspondence",
      category: "constituent-correspondence",
      disposition: "itemized-constituent-correspondence",
      title: "Betty Walker letter to President Bush re Arkansas support",
      documentDate: "1992-09-12",
      pages: 2,
      excerpt:
        "Betty Walker writes from Springdale, Arkansas, encouraging the President and describing local support, bumper-sticker calls, and television coverage.",
      evidence:
        "Itemized from the White House routing/address page, Betty Walker letter, handwritten markings, and rendered-page review.",
    },
    {
      slug: "president-note-to-mat-re-election-support",
      documentType: "Presidential Correspondence Drafts",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush note drafts to Mat thanking him for re-election support",
      documentDate: "1992-09-19",
      pages: 2,
      excerpt:
        "Two versions of a President Bush note thank Mat for distinguished service and enthusiastic re-election support.",
      evidence:
        "Itemized from the President's note pages, George Bush handwriting marker, and rendered-page review.",
    },
    {
      slug: "frederick-reeder-macarthur-vietnam-letter-photo",
      documentType: "Incoming Correspondence and Photograph",
      category: "defense-correspondence",
      disposition: "itemized-defense-correspondence",
      title:
        "Rear Admiral Frederick Reeder letter on MacArthur, Vietnam, and presidential command",
      documentDate: "1992-09-15",
      pages: 3,
      excerpt:
        "Rear Admiral Frederick M. Reeder writes through Don Rhodes about General Douglas MacArthur, President Johnson, Vietnam, and command decisions, with an attached photograph and handwritten note.",
      evidence:
        "Itemized from the Reeder address page, attached photograph page, Reeder letter, handwriting, and rendered-page review.",
    },
    {
      slug: "stanton-ohio-campaign-assistance-copy-packet",
      documentType: "Campaign Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Bill Stanton Ohio campaign-assistance routing copy packet",
      documentDate: "1992-09-19",
      pages: 5,
      excerpt:
        "A second routing copy of the Stanton Ohio campaign-assistance material includes the President's note to JAB III, a World Bank address page, Stanton's handwritten fax, and a Bush Library handwriting photocopy.",
      evidence:
        "Itemized from the duplicate Stanton routing pages, address page, handwritten fax, Bush handwriting marker, and rendered-page review.",
    },
    {
      slug: "press-clippings-women-education-family-california-higher-ed",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Press clippings on women voters, education, family research, and California higher education",
      documentDate: "1992-09-21",
      pages: 8,
      excerpt:
        "The clipping packet includes New York Post coverage of Bush courting women voters, Wall Street Journal and Washington Post education pieces, family-structure research, and California higher-education budget coverage.",
      evidence:
        "Itemized from newspaper mastheads, article starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "mrs-bush-daily-press-clippings-september-19-21-1992",
      documentType: "Daily Press Clippings",
      category: "first-lady-press-clippings",
      disposition: "itemized-first-lady-press-clippings",
      title:
        "Mrs. Bush's Press Office daily press clippings, September 19-21, 1992",
      documentDate: "1992-09-21",
      pages: 13,
      excerpt:
        "The Mrs. Bush clipping packet covers Barbara Bush appearances in Port Charlotte, Sarasota, Lexington, and Barberton, including literacy, campaign, and local press coverage.",
      evidence:
        "Itemized from the Mrs. Bush's Press Office Daily Press Clippings cover sheet, local newspaper mastheads, photo captions, and rendered-page review.",
    },
    {
      slug: "new-york-times-family-values-tone-clippings-september-20-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on Bush campaign family-values tone",
      documentDate: "1992-09-20",
      pages: 2,
      excerpt:
        "The New York Times clippings report on Bush efforts to recoup from the harsh tone of family-values politics after the Republican convention.",
      evidence:
        "Itemized from New York Times article pages, continuation heading, and rendered-page review.",
    },
    {
      slug: "associated-press-california-campaign-wire-september-20-1992",
      documentType: "Wire Story",
      category: "campaign-wire-story",
      disposition: "itemized-wire-story",
      title:
        "Associated Press wire: Bush trails, but can't write off California",
      documentDate: "1992-09-20",
      pages: 1,
      excerpt:
        "The AP wire reports on Bush's large polling deficit in California, Jeb Bush's argument that the campaign had not yet fully engaged there, and the state's electoral stakes.",
      evidence:
        "Itemized from the Associated Press dateline, timestamped wire page, and rendered-page review.",
    },
    {
      slug: "on-the-road-with-candidates-magazine-feature",
      documentType: "Magazine Feature",
      category: "campaign-magazine-feature",
      disposition: "itemized-campaign-magazine-feature",
      title:
        "Magazine feature: On the Road with the Candidates",
      documentDate: "",
      pages: 9,
      excerpt:
        "The magazine feature profiles George Bush, Bill Clinton, Dan Quayle, Al Gore, Barbara Bush, Hillary Clinton, campaign travel, and the role of candidates' spouses.",
      evidence:
        "Itemized from the 'On the Road with the Candidates' feature pages, candidate profile spreads, spouse profile pages, and rendered-page review.",
    },
    {
      slug: "time-washington-post-new-york-post-bush-family-items",
      documentType: "Press and Magazine Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "TIME, Washington Post, and New York Post items on the Bush family and Barbara Bush",
      documentDate: "1992-09-28",
      pages: 5,
      excerpt:
        "The packet includes TIME Grapevine items, Washington Fax, Washington Post discussion of Barbara Bush and family values, and a New York Post item on criticism of Barbara Bush's family image.",
      evidence:
        "Itemized from TIME mastheads, Washington Post and New York Post clipping pages, article starts, and rendered-page review.",
    },
    {
      slug: "admiral-william-crowe-correspondence-nuclear-weapons-packet",
      documentType: "Correspondence Packet",
      category: "defense-correspondence",
      disposition: "itemized-defense-correspondence",
      title:
        "Admiral William J. Crowe correspondence packet on nuclear weapons and Gulf War letters",
      documentDate: "1991-10-03",
      pages: 12,
      excerpt:
        "The Crowe packet includes a routing note, address page, Admiral Crowe's October 1991 letter, earlier Bush-Crowe Gulf War correspondence, tracking worksheet, and draft presidential response on nuclear-weapons reductions.",
      evidence:
        "Itemized from the Crowe address page, incoming and outgoing correspondence, tracking worksheet, draft response pages, handwriting, and rendered-page review.",
    },
    {
      slug: "stanton-ohio-campaign-assistance-tail-copy",
      documentType: "Campaign Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Bill Stanton Ohio campaign-assistance tail copy with Teeter-office follow-up",
      documentDate: "1992-09-19",
      pages: 5,
      excerpt:
        "A final copy of the Stanton material includes the President's note, World Bank address page, Stanton's fax, and an October 2 JAB follow-up note reporting Bob Bennett's Ohio campaign plans for Stanton.",
      evidence:
        "Itemized from the repeated Stanton pages, October 2 JAB follow-up note, handwriting, and rendered-page review.",
    },
    {
      slug: "frederick-reeder-camp-david-photo-transfer-pages",
      documentType: "Photo Transfer Packet",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title:
        "Rear Admiral Frederick Reeder address page and Camp David photo transfer pages",
      documentDate: "1992-09-19",
      pages: 5,
      excerpt:
        "The closing packet includes a Reeder address page and Camp David photographs with official White House photo label pages.",
      evidence:
        "Itemized from the Reeder address page, color Camp David photographs, official White House photo labels, and rendered-page review.",
    },
  ],
  470418075: [
    {
      slug: "conference-presidents-closed-meeting-clinton-fax",
      documentType: "Faxed Memorandum",
      category: "campaign-outreach-correspondence",
      disposition: "itemized-campaign-outreach-correspondence",
      title:
        "Conference of Presidents fax re closed meeting with Governor Clinton",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "A Jacob Stein fax transmits a Conference of Presidents of Major American Jewish Organizations memorandum from Shoshana S. Cardin and Malcolm Hoenlein about a closed meeting with Governor Clinton.",
      evidence:
        "Itemized from the Jacob Stein fax transmittal, Conference of Presidents memorandum heading, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-3pm-wires-september-21-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 3:00 p.m. wires, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 5,
      excerpt:
        "The 3:00 p.m. wire summary covers Bush on the French Maastricht vote, Cuba and the U.S. trade embargo, an Ohio poll, and Clinton transition planning.",
      evidence:
        "Itemized from the 3:00 p.m. White House News Summary heading, wire-story starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-4pm-wires-september-21-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 4:00 p.m. wires, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 6,
      excerpt:
        "The 4:00 p.m. wires include AP and Reuters stories on Bush challenging Clinton over the draft, Taiwan arms sales, Bush's gold-commodity currency plan, and an Indiana poll on Gore and Quayle.",
      evidence:
        "Itemized from the 4:00 p.m. White House News Summary wire heading, article starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-4pm-news-update-september-21-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 4:00 p.m. news update, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "The 4:00 p.m. news update summarizes the Clinton draft issue and the President's reaction to the Maastricht vote.",
      evidence:
        "Itemized from the White House News Summary update heading, numbered pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-5pm-wires-september-21-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 5:00 p.m. wires, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 11,
      excerpt:
        "The 5:00 p.m. wires cover Clinton on debates, Bush challenging Clinton's draft status, U.N. peacekeeping, Sudan, anti-Bush sentiment, IMF interest-rate policy, and Israel-Syria peace talks.",
      evidence:
        "Itemized from the 5:00 p.m. White House News Summary heading, Reuters and AP story starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-6pm-wires-september-21-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 6:00 p.m. wires, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 10,
      excerpt:
        "The 6:00 p.m. wires cover government gridlock, Clinton's business endorsement and economy message, draft-record exchanges, Quayle's Murphy Brown baby letter, Treasury Secretary Brady's bank lending discussion, and U.S. reaction to the French vote.",
      evidence:
        "Itemized from the 6:00 p.m. White House News Summary heading, wire-story starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "ed-lawson-oklahoma-campaign-finance-volunteer-packet",
      documentType: "Campaign Correspondence and Volunteer List Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Ed Lawson Oklahoma campaign finance and volunteer-list fax packet",
      documentDate: "1992-09-18",
      pages: 13,
      excerpt:
        "The Lawson packet includes Rose Zamaria routing notes, Ed Lawson's letter about Oklahoma campaign finance and the Tulsa Daily World endorsement, and faxed volunteer address and phone lists.",
      evidence:
        "Itemized from Zamaria notes, Lawson fax headers, cover sheet, highlighted incoming letter, volunteer-list pages, and rendered-page review.",
    },
    {
      slug: "alice-langtry-presidential-letter-packet",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "President Bush letter packet to Alice S. Langtry",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "The packet includes a White House fax transmittal, President Bush's letter to Alice S. Langtry, and Langtry's incoming handwritten note.",
      evidence:
        "Itemized from White House facsimile transmittal, presidential letter page, Langtry note, and rendered-page review.",
    },
    {
      slug: "presidential-letters-bergmann-kopp-roy",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "President Bush correspondence with Horst Bergmann, Gerald Kopp, and Emile Roy",
      documentDate: "1992-09-21",
      pages: 4,
      excerpt:
        "The correspondence packet includes President Bush letters or routing pages for Horst A. Bergmann, Gerald Kopp, and Emile J. Roy, plus Roy's September 14 letter sending convention clippings.",
      evidence:
        "Itemized from presidential correspondence pages, address pages, Roy letter, and rendered-page review.",
    },
    {
      slug: "emile-roy-republican-convention-clippings-packet",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Emile Roy Republican convention clippings packet",
      documentDate: "1992-08-19",
      pages: 7,
      excerpt:
        "The clippings sent by Emile Roy cover his role as President Bush's barber, Maine delegates, Republican convention coverage, Log Cabin Club items, and convention snapshots.",
      evidence:
        "Itemized from York County Coast Star, Portland Press Herald, Congressional Quarterly, and AP Shots clipping pages in rendered-page review.",
    },
    {
      slug: "debates-and-draft-issue-talking-points-fax",
      documentType: "Talking Points Fax Packet",
      category: "campaign-talking-points",
      disposition: "itemized-campaign-talking-points",
      title: "White House faxed points on debates and the draft issue",
      documentDate: "1992-09-21",
      pages: 3,
      excerpt:
        "A White House communications fax transmits suggested points for discussing presidential debates and the Clinton draft issue.",
      evidence:
        "Itemized from White House communications fax headers, debate/draft talking-points text, and rendered-page review.",
    },
    {
      slug: "un-general-assembly-remarks-release-september-21-1992",
      documentType: "Presidential Remarks Release",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Office of the Press Secretary release of President Bush's United Nations General Assembly address",
      documentDate: "1992-09-21",
      pages: 7,
      excerpt:
        "The New York press release reproduces President Bush's address to the United Nations General Assembly on post-Cold War peacekeeping, proliferation, development, markets, and global community.",
      evidence:
        "Itemized from Office of the Press Secretary release pages, numbered remarks continuation pages, and rendered-page review.",
    },
    {
      slug: "oas-headquarters-agreement-senate-transmittal",
      documentType: "Presidential Message",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title:
        "Message to the Senate transmitting the OAS Headquarters Agreement",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "President Bush transmits the Headquarters Agreement between the United States and the Organization of American States to the Senate for advice and consent.",
      evidence:
        "Itemized from Office of the Press Secretary release pages, Senate transmittal heading, signature page, and rendered-page review.",
    },
    {
      slug: "daily-point-of-light-southern-mutual-help-association",
      documentType: "Daily Point of Light Release",
      category: "daily-point-of-light",
      disposition: "itemized-daily-point-of-light",
      title:
        "Daily Point of Light release: Southern Mutual Help Association",
      documentDate: "1992-09-21",
      pages: 1,
      excerpt:
        "The White House release recognizes the volunteers of Southern Mutual Help Association of New Iberia, Louisiana, as the 899th Daily Point of Light.",
      evidence:
        "Itemized from the Office of the Press Secretary New York City release and rendered-page review.",
    },
    {
      slug: "presidential-appointments-nominations-releases-september-21-1992",
      documentType: "Press Release Packet",
      category: "presidential-appointment",
      disposition: "itemized-presidential-appointment",
      title:
        "Presidential appointments and nominations releases, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 9,
      excerpt:
        "The release packet covers Charles R. Hilty's designation, Robert L. Hutchings's personal rank of Ambassador, and intended nominations including Charles F. Little, Mark Johnson, Robert Gregory Joseph, Blaine B. Goff, Mark McCampbell Collins Jr., and Marshall Fletcher McCallie.",
      evidence:
        "Itemized from Office of the Press Secretary release headings, nominee biographies, and rendered-page review.",
    },
    {
      slug: "president-to-robert-allen-att-letter",
      documentType: "Presidential Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Letter from President Bush to Robert E. Allen of AT&T",
      documentDate: "1992-09-21",
      pages: 1,
      excerpt:
        "President Bush writes to AT&T chairman and chief executive officer Robert E. Allen.",
      evidence:
        "Itemized from the White House letter page addressed to Robert E. Allen and rendered-page review.",
    },
    {
      slug: "tim-russert-letter-president-has-seen",
      documentType: "Incoming Correspondence",
      category: "media-correspondence",
      disposition: "itemized-media-correspondence",
      title: "Tim Russert letter marked President has seen",
      documentDate: "1992-08-21",
      pages: 1,
      excerpt:
        "A letter from Tim Russert at NBC News is marked as seen by the President on September 21.",
      evidence:
        "Itemized from NBC News letterhead, President-has-seen marking, yellow note, and rendered-page review.",
    },
    {
      slug: "los-angeles-times-clippings-september-21-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Los Angeles Times clippings on historical analogies, Perot, Quayle, Clinton, and Colorado",
      documentDate: "1992-09-21",
      pages: 6,
      excerpt:
        "The Los Angeles Times packet includes clippings on past leaders in campaigns, Clinton campaign advertising, Quayle and the Guard, Clinton courting Democrats in Michigan, and the GOP grip on Colorado.",
      evidence:
        "Itemized from Los Angeles Times mastheads, article starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "new-york-times-clippings-september-21-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "New York Times clippings on family values, the campaign trail, Murphy Brown, George Bush, and brawling campaigns",
      documentDate: "1992-09-21",
      pages: 6,
      excerpt:
        "The New York Times packet covers Bush recouping from family-values rhetoric, Herbert Stein on the campaign trail, Quayle and Murphy Brown, Anthony Lewis on George Bush, and a day of brawling for the presidential campaigns.",
      evidence:
        "Itemized from New York Times mastheads, article starts, and rendered-page review.",
    },
    {
      slug: "washington-post-clippings-september-21-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Post clippings on the economy, debates, Quayle, campaign control rooms, Clinton attacks, tax bills, jobs, currency markets, and television",
      documentDate: "1992-09-21",
      pages: 15,
      excerpt:
        "The Washington Post clipping run includes Jack Anderson and Michael Binstein on economic spin, Jane Applegate, Lois Romano, Meg Greenfield on debates, Quayle and the Guard, campaign nerve centers, Clinton economic attacks, tax and jobs editorials, currency-market coverage, and television notes.",
      evidence:
        "Itemized from Washington Post mastheads, article starts, rotated clipping page, continuation pages, and rendered-page review.",
    },
    {
      slug: "washington-times-clippings-september-21-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title:
        "Washington Times clippings on Quayle, Hollywood, Admiral Crowe, politics, defense, and poll gaps",
      documentDate: "1992-09-21",
      pages: 9,
      excerpt:
        "The Washington Times clipping run covers Quayle and the Guard issue, Hollywood, Admiral Crowe's Clinton endorsement, cross-networking, Morton Kondracke, defense spending, military strength, and historical poll gaps.",
      evidence:
        "Itemized from Washington Times mastheads, article starts, cartoon page, rotated clipping pages, and rendered-page review.",
    },
    {
      slug: "usa-today-political-cartoon-september-21-1992",
      documentType: "Political Cartoon",
      category: "political-cartoon",
      disposition: "itemized-political-cartoon",
      title: "USA Today political cartoon, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 1,
      excerpt:
        "A USA Today cartoon page appears in the September 21 clipping packet.",
      evidence:
        "Itemized from the USA Today page marker and rendered-page review.",
    },
    {
      slug: "wall-street-journal-clippings-september-21-1992",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal articles on Oregon family values, voters, Murphy Brown, Clinton, Congress, and Bush's presidency",
      documentDate: "1992-09-21",
      pages: 7,
      excerpt:
        "The Wall Street Journal packet covers Oregon family-values politics, voter-age participation, Murphy Brown, the battle for a President Clinton, congressional adjournment, and assessments of Bush's reshaping of the presidency.",
      evidence:
        "Itemized from Wall Street Journal mastheads, article starts, continuation pages, and rendered-page review.",
    },
    {
      slug: "schedule-of-president-september-21-1992",
      documentType: "Schedule of the President",
      category: "presidential-schedule",
      disposition: "itemized-presidential-schedule",
      title: "Schedule of the President, Monday, September 21, 1992",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "The President's schedule covers a video taping session, travel to New York, meetings around the United Nations, the Rush Limbaugh radio interview, and return to Washington.",
      evidence:
        "Itemized from the Schedule of the President pages, handwritten timing notes, and rendered-page review.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-un-rush-limbaugh",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title:
        "Official White House photo transfer pages from United Nations and Rush Limbaugh events",
      documentDate: "1992-09-21",
      pages: 7,
      excerpt:
        "The photo-transfer packet includes color photographs and official White House photo labels from the President's September 21 Rush Limbaugh interview and United Nations visit.",
      evidence:
        "Itemized from rendered-page review of the color photo pages, United Nations and Rush Limbaugh photo subjects, and official White House photo label pages.",
    },
  ],
  470418078: [
    {
      slug: "springfield-service-organizations-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Office of the Press Secretary release of remarks to Springfield service organizations",
      documentDate: "1992-09-22",
      pages: 8,
      excerpt:
        "The Springfield release reproduces President Bush's remarks to service organizations on the economy, taxes, crime, child welfare, the environment, health care, and Clinton's Arkansas record.",
      evidence:
        "Itemized from Office of the Press Secretary Springfield release pages, remarks heading, numbered continuation pages, and rendered-page review.",
    },
    {
      slug: "tulsa-airport-welcome-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Office of the Press Secretary release of remarks at Tulsa Airport welcome",
      documentDate: "1992-09-22",
      pages: 3,
      excerpt:
        "The Tulsa Airport welcome remarks address energy, small business, schools, civil rights, quotas, and the campaign comparison with Governor Clinton.",
      evidence:
        "Itemized from Office of the Press Secretary Tulsa release pages, remarks heading, continuation pages, and rendered-page review.",
    },
    {
      slug: "longview-texas-citizens-remarks-release",
      documentType: "Presidential Remarks Release",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Office of the Press Secretary release of remarks to citizens in Longview, Texas",
      documentDate: "1992-09-22",
      pages: 4,
      excerpt:
        "The Longview remarks cover domestic oil, small business, health care, Clinton's health plan, Bush's World War II service, and the campaign's honor-and-decency themes.",
      evidence:
        "Itemized from Office of the Press Secretary Longview release pages, remarks heading, continuation pages, and rendered-page review.",
    },
    {
      slug: "daily-point-of-light-suellen-fried",
      documentType: "Daily Point of Light Release",
      category: "daily-point-of-light",
      disposition: "itemized-daily-point-of-light",
      title: "Daily Point of Light release: SuEllen Fried",
      documentDate: "1992-09-22",
      pages: 1,
      excerpt:
        "The White House release recognizes SuEllen Fried of Prairie Village, Kansas, as the 900th Daily Point of Light for her work on domestic violence, child abuse, and prisoner rehabilitation.",
      evidence:
        "Itemized from the Office of the Press Secretary Springfield release and rendered-page review.",
    },
    {
      slug: "bradley-holmes-itu-delegation-release",
      documentType: "Press Release",
      category: "presidential-delegation",
      disposition: "itemized-presidential-delegation",
      title:
        "Press release: Ambassador Bradley P. Holmes selected to head U.S. delegation to the ITU conference",
      documentDate: "1992-09-22",
      pages: 1,
      excerpt:
        "The White House release announces Ambassador Bradley P. Holmes as head of the U.S. delegation to the International Telecommunications Union Conference.",
      evidence:
        "Itemized from the Office of the Press Secretary Shreveport release and rendered-page review.",
    },
    {
      slug: "peace-corps-national-advisory-council-nominations-release",
      documentType: "Press Release",
      category: "presidential-nomination",
      disposition: "itemized-presidential-nomination",
      title:
        "Press release: nominations to the Peace Corps National Advisory Council",
      documentDate: "1992-09-22",
      pages: 1,
      excerpt:
        "The White House release announces President Bush's nominations of individuals to the Peace Corps National Advisory Council, including Frank B. Hower Jr.",
      evidence:
        "Itemized from the Office of the Press Secretary Springfield release and rendered-page review.",
    },
    {
      slug: "holly-coors-american-woman-congress-special-representative-release",
      documentType: "Press Release",
      category: "presidential-appointment",
      disposition: "itemized-presidential-appointment",
      title:
        "Press release: Ambassador Holly Coors as special representative to the Congress of the American Woman",
      documentDate: "1992-09-22",
      pages: 1,
      excerpt:
        "The White House release announces President Bush's intention to nominate Ambassador Holly Coors as his special representative to the Congress of the American Woman in the Dominican Republic.",
      evidence:
        "Itemized from the Office of the Press Secretary Shreveport release and rendered-page review.",
    },
    {
      slug: "pool-reports-springfield-greenville-memphis-september-22-1992",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title:
        "Pool reports from Air Force One, Springfield, Greenville, and Memphis",
      documentDate: "1992-09-22",
      pages: 2,
      excerpt:
        "Pool Report #1 describes the Air Force One flight to Springfield, Missouri, while Pool Report #2 covers Greenville-to-Memphis campaign-trail developments and Baker's contact with Ross Perot.",
      evidence:
        "Itemized from Pool Report #1 and Pool Report #2 headings and rendered-page review.",
    },
    {
      slug: "brady-schlesinger-g7-commodity-indicator-packet",
      documentType: "President Bush Handwriting and Wire Story Packet",
      category: "economic-policy-correspondence",
      disposition: "itemized-economic-policy-correspondence",
      title:
        "President Bush note to Nicholas Brady with Reuters story on Schlesinger and the G-7 commodity indicator",
      documentDate: "1992-09-22",
      pages: 4,
      excerpt:
        "President Bush sends Nicholas Brady comments on German reaction to the commodity-indicator idea, with an attached Reuters story on Bundesbank president Helmut Schlesinger's criticism.",
      evidence:
        "Itemized from Bush handwriting photocopy pages, the President's note to Nicholas Brady, Reuters story page, and rendered-page review.",
    },
    {
      slug: "joseph-hagin-east-texas-humor-correspondence-packet",
      documentType: "President Bush Handwriting and Correspondence Packet",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title:
        "President Bush correspondence with Joseph W. Hagin II and East Texas humor attachment",
      documentDate: "1992-09-22",
      pages: 4,
      excerpt:
        "The packet includes President Bush handwriting to Joseph W. Hagin II, Hagin's handwritten reply, and a humorous 'native of East Texas' attachment.",
      evidence:
        "Itemized from White House address page, Bush Library handwriting photocopy pages, Hagin handwritten letter, humor attachment, and rendered-page review.",
    },
    {
      slug: "rosey-grier-phone-message",
      documentType: "Phone Message",
      category: "telephone-message",
      disposition: "itemized-telephone-message",
      title: "Rosey Grier phone message for the President",
      documentDate: "1992-09-22",
      pages: 2,
      excerpt:
        "Two copies of a phone message report Rosey Grier's advice that the President focus on experience and leadership during changing times.",
      evidence:
        "Itemized from duplicate 'Phone Call for the President' pages and rendered-page review.",
    },
    {
      slug: "abraham-foxman-bnai-brith-letter",
      documentType: "Incoming Letter with President Bush Handwriting",
      category: "incoming-correspondence",
      disposition: "itemized-incoming-correspondence",
      title:
        "Abraham H. Foxman letter thanking President Bush for B'nai B'rith convention remarks",
      documentDate: "1992-09-10",
      pages: 2,
      excerpt:
        "Abraham H. Foxman of the Anti-Defamation League thanks President Bush for his B'nai B'rith convention remarks, with President Bush handwriting and a file-bill routing page.",
      evidence:
        "Itemized from Anti-Defamation League letterhead, President-has-seen marking, President Bush handwriting, routing page, and rendered-page review.",
    },
    {
      slug: "alvah-chapman-knight-ridder-letter",
      documentType: "Incoming Letter with President Bush Handwriting",
      category: "incoming-correspondence",
      disposition: "itemized-incoming-correspondence",
      title:
        "Alvah H. Chapman Jr. letter to President Bush with handwriting response",
      documentDate: "1992-09-08",
      pages: 2,
      excerpt:
        "Knight-Ridder's Alvah H. Chapman Jr. writes to President Bush, with President Bush handwriting noting thanks and comments on campaign momentum.",
      evidence:
        "Itemized from Knight-Ridder letterhead, President-has-seen marking, President Bush handwriting, and rendered-page review.",
    },
    {
      slug: "burton-lee-personal-memorandum",
      documentType: "Personal Memorandum",
      category: "staff-correspondence",
      disposition: "itemized-staff-correspondence",
      title: "Dr. Burton Lee personal memorandum to the President",
      documentDate: "1992-09-21",
      pages: 2,
      excerpt:
        "Dr. Burton Lee sends the President a personal memorandum explaining a leg-muscle injury and his temporary inability to travel fully with the campaign.",
      evidence:
        "Itemized from two copies of the Dr. Burton Lee memorandum and rendered-page review.",
    },
    {
      slug: "congressional-birthday-letter-packet-october-1992",
      documentType: "Presidential Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title:
        "Congressional birthday letter packet for October 1992",
      documentDate: "1992-09-21",
      pages: 6,
      excerpt:
        "The packet includes President Bush birthday letters or drafts for members of Congress, including Jesse Helms and Gus Savage, plus a Nicholas Calio memorandum listing October congressional birthdays.",
      evidence:
        "Itemized from presidential birthday letter pages, Bush handwriting photocopy/routing pages, Nicholas Calio memorandum pages, and rendered-page review.",
    },
    {
      slug: "air-force-one-phone-call-forms-first-set-september-22-1992",
      documentType: "Presidential Phone Call Forms",
      category: "telephone-call-forms",
      disposition: "itemized-telephone-call-forms",
      title:
        "Air Force One presidential phone call forms, September 22, 1992, first set",
      documentDate: "1992-09-22",
      pages: 2,
      excerpt:
        "Two Air Force One presidential phone call forms record September 22 call notes and follow-up handwriting during the campaign travel day.",
      evidence:
        "Itemized from Presidential Phone Calls forms, handwriting, and rendered-page review.",
    },
    {
      slug: "springfield-clinton-record-large-type-speech-draft",
      documentType: "Speech Draft with President Bush Handwriting",
      category: "speech-material",
      disposition: "itemized-speech-material",
      title:
        "Large-type Springfield speech draft on Bill Clinton's Arkansas record",
      documentDate: "1992-09-22",
      pages: 22,
      excerpt:
        "The large-type draft develops President Bush's attack on Clinton's Arkansas record, covering civil rights, taxes, crime, child welfare, education, the environment, health care, and Clinton-Gore promises.",
      evidence:
        "Itemized from the Tuesday Springfield speech heading, large-type numbered pages, Bush Library handwriting marker, insert pages, and rendered-page review.",
    },
    {
      slug: "air-force-one-phone-call-forms-second-set-september-22-1992",
      documentType: "Presidential Phone Call Forms",
      category: "telephone-call-forms",
      disposition: "itemized-telephone-call-forms",
      title:
        "Air Force One presidential phone call forms, September 22, 1992, second set",
      documentDate: "1992-09-22",
      pages: 2,
      excerpt:
        "A second pair of Air Force One presidential phone call forms appears after the Springfield speech draft, with call notes and handwriting.",
      evidence:
        "Itemized from Presidential Phone Calls forms, handwriting, and rendered-page review.",
    },
    {
      slug: "materials-forwarded-to-president-september-22-1992",
      documentType: "Materials Forwarded List",
      category: "materials-forwarded-list",
      disposition: "itemized-materials-forwarded-list",
      title:
        "Materials forwarded to the President, September 22, 1992",
      documentDate: "1992-09-22",
      pages: 2,
      excerpt:
        "The materials-forwarded list records action items including Norway Title VII material, correspondence, a Victory '92 fundraiser letter, veto-message material, a tripbook, and a Goldline schedule.",
      evidence:
        "Itemized from 'Materials Forwarded to the President' action and schedule pages and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-6am-edition-september-22-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 6:00 a.m. EDT edition, September 22, 1992",
      documentDate: "1992-09-22",
      pages: 24,
      excerpt:
        "The morning News Summary covers trip news, Bush on Clinton's draft record, U.N. peacekeeping, foreign-affairs agency overhaul, polling, television coverage, Vietnam veterans, Clinton and business leaders, Quayle in Kentucky, fundraising, Europe, Israel, Nicaragua, network news, editorials, and debates.",
      evidence:
        "Itemized from the Office of the Press Secretary News Summary cover page, A/B/C section headings, page numbers, and rendered-page review.",
    },
  ],
  470418083: [
    {
      slug: "ray-price-penn-state-correspondence-speech-attachment",
      documentType: "Presidential Correspondence and Speech Attachment",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "President Bush correspondence with Raymond K. Price Jr. re Penn State with Economic Club speech attachment",
      documentDate: "1992-09-24",
      pages: 12,
      excerpt:
        "The packet includes President Bush's September 24 note to Ray Price, Price's September 21 Penn State memo, and attached large-type Economic Club speech pages on Clinton, the economy, taxes, and growth.",
      evidence:
        "Itemized from pages 2-13 of the NARA direct folder scan using presidential letterhead, the Ray Price memo heading, Economic Club fax pages, OCR, and rendered-page review.",
    },
    {
      slug: "frederick-vreeland-morocco-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "diplomatic-correspondence",
      disposition: "itemized-diplomatic-correspondence",
      title:
        "President Bush correspondence with Ambassador Frederick Vreeland re Morocco",
      documentDate: "1992-09-24",
      pages: 2,
      excerpt:
        "President Bush writes to Ambassador Frederick Vreeland at the American Embassy in Rabat, thanking him for words of encouragement and discussing politics and the people of Morocco.",
      evidence:
        "Itemized from pages 14-15 of the NARA direct folder scan using the White House address page, presidential handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "herbert-hoffman-political-supporter-correspondence",
      documentType: "Presidential Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "Herbert S. Hoffman correspondence re a political supporter and President Bush's response",
      documentDate: "1992-09-24",
      pages: 4,
      excerpt:
        "The packet includes Camp David routing material, Herbert Hoffman's September 18 letter about a supporter, and President Bush's handwritten and typed response.",
      evidence:
        "Itemized from pages 16-19 of the NARA direct folder scan using Camp David/White House address pages, Hoffman letterhead, presidential handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "miller-small-business-campaign-spokesman-letter",
      documentType: "Presidential Letter",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title:
        "President Bush letter to Miller re small business campaign spokesman role",
      documentDate: "1992-09-24",
      pages: 2,
      excerpt:
        "President Bush thanks Miller for work on small business, says he wants him involved in a campaign spokesman role, and notes a White House copy with handwriting.",
      evidence:
        "Itemized from pages 20-21 of the NARA direct folder scan using presidential letterhead, Bush handwriting marker, self-typed copy, OCR, and rendered-page review.",
    },
    {
      slug: "chi-chi-rodriguez-initial-call-packet",
      documentType: "Presidential Memorandum and Call Form",
      category: "telephone-call-forms",
      disposition: "itemized-telephone-call-forms",
      title:
        "President Bush memo to Roger Porter and phone-call form re Chi Chi Rodriguez Foundation",
      documentDate: "1992-09-24",
      pages: 2,
      excerpt:
        "President Bush asks Roger Porter to call Bill Hayes of the Chi Chi Rodriguez Foundation, followed by a Camp David presidential phone-call form for Chi Chi Rodriguez.",
      evidence:
        "Itemized from pages 22-23 of the NARA direct folder scan using the President's memo, phone-call form, OCR, and rendered-page review.",
    },
    {
      slug: "leon-sullivan-birthday-tribute-clearance-packet",
      documentType: "White House Memoranda and Invitation Packet",
      category: "event-invitation-clearance",
      disposition: "itemized-event-invitation-clearance",
      title:
        "Reverend Leon Sullivan 70th birthday tribute honorary co-chairman clearance packet",
      documentDate: "1992-09-23",
      pages: 4,
      excerpt:
        "The packet includes a Kathy Super memorandum on a special tribute honoring Reverend Leon Sullivan, Gregory Walden clearance material, and American Express Bank invitation correspondence.",
      evidence:
        "Itemized from pages 24-27 of the NARA direct folder scan using White House memorandum headings, American Express letterhead, OCR, and rendered-page review.",
    },
    {
      slug: "scowcroft-wallop-sdi-letter-packet",
      documentType: "National Security Memorandum and Letter Packet",
      category: "national-security-correspondence",
      disposition: "itemized-national-security-correspondence",
      title:
        "Brent Scowcroft action memorandum and President Bush draft response to Senator Malcolm Wallop on SDI",
      documentDate: "1992-09-23",
      pages: 5,
      excerpt:
        "Brent Scowcroft sends the President an action memorandum on shoring up congressional support for SDI, with a draft presidential response and Senator Malcolm Wallop's July 31 letter on the ABM Treaty.",
      evidence:
        "Itemized from pages 28-32 of the NARA direct folder scan using the Scowcroft action memorandum, draft response, Wallop letterhead, OCR, and rendered-page review.",
    },
    {
      slug: "scott-miller-vanity-fair-firefighter-first-packet",
      documentType: "Presidential Correspondence Packet",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title:
        "Scott Miller Vanity Fair firefighter correspondence packet, first set",
      documentDate: "1992-09-24",
      pages: 4,
      excerpt:
        "The first Scott Miller packet includes President Bush's note about helping a Los Angeles firefighter, a September 24 presidential letter, Miller's letter to Vanity Fair, and the Barbara Bush article excerpt.",
      evidence:
        "Itemized from pages 33-36 of the NARA direct folder scan using presidential letterhead, Scott Miller letter text, Vanity Fair clipping page, OCR, and rendered-page review.",
    },
    {
      slug: "white-house-news-summary-3pm-update-september-24-1992",
      documentType: "White House News Summary",
      category: "white-house-news-summary",
      disposition: "itemized-white-house-news-summary",
      title:
        "White House News Summary: 3:00 p.m. news update, September 24, 1992",
      documentDate: "1992-09-24",
      pages: 1,
      excerpt:
        "The 3:00 p.m. News Update covers Clinton on health care, tax increases, debates, Bush and small business, the Southern strategy, Ross Perot, and congressional activity.",
      evidence:
        "Itemized from page 37 of the NARA direct folder scan using the White House News Summary heading, OCR, and rendered-page review.",
    },
    {
      slug: "tom-coble-small-business-thank-you-letter",
      documentType: "Presidential Letter",
      category: "small-business-correspondence",
      disposition: "itemized-small-business-correspondence",
      title:
        "President Bush letter to Thomas Coble re Greensboro small business meeting",
      documentDate: "1992-09-24",
      pages: 1,
      excerpt:
        "President Bush thanks Thomas Coble, Small Businessman of the Year from Greensboro, North Carolina, for introducing him to the Triad business community.",
      evidence:
        "Itemized from page 38 of the NARA direct folder scan using the George Bush letterhead page, address note, OCR, and rendered-page review.",
    },
    {
      slug: "lehman-community-service-council-daily-point-of-light-release",
      documentType: "Daily Point of Light Release",
      category: "daily-point-of-light",
      disposition: "itemized-daily-point-of-light",
      title:
        "Daily Point of Light release: Lehman Community Service Council of Williamstown, Massachusetts",
      documentDate: "1992-09-24",
      pages: 2,
      excerpt:
        "The White House release recognizes volunteers of the Lehman Community Service Council of Williamstown, Massachusetts, as the 903rd Daily Point of Light for the Nation.",
      evidence:
        "Itemized from pages 39-40 of the NARA direct folder scan using Office of the Press Secretary release headings, duplicate rotated copy, OCR, and rendered-page review.",
    },
    {
      slug: "campaign-trail-clipping-packet-huffington-small-business",
      documentType: "Press Clipping Packet",
      category: "campaign-press-clippings",
      disposition: "itemized-campaign-press-clippings",
      title:
        "Campaign-trail clipping packet re Michael Huffington, small-business endorsement, and campaign commentary",
      documentDate: "1992-09-24",
      pages: 3,
      excerpt:
        "The clipping packet includes campaign-trail articles on Michael Huffington and PAC donations, a small-business endorsement page, and the 'Angry Poodle Barbecue' column.",
      evidence:
        "Itemized from pages 41-43 of the NARA direct folder scan using clipping mastheads, handwritten notes, OCR, and rendered-page review.",
    },
    {
      slug: "mrs-bush-press-office-daily-clippings-september-24-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title:
        "Mrs. Bush's Press Office Daily Press Clippings, Thursday, September 24, 1992",
      documentDate: "1992-09-24",
      pages: 20,
      excerpt:
        "The First Lady press-clipping packet includes a routing cover sheet and articles on Frank Zappa, George Bush's war record, Hillary Clinton, cable television, women's medical research, women in Congress, Quaker employment benefits, children suing parents, schools, and White House silver dollars.",
      evidence:
        "Itemized from pages 44-63 of the NARA direct folder scan using the Mrs. Bush Press Office cover sheet, newspaper mastheads, OCR, and rendered-page review.",
    },
    {
      slug: "lud-ashley-clinton-rolling-stone-banking-fax",
      documentType: "Incoming Memorandum with President Bush Handwriting",
      category: "campaign-policy-correspondence",
      disposition: "itemized-campaign-policy-correspondence",
      title:
        "Lud Ashley fax to President Bush re Clinton's Rolling Stone banking interview",
      documentDate: "1992-09-24",
      pages: 1,
      excerpt:
        "Association of Bank Holding Companies chairman Lud Ashley sends President Bush comments on Clinton's Rolling Stone remarks about banking, with presidential handwriting and routing notes.",
      evidence:
        "Itemized from page 64 of the NARA direct folder scan using ABHC fax heading, presidential handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "chi-chi-rodriguez-foundation-porter-follow-up-packet",
      documentType: "Presidential Memorandum and Staff Follow-Up Packet",
      category: "education-foundation-correspondence",
      disposition: "itemized-education-foundation-correspondence",
      title:
        "Chi Chi Rodriguez Foundation follow-up packet with Roger Porter memorandum",
      documentDate: "1992-09-25",
      pages: 3,
      excerpt:
        "The packet includes the President's Chi Chi Rodriguez memo and Roger Porter's two-page response describing the foundation's school and public-private partnership model.",
      evidence:
        "Itemized from pages 65-67 of the NARA direct folder scan using the President's memo, Porter memorandum, Bush handwriting, OCR, and rendered-page review.",
    },
    {
      slug: "scott-miller-firefighter-vanity-fair-follow-up-packet",
      documentType: "Presidential Correspondence and Staff Follow-Up Packet",
      category: "personal-correspondence",
      disposition: "itemized-personal-correspondence",
      title:
        "Scott Miller Los Angeles firefighter and Vanity Fair follow-up packet",
      documentDate: "1992-09-24",
      pages: 7,
      excerpt:
        "The follow-up packet includes President Bush's note about finding help for Scott Miller, Shirley Green and Sally Kelley follow-up memoranda, a presidential letter to Scott, Miller's Vanity Fair letter, and the Barbara Bush clipping.",
      evidence:
        "Itemized from pages 68-74 of the NARA direct folder scan using presidential handwriting, staff follow-up memoranda, Scott Miller letter text, Vanity Fair clipping page, OCR, and rendered-page review.",
    },
    {
      slug: "washington-post-clipping-packet-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Washington Post clipping packet on Quayle, Clinton, vetoes, Iran-Contra, POWs, and campaign coverage",
      documentDate: "1992-09-24",
      pages: 18,
      excerpt:
        "The Washington Post packet includes Jack Anderson on the auto pen and Quayle, campaign-trail coverage, family leave and China vetoes, small business tax plans, Iran-Contra, POW policy, urban aid, television coverage, and Metro/NSF funding.",
      evidence:
        "Itemized from pages 75-92 of the NARA direct folder scan using Washington Post mastheads, article starts, rotated pages, OCR, and rendered-page review.",
    },
    {
      slug: "new-york-times-clipping-packet-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "New York Times clipping packet on Bush, Clinton, taxes, foreign affairs, and Greenspan",
      documentDate: "1992-09-24",
      pages: 10,
      excerpt:
        "The New York Times packet includes articles on the Senate tax bill, Bush's attacks on Clinton, small-business taxes, Bush and bounty politics, Bush's Penn State remarks, foreign affairs, unwed motherhood, and Greenspan pressure.",
      evidence:
        "Itemized from pages 93-102 of the NARA direct folder scan using New York Times mastheads, article starts, OCR, and rendered-page review.",
    },
    {
      slug: "usa-today-clipping-packet-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "USA Today clipping packet on Bush, Perot, Clinton, family leave, and small business taxes",
      documentDate: "1992-09-24",
      pages: 6,
      excerpt:
        "The USA Today packet includes items on Bush and Iraq/credibility, family leave, Perot's campaign posture, polling, Clinton's support, and Bush's tax-reduction plan for small businesses.",
      evidence:
        "Itemized from pages 103-108 of the NARA direct folder scan using USA Today mastheads, article starts, OCR, and rendered-page review.",
    },
    {
      slug: "los-angeles-times-washington-edition-clippings-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Los Angeles Times Washington Edition clipping packet on Iraqi arms, debates, Quayle, Jewish voters, and economic policy",
      documentDate: "1992-09-24",
      pages: 6,
      excerpt:
        "The Los Angeles Times Washington Edition packet covers Iraqi arms-aid questions, Clinton's debate schedule, Quayle attacks on Clinton, Jewish voters and the GOP, war protest and commander-in-chief politics, and economic policy.",
      evidence:
        "Itemized from pages 109-114 of the NARA direct folder scan using Los Angeles Times mastheads, article starts, OCR, and rendered-page review.",
    },
    {
      slug: "washington-times-clipping-packet-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Washington Times clipping packet on education, debates, media, taxes, POWs, the United Nations, and torts",
      documentDate: "1992-09-24",
      pages: 7,
      excerpt:
        "The Washington Times packet includes articles on Lamar Alexander and merit pay, debates, Bush media dividends, tax-break proposals, POW/MIA issues, the United Nations, and tort policy.",
      evidence:
        "Itemized from pages 115-121 of the NARA direct folder scan using Washington Times mastheads, article starts, cartoon page, OCR, and rendered-page review.",
    },
    {
      slug: "wall-street-journal-clipping-packet-september-24-1992",
      documentType: "Press Clipping Packet",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title:
        "Wall Street Journal clipping packet on Baker, Perot, Clinton, small-business taxes, veterans, and business leaders",
      documentDate: "1992-09-24",
      pages: 5,
      excerpt:
        "The Wall Street Journal packet includes articles on James Baker and Ross Perot, Clinton's campaign caution, Bush's break for small firms, a Vietnam veteran's advice to Clinton, and Clinton's strength with business leaders.",
      evidence:
        "Itemized from pages 122-126 of the NARA direct folder scan using Wall Street Journal mastheads, article starts, OCR, and rendered-page review.",
    },
    {
      slug: "herbert-hoffman-jan-burmeister-photograph-enclosure",
      documentType: "Photograph and Correspondence Enclosure",
      category: "photograph-enclosure",
      disposition: "itemized-photograph-enclosure",
      title:
        "Herbert S. Hoffman and Jan Burmeister photograph enclosure with President Bush note",
      documentDate: "1992-09-24",
      pages: 3,
      excerpt:
        "The enclosure includes a White House address page for Herbert S. Hoffman with President Bush handwriting, a Jan Burmeister notation, a color photograph, and a backing page.",
      evidence:
        "Itemized from pages 127-129 of the NARA direct folder scan using the White House address page, Bush handwriting, color photo page, backing page, and rendered-page review.",
    },
  ],
  470418122: [
    {
      slug: "st-louis-railroad-ymca-history",
      documentType: "Historical Background",
      category: "st-louis-debate-background",
      disposition: "itemized-st-louis-debate-background",
      title: "A Historical Perspective of the St. Louis Railroad YMCA - Drury Inn Union Station Building",
      documentDate: "",
      pages: 1,
      excerpt:
        "Historical background on the St. Louis Railroad YMCA building, later the Drury Inn Union Station, included in the St. Louis debate packet.",
      evidence:
        "Itemized from the historical-perspective heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "clinton-vietnam-war-years-article",
      documentType: "Press Article",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title: "Press article: Campaign Renews Disputes of the Vietnam War Years",
      documentDate: "",
      pages: 3,
      excerpt:
        "A campaign press article discusses renewed disputes over Vietnam War-era service, draft, and protest issues in the 1992 presidential campaign.",
      evidence:
        "Itemized from article and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "debra-dunn-first-family-st-louis-debate",
      documentType: "Campaign Logistics Memo",
      category: "st-louis-debate-logistics",
      disposition: "itemized-st-louis-debate-logistics",
      title: "Memorandum from Debra Dunn to Brad Blakeman re First Family - St. Louis Debate",
      documentDate: "1992-10-09",
      pages: 1,
      excerpt:
        "Debra Dunn sends a revised Bush-Quayle memo on First Family arrivals, debate tickets, hotel arrangements, and departures for the St. Louis debate.",
      evidence:
        "Itemized from a Bush-Quayle revised memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "grady-debate-material-answers",
      documentType: "Memorandum",
      category: "debate-prep-memorandum",
      disposition: "itemized-debate-prep-memorandum",
      title: "Memorandum from Robert E. Grady through Richard G. Darman to the President re Answers to Questions, Clarifications, Updates on Debate Material",
      documentDate: "1992-10-09",
      pages: 2,
      excerpt:
        "Robert Grady, through Richard Darman, provides the President with answers, clarifications, and updates on debate material.",
      evidence:
        "Itemized from an OMB memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "right-to-work-key-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Key Points: Right to Work",
      documentDate: "",
      pages: 1,
      excerpt:
        "Debate-prep key points on right-to-work law and labor policy appear in the St. Louis debate packet.",
      evidence:
        "Itemized from a Right to Work key-points heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "one-sentence-snippets",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "One Sentence Snippets",
      documentDate: "1992-10-08",
      pages: 1,
      excerpt:
        "A debate-prep sheet labeled one sentence snippets supplies short campaign lines and responses.",
      evidence:
        "Itemized from an REG 10/8/92 one-sentence-snippets heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rgd-president-rehearsal-questions",
      documentType: "Debate Rehearsal Questions",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Rehearsal Questions for Initial Response by the President",
      documentDate: "1992-10-07",
      pages: 3,
      excerpt:
        "RGD rehearsal questions prepare the President for the first presidential debate, with questions numbered for initial responses.",
      evidence:
        "Itemized from RGD rehearsal-question headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "first-presidential-debate-rehearsal-intro",
      documentType: "Debate Rehearsal Script",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Rehearsal for First Presidential Debate: Jim Lehrer introduction",
      documentDate: "",
      pages: 1,
      excerpt:
        "A rehearsal script for the first presidential debate opens with a Jim Lehrer-style introduction.",
      evidence:
        "Itemized from a rehearsal introduction page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rgd-perot-rehearsal-questions",
      documentType: "Debate Rehearsal Questions",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Rehearsal Questions for Initial Response by Mr. Perot",
      documentDate: "1992-10-08",
      pages: 1,
      excerpt:
        "RGD rehearsal questions anticipate initial responses by Ross Perot for the first presidential debate.",
      evidence:
        "Itemized from an RGD rehearsal-question heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rgd-clinton-rehearsal-questions",
      documentType: "Debate Rehearsal Questions",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Rehearsal Questions for Initial Response by Governor Clinton",
      documentDate: "1992-10-07",
      pages: 1,
      excerpt:
        "RGD rehearsal questions anticipate initial responses by Governor Clinton for the first presidential debate.",
      evidence:
        "Itemized from an RGD rehearsal-question heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "perot-financial-disclosure-citicorp-memo",
      documentType: "Debate Prep Research Note",
      category: "debate-prep-research",
      disposition: "itemized-debate-prep-research",
      title: "Debate-prep research note re Perot financial disclosure, Citicorp, and Japan",
      documentDate: "",
      pages: 1,
      excerpt:
        "A debate-prep research note summarizes Ross Perot financial-disclosure and Citicorp short-selling material.",
      evidence:
        "Itemized from Perot financial-disclosure and Citicorp text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ottawa-citizen-perot-short-selling",
      documentType: "Press Article",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title: "Ottawa Citizen article: Perot loses $2 million on short-selling bet",
      documentDate: "1992-07-12",
      pages: 2,
      excerpt:
        "An Ottawa Citizen article reports on Ross Perot losing money on a short-selling bet involving Citicorp stock.",
      evidence:
        "Itemized from an Ottawa Citizen article heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "nyt-candidate-would-be-analyst",
      documentType: "Press Article",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title: "New York Times article: The Candidate Who Would Be an Analyst",
      documentDate: "1992-07-01",
      pages: 3,
      excerpt:
        "A New York Times article by Michael Quint examines Ross Perot's Citicorp investment and financial analysis.",
      evidence:
        "Itemized from a New York Times article heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "both-sides-note",
      documentType: "Handwritten and Typed Note",
      category: "debate-prep-notes",
      disposition: "itemized-debate-prep-notes",
      title: "Both Sides debate-prep note",
      documentDate: "1992-10-06",
      pages: 2,
      excerpt:
        "A handwritten and typed debate-prep note labeled Both Sides appears with a George Bush desk sheet.",
      evidence:
        "Itemized from a George Bush desk sheet and Both Sides note found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "lamar-alexander-clinton-arkansas-income-note",
      documentType: "Note",
      category: "debate-prep-notes",
      disposition: "itemized-debate-prep-notes",
      title: "Note from Lamar Alexander to the President re Clinton, Arkansas, and median household income",
      documentDate: "1992-10-06",
      pages: 2,
      excerpt:
        "Lamar Alexander sends the President a note and household-income table for use against Governor Clinton's Arkansas record.",
      evidence:
        "Itemized from a Lamar Alexander note and table found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "perot-japan-citicorp-foreign-business-key-points",
      documentType: "Debate Prep Key Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Perot key points on Japan, Citicorp, and foreign business",
      documentDate: "",
      pages: 3,
      excerpt:
        "Debate-prep key points address Ross Perot, Japan, Citicorp, and foreign business issues.",
      evidence:
        "Itemized from Perot key-point headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "potus-october-10-pepper-drill-schedule",
      documentType: "Proposed Schedule",
      category: "debate-prep-logistics",
      disposition: "itemized-debate-prep-logistics",
      title: "Proposed POTUS schedule for October 10 pepper drill and debate-prep papers",
      documentDate: "",
      pages: 1,
      excerpt:
        "A proposed POTUS schedule lays out an October 10 pepper drill and lists debate-prep papers to send to the plane.",
      evidence:
        "Itemized from a proposed POTUS schedule and papers-to-send list found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "nonexistent-pow-film-perot-allegation",
      documentType: "Debate Prep Memorandum",
      category: "debate-prep-research",
      disposition: "itemized-debate-prep-research",
      title: "The Non-existent $4.2 million POW Film",
      documentDate: "",
      pages: 1,
      excerpt:
        "A debate-prep memorandum responds to a Perot allegation about a POW film expenditure.",
      evidence:
        "Itemized from a POW film memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "nyt-perot-bush-vietnam-link",
      documentType: "Press Article",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title: "New York Times article: New Questions About Perot-Bush Link on Vietnam",
      documentDate: "1992-10-09",
      pages: 1,
      excerpt:
        "A New York Times clipping by Barbara Crossette covers questions about Ross Perot, President Bush, and Vietnam issues.",
      evidence:
        "Itemized from a New York Times clipping heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "october-11-president-schedule-supplementary-tabs",
      documentType: "Presidential Schedule",
      category: "st-louis-trip-schedule",
      disposition: "itemized-st-louis-trip-schedule",
      title: "Schedule of the President: Sunday, October 11, 1992, with supplementary tabs",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "A Sunday, October 11 presidential schedule page introduces supplementary tabs for the St. Louis debate trip.",
      evidence:
        "Itemized from a Schedule of the President heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "st-louis-event-scenarios-debate",
      documentType: "Event Scenarios",
      category: "st-louis-trip-schedule",
      disposition: "itemized-st-louis-trip-schedule",
      title: "Event scenarios: Technical Walk-Through of Debate Site and Presidential Debate",
      documentDate: "1992-10-11",
      pages: 2,
      excerpt:
        "Scenario pages cover the technical walk-through of the debate site and the presidential debate event.",
      evidence:
        "Itemized from event-scenario headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "redaction-sheet-st-louis-schedule-one-page",
      documentType: "Withdrawal/Redaction Sheet",
      category: "redaction-sheet-item",
      disposition: "itemized-redaction-sheet",
      title: "Withdrawal/Redaction Sheet: Document No. 01, Schedule of President and Mrs. Bush for St. Louis, Missouri",
      documentDate: "",
      pages: 1,
      excerpt:
        "A withdrawal/redaction sheet identifies a one-page schedule of President and Mrs. Bush for the St. Louis, Missouri trip.",
      evidence:
        "Itemized from a withdrawal/redaction sheet found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "st-louis-trip-schedule-cover-weather",
      documentType: "Schedule Cover Material",
      category: "st-louis-trip-schedule",
      disposition: "itemized-st-louis-trip-schedule",
      title: "St. Louis trip schedule cover, contact page, and weather",
      documentDate: "1992-10-11",
      pages: 2,
      excerpt:
        "Cover and preliminary pages for the St. Louis trip schedule include trip contacts and weather information.",
      evidence:
        "Itemized from St. Louis trip schedule cover and weather pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "redaction-sheet-st-louis-schedule-nine-pages",
      documentType: "Withdrawal/Redaction Sheet",
      category: "redaction-sheet-item",
      disposition: "itemized-redaction-sheet",
      title: "Withdrawal/Redaction Sheet: Document No. 02, Schedule of President and Mrs. Bush for St. Louis, Missouri",
      documentDate: "",
      pages: 1,
      excerpt:
        "A withdrawal/redaction sheet identifies a multi-page schedule of President and Mrs. Bush for the St. Louis, Missouri trip.",
      evidence:
        "Itemized from a withdrawal/redaction sheet found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "st-louis-full-trip-schedule",
      documentType: "Presidential Schedule",
      category: "st-louis-trip-schedule",
      disposition: "itemized-st-louis-trip-schedule",
      title: "Schedule of the President and Mrs. Bush for St. Louis, Missouri, October 11-12, 1992",
      documentDate: "1992-10-11",
      pages: 14,
      excerpt:
        "The full trip schedule covers President and Mrs. Bush in St. Louis for debate events, hotel movements, and October 11-12 logistics.",
      evidence:
        "Itemized from the full St. Louis trip schedule heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "st-louis-site-diagrams-tabs",
      documentType: "Site Diagrams",
      category: "st-louis-trip-diagrams",
      disposition: "itemized-st-louis-trip-diagrams",
      title: "St. Louis trip site diagrams and supplementary tabs",
      documentDate: "1992-10-11",
      pages: 7,
      excerpt:
        "Trip diagrams and tabs cover Lambert Airport, Washington University Field House, Drury Inn, St. Louis Community College, and related sites.",
      evidence:
        "Itemized from site-diagram and tab pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "st-louis-condensed-trip-schedule",
      documentType: "Condensed Schedule",
      category: "st-louis-trip-schedule",
      disposition: "itemized-st-louis-trip-schedule",
      title: "Condensed St. Louis schedule and chronology, October 11-12, 1992",
      documentDate: "1992-10-11",
      pages: 4,
      excerpt:
        "A condensed chronology summarizes the President's and Mrs. Bush's St. Louis movements around the debate.",
      evidence:
        "Itemized from condensed schedule and chronology pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-room-list-st-louis-first-copy",
      documentType: "Room List",
      category: "st-louis-trip-logistics",
      disposition: "itemized-st-louis-trip-logistics",
      title: "White House Room List: St. Louis, Missouri",
      documentDate: "1992-10-11",
      pages: 4,
      excerpt:
        "A White House room list for the St. Louis trip appears with an associated withdrawal/redaction sheet and visible name pages.",
      evidence:
        "Itemized from White House room-list and redaction-sheet pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "air-force-one-st-louis-flight-map",
      documentType: "Flight Map",
      category: "st-louis-trip-map",
      disposition: "itemized-st-louis-trip-map",
      title: "Air Force One flight map: Trip of President and Mrs. Bush to St. Louis, Missouri",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "An Air Force One flight map covers the President and Mrs. Bush's St. Louis trip on October 11-12.",
      evidence:
        "Itemized from a flight-map heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "missouri-congressional-districts-map",
      documentType: "Map",
      category: "st-louis-trip-map",
      disposition: "itemized-st-louis-trip-map",
      title: "1992 Congressional Districts - Missouri map",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "A Missouri congressional-district map appears in the St. Louis debate trip packet.",
      evidence:
        "Itemized from a congressional-district map heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-room-list-st-louis-second-copy",
      documentType: "Room List",
      category: "st-louis-trip-logistics",
      disposition: "itemized-st-louis-trip-logistics",
      title: "White House Room List: St. Louis, Missouri, second copy",
      documentDate: "1992-10-11",
      pages: 4,
      excerpt:
        "A second White House room-list copy or continuation appears with an associated withdrawal/redaction sheet and visible name pages.",
      evidence:
        "Itemized from duplicate or continued White House room-list and redaction-sheet pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "post-debate-welcome-kaufman-memo",
      documentType: "Memorandum",
      category: "st-louis-event-briefing",
      disposition: "itemized-st-louis-event-briefing",
      title: "Memorandum from Ronald C. Kaufman re Post Debate Welcome",
      documentDate: "1992-10-08",
      pages: 1,
      excerpt:
        "Ron Kaufman briefs the President on the post-debate welcome at Forest Park Community College, including purpose, background, and participants.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "missouri-st-louis-briefing",
      documentType: "Briefing Memorandum",
      category: "st-louis-event-briefing",
      disposition: "itemized-st-louis-event-briefing",
      title: "Memorandum from Bobbie Kilberg and Helen R. Mobley through W. Henson Moore re Missouri (St. Louis)",
      documentDate: "1992-10-09",
      pages: 4,
      excerpt:
        "Bobbie Kilberg and Helen Mobley, through Henson Moore, brief the President on Missouri and St. Louis for the debate trip.",
      evidence:
        "Itemized from a White House memorandum heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "missouri-political-briefing",
      documentType: "Political Briefing",
      category: "st-louis-event-briefing",
      disposition: "itemized-st-louis-event-briefing",
      title: "Memorandum from Ronald C. Kaufman re Missouri Political Briefing",
      documentDate: "1992-10-08",
      pages: 6,
      excerpt:
        "Ron Kaufman briefs the President on Missouri political conditions for the St. Louis debate trip.",
      evidence:
        "Itemized from a Missouri political-briefing memorandum heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "redaction-sheets-seating-diagrams",
      documentType: "Withdrawal/Redaction Sheets",
      category: "redaction-sheet-item",
      disposition: "itemized-redaction-sheet",
      title: "Withdrawal/Redaction Sheets for VH-3D and VC25A seating diagrams, October 11-12, 1992",
      documentDate: "",
      pages: 6,
      excerpt:
        "Withdrawal/redaction sheets identify withheld seating diagrams for helicopter and Air Force One movements during the St. Louis, Philadelphia, and Grand Rapids trip.",
      evidence:
        "Itemized from a consecutive run of seating-diagram withdrawal/redaction sheets found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "debate-talking-points-photocopy-packet",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Photocopied debate talking-points packet with President Bush handwriting",
      documentDate: "1992-10-11",
      pages: 6,
      excerpt:
        "A photocopied debate-prep packet with President Bush handwriting covers attacks, character, energy, patriotism, Arkansas, and Clinton-witness themes.",
      evidence:
        "Itemized from Bush Library photocopy markers and handwritten debate-prep pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "presidential-phone-call-slip-notes",
      documentType: "Handwritten Notes and Call Slips",
      category: "telephone-note-packet",
      disposition: "itemized-telephone-note-packet",
      title: "Presidential phone-call slip notes and handwritten pages",
      documentDate: "",
      pages: 4,
      excerpt:
        "A photocopied packet includes George Bush desk sheets, phone-call slips, and handwritten pages tied to October 11 call handling.",
      evidence:
        "Itemized from George Bush desk sheets, phone-call slip text, and Bush Library photocopy markers found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "october-11-telephone-memoranda",
      documentType: "Telephone Memoranda",
      category: "telephone-log-item",
      disposition: "itemized-telephone-log",
      title: "White House telephone memoranda: President Bush calls, October 11, 1992",
      documentDate: "1992-10-11",
      pages: 2,
      excerpt:
        "White House telephone memoranda list October 11 calls with H. P. Goldfield, Richard Phelps, John Wallach, Tommy Lasorda, Margaret Bush, a doctor's office, and Rose Zamaria.",
      evidence:
        "Itemized from White House telephone memorandum headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "october-11-signal-switchboard-log",
      documentType: "Signal Switchboard Log",
      category: "telephone-log-item",
      disposition: "itemized-telephone-log",
      title: "Signal Switchboard telephone memorandum: October 11, 1992",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "The Signal Switchboard log records October 11 calls with Nicholas Brady, James Baker, George W. Bush, Dan Quayle, George H. Bush Jr., and Jerry Weintraub.",
      evidence:
        "Itemized from a Signal Switchboard telephone memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "october-11-presidential-movements",
      documentType: "Presidential Movements",
      category: "presidential-movements-item",
      disposition: "itemized-presidential-movements",
      title: "Presidential Movements: Washington and St. Louis, October 11, 1992",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "The presidential-movements log tracks the President's Washington and St. Louis movements on debate day.",
      evidence:
        "Itemized from a Presidential Movements heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-airport-remarks",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #1: Bush remarks at airport, St. Louis",
      documentDate: "1992-10-11",
      pages: 2,
      excerpt:
        "Pool Report #1 covers the President's airport remarks in St. Louis and related dignitary details.",
      evidence:
        "Itemized from Pool Report #1 heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-bush-debate-rally",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #3: Bush Debate Rally, St. Louis",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "Pool Report #3 covers the Bush debate rally in St. Louis on October 11.",
      evidence:
        "Itemized from a Pool Report #3 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-hotel-to-debate",
      documentType: "Pool Report",
      category: "pool-report-item",
      disposition: "itemized-pool-report",
      title: "Pool Report #2: Hotel to Debate, St. Louis",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "Pool Report #2 covers the President's movement from the hotel to the debate in St. Louis.",
      evidence:
        "Itemized from a Pool Report #2 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "president-to-rz-debate-prep-saved",
      documentType: "President's Note",
      category: "debate-prep-notes",
      disposition: "itemized-debate-prep-notes",
      title: "Note from the President to RZ re saving debate-prep notes and papers",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "The President asks RZ to save debate-prep notes and papers and notes that he will not need to review them again.",
      evidence:
        "Itemized from a From the President note heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "education-debate-prep-notes",
      documentType: "Debate Prep Notes",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Debate-prep notes on education, student loans, Head Start, and Arkansas schools",
      documentDate: "1992-10-11",
      pages: 1,
      excerpt:
        "A debate-prep notes page covers student loans, Head Start, Clinton's Arkansas education record, and education legislation.",
      evidence:
        "Itemized from education debate-prep note text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "jab-one-liners-note",
      documentType: "Note and Talking Points",
      category: "debate-prep-one-liners",
      disposition: "itemized-debate-prep-one-liners",
      title: "Eyes Only note from JAB III to the President re one-liners",
      documentDate: "1992-10-09",
      pages: 2,
      excerpt:
        "James A. Baker III sends the President a list of one-liners for the pepper drill and rehearsal.",
      evidence:
        "Itemized from an Eyes Only JAB III note and attached one-liners found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "iran-contra-talking-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Iran-Contra talking points",
      documentDate: "",
      pages: 1,
      excerpt:
        "A debate-prep sheet supplies Iran-Contra talking points and answer counts.",
      evidence:
        "Itemized from Iran-Contra talking-point text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "iraq-policy-talking-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Iraq policy talking points and no-cover-up material",
      documentDate: "",
      pages: 2,
      excerpt:
        "Debate-prep talking points address U.S. policy toward Iraq, cover-up allegations, and wrongdoing claims.",
      evidence:
        "Itemized from Iraq policy talking-point pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "abortion-hostages-crime-education-transportation-talking-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Debate talking points on abortion, hostages, crime, education, and transportation",
      documentDate: "",
      pages: 1,
      excerpt:
        "A debate-prep page collects points on abortion, hostages and the Middle East, crime, education, and transportation.",
      evidence:
        "Itemized from topical debate-prep headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "education-talking-points-october-3",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Education talking points on standards, testing, school choice, and Arkansas",
      documentDate: "1992-10-03",
      pages: 2,
      excerpt:
        "Education talking points cover standards, testing, school choice, and Clinton's Arkansas education record.",
      evidence:
        "Itemized from education talking-point pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rgd-room-450-rehearsal-sequence",
      documentType: "Debate Rehearsal Sequence",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Sequence of Topics and Questions for Room 450 rehearsal",
      documentDate: "1992-10-09",
      pages: 1,
      excerpt:
        "An RGD sequence page lays out topics and questions for the Room 450 rehearsal for the first presidential debate.",
      evidence:
        "Itemized from an RGD sequence-of-topics heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "rgd-rehearsal-questions-packet-second-copy",
      documentType: "Debate Rehearsal Questions",
      category: "debate-rehearsal-material",
      disposition: "itemized-debate-rehearsal-material",
      title: "Second debate rehearsal questions packet for President Bush, Mr. Perot, and Governor Clinton",
      documentDate: "",
      pages: 4,
      excerpt:
        "A second packet of RGD rehearsal questions covers initial-response questions for President Bush, Ross Perot, and Governor Clinton.",
      evidence:
        "Itemized from a later run of RGD rehearsal-question headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "clinton-tax-increase-economic-issues",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Economic Issues Tab 11: Clinton Tax Increase",
      documentDate: "1992-10-06",
      pages: 1,
      excerpt:
        "Economic Issues Tab 11 provides debate-prep points on Clinton and tax increases.",
      evidence:
        "Itemized from an Economic Issues Tab 11 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pepper-drill-questions",
      documentType: "Debate Prep Questions",
      category: "debate-prep-questions",
      disposition: "itemized-debate-prep-questions",
      title: "Pepper Drill Questions for the Debate",
      documentDate: "",
      pages: 4,
      excerpt:
        "A pepper-drill packet provides rapid-fire debate questions for the President.",
      evidence:
        "Itemized from Pepper Drill Questions headings and numbered question pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "boskin-gray-regulatory-reform-debates",
      documentType: "Memorandum",
      category: "debate-prep-memorandum",
      disposition: "itemized-debate-prep-memorandum",
      title: "Memorandum from Michael J. Boskin and C. Boyden Gray re Regulatory Reform and the Debates",
      documentDate: "1992-10-07",
      pages: 1,
      excerpt:
        "Michael Boskin and Boyden Gray brief the President on regulatory reform for the debates.",
      evidence:
        "Itemized from a White House memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "better-off-decline-talking-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Better Off/Decline talking points",
      documentDate: "1992-09-24",
      pages: 1,
      excerpt:
        "RGD talking points frame better-off and decline themes for the 1992 debate.",
      evidence:
        "Itemized from an RGD Better Off/Decline heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "economy-talking-points",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "The Economy talking points",
      documentDate: "",
      pages: 1,
      excerpt:
        "A debate-prep page collects talking points on the economy.",
      evidence:
        "Itemized from a The Economy talking-points heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "five-points-to-mention",
      documentType: "Debate Prep Talking Points",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Five Points to Mention No Matter What",
      documentDate: "",
      pages: 1,
      excerpt:
        "A draft debate-prep sheet lists five points the President should mention regardless of the question.",
      evidence:
        "Itemized from a Five Points to Mention heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "truth-about-us-policy-toward-iraq",
      documentType: "Debate Prep Paper",
      category: "debate-prep-foreign-policy",
      disposition: "itemized-debate-prep-foreign-policy",
      title: "The Truth About U.S. Policy Toward Iraq",
      documentDate: "1992-10-06",
      pages: 4,
      excerpt:
        "A debate-prep paper presents myth-and-truth material on U.S. policy toward Iraq.",
      evidence:
        "Itemized from The Truth About U.S. Policy Toward Iraq heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "us-policy-toward-iraq-shorter-points",
      documentType: "Debate Prep Paper",
      category: "debate-prep-foreign-policy",
      disposition: "itemized-debate-prep-foreign-policy",
      title: "U.S. Policy Toward Iraq shorter talking points with President Bush handwriting",
      documentDate: "1992-10-06",
      pages: 2,
      excerpt:
        "A shorter U.S. policy toward Iraq debate-prep paper appears with President Bush handwriting.",
      evidence:
        "Itemized from Iraq policy talking-point pages and Bush handwriting markers found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "draft-honesty-handwritten-notes",
      documentType: "Handwritten Debate Notes",
      category: "debate-prep-notes",
      disposition: "itemized-debate-prep-notes",
      title: "Handwritten debate notes re draft, honesty, and Clinton responses",
      documentDate: "",
      pages: 7,
      excerpt:
        "A photocopied run of handwritten debate notes addresses Clinton's draft statements, truthfulness, one-liners, and debate responses.",
      evidence:
        "Itemized from Bush Library photocopy markers and handwritten debate-note pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "iran-contra-questions-answered-update",
      documentType: "Debate Prep Update",
      category: "debate-prep-talking-points",
      disposition: "itemized-debate-prep-talking-points",
      title: "Update: Questions Answered on Iran-Contra",
      documentDate: "1992-10-08",
      pages: 1,
      excerpt:
        "A 1700 hours update tabulates questions answered on Iran-Contra by the Vice President.",
      evidence:
        "Itemized from an Iran-Contra update heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "more-handwritten-one-liners",
      documentType: "Handwritten Debate Notes",
      category: "debate-prep-one-liners",
      disposition: "itemized-debate-prep-one-liners",
      title: "Handwritten debate one-liners on Vietnam and truthfulness",
      documentDate: "",
      pages: 1,
      excerpt:
        "A handwritten debate-prep page collects one-liners about Vietnam War truthfulness themes.",
      evidence:
        "Itemized from a Bush Library photocopy handwritten one-liners page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "provost-siller-more-one-liners",
      documentType: "Memorandum",
      category: "debate-prep-one-liners",
      disposition: "itemized-debate-prep-one-liners",
      title: "Memorandum from Steve Provost and Ray Siller to the President re More One-Liners",
      documentDate: "1992-10-08",
      pages: 1,
      excerpt:
        "Steve Provost and Ray Siller send the President additional one-liners for debate use.",
      evidence:
        "Itemized from a memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "debate-contd-fax-one-liners-promises",
      documentType: "Faxed Debate Prep",
      category: "debate-prep-one-liners",
      disposition: "itemized-debate-prep-one-liners",
      title: "Fax to Christina Martin: Debate continued, one-liners and promises",
      documentDate: "",
      pages: 3,
      excerpt:
        "A fax to Christina Martin includes continued debate one-liners and promises talking-point material.",
      evidence:
        "Itemized from fax and Debate Cont'd headings found in full-PDF OCR of the NARA direct folder scan.",
    },
  ],
  470418144: [
    {
      slug: "linda-price-routing-and-correspondence",
      documentType: "Routing Note and Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Rose Zamaria routing note and Linda A. Price correspondence",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "Rose Zamaria asks that Linda A. Price be called regarding a note; the page includes Price's 24 Hour Wrecker Service contact information and handwritten routing marks.",
      evidence:
        "Itemized from the White House routing page and Price letterhead found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "apn-daily-briefing-october-21-1992",
      documentType: "Daily Political Briefing",
      category: "daily-political-briefing-item",
      disposition: "itemized-daily-political-briefing",
      title: "The Daily Briefing on American Politics: Wednesday, October 21, 1992",
      documentDate: "1992-10-21",
      pages: 24,
      excerpt:
        "The American Political Network daily briefing includes White House, Clinton, Perot, Iraq, debates, state polling, Senate, House, and television-monitor sections.",
      evidence:
        "Itemized from The Daily Briefing on American Politics heading, APN Bulletin Board, and Hotline sections found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "october-21-telephone-memoranda",
      documentType: "Telephone Memoranda",
      category: "telephone-log-item",
      disposition: "itemized-telephone-log",
      title: "White House telephone memoranda and Signal Switchboard log: October 21, 1992",
      documentDate: "1992-10-21",
      pages: 2,
      excerpt:
        "White House telephone memoranda record October 21 calls including Richard Allen, Prime Minister Brian Mulroney, Barbara Bush, Michael Boskin, Roger Ailes, Robert Mosbacher, James Baker, Nicholas Brady, and others.",
      evidence:
        "Itemized from White House telephone memorandum and Signal Switchboard headings found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "october-21-presidential-movements",
      documentType: "Presidential Movements",
      category: "presidential-movements-item",
      disposition: "itemized-presidential-movements",
      title: "Presidential Movements: Raleigh and North Carolina campaign stops, October 21, 1992",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The movements log tracks the President through Raleigh, the Waffle House, North Carolina campaign stops, and State Fair events on October 21.",
      evidence:
        "Itemized from a Presidential Movements heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "huda-bingham-jones-presidential-scholars-appointment",
      documentType: "Appointment Release",
      category: "appointment-release",
      disposition: "itemized-appointment-release",
      title: "Appointment release: Huda Bingham Jones to the Commission on Presidential Scholars",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The President announces his intention to appoint Huda Bingham Jones, of Kentucky, to be a member of the Commission on Presidential Scholars.",
      evidence:
        "Itemized from an Office of the Press Secretary appointment release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "john-harriman-national-advisory-council-public-service",
      documentType: "Appointment Release",
      category: "appointment-release",
      disposition: "itemized-appointment-release",
      title: "Appointment release: John H. Harriman to the National Advisory Council on the Public Service",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The President announces his intention to appoint John H. Harriman, of California, as a public member of the National Advisory Council on the Public Service.",
      evidence:
        "Itemized from an Office of the Press Secretary appointment release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "genesis-womens-shelter-point-of-light",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press Release: Genesis Women's Shelter volunteers recognized as 929th Daily Point of Light",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The President recognizes the volunteers of Genesis Women's Shelter of Dallas, Texas, as the 929th Daily Point of Light.",
      evidence:
        "Itemized from an Office of the Press Secretary Daily Point of Light release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "bill-signing-release-october-21-1992",
      documentType: "Press Release",
      category: "press-release-item",
      disposition: "itemized-press-release",
      title: "Press Release: President signs H.R. 5237, H.R. 5739, and H.R. 3665",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The White House announces the President's signing of H.R. 5237 on Rural Electrification Administration loan prepayment, H.R. 5739 on Export-Import Bank and export promotion programs, and H.R. 3665 creating Little River Canyon National Preserve.",
      evidence:
        "Itemized from an Office of the Press Secretary bill-signing release found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "memorandum-of-disapproval-jena-band-choctaws",
      documentType: "Memorandum of Disapproval",
      category: "presidential-message",
      disposition: "itemized-presidential-message",
      title: "Memorandum of Disapproval for S. 3095, Jena Band of Choctaws of Louisiana Restoration Act",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "The President withholds approval of S. 3095, arguing that recognition of the Jena Band of Choctaws should proceed through the established Federal acknowledgement process.",
      evidence:
        "Itemized from the Memorandum of Disapproval heading found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "executive-order-iraqi-assets-domestic-banks",
      documentType: "Executive Order",
      category: "executive-order",
      disposition: "itemized-executive-order",
      title: "Executive Order: Transfer of Certain Iraqi Government Assets Held by Domestic Banks",
      documentDate: "1992-10-21",
      pages: 2,
      excerpt:
        "The executive order directs actions to transfer certain blocked Iraqi government funds and assets held by domestic banks under U.N. Security Council Resolution 778.",
      evidence:
        "Itemized from the Executive Order heading and continuation page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "alan-reynolds-worst-lies-economy-column",
      documentType: "Press Column",
      category: "campaign-press-article",
      disposition: "itemized-campaign-press-article",
      title: "Alan Reynolds column: The Worst Lies About the Economy in the Past 50 Years",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "A clipped Alan Reynolds column argues that Bill Clinton's debate claims about the economy are inaccurate.",
      evidence:
        "Itemized from the clipped column page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "october-21-presidential-schedule",
      documentType: "Presidential Schedule",
      category: "presidential-schedule-item",
      disposition: "itemized-presidential-schedule",
      title: "Schedule of the President: Wednesday, October 21, 1992",
      documentDate: "1992-10-21",
      pages: 2,
      excerpt:
        "The schedule lists the President's October 21 whistlestop and North Carolina events, including Spartanburg, Gastonia, Kannapolis, Thomasville, Burlington, and Raleigh.",
      evidence:
        "Itemized from Schedule of the President pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "electronic-industries-association-recommended-call",
      documentType: "Recommended Telephone Call",
      category: "recommended-call-item",
      disposition: "itemized-recommended-telephone-call",
      title: "Recommended telephone call to Electronic Industries Association Board of Governors",
      documentDate: "1992-10-21",
      pages: 3,
      excerpt:
        "The recommended-call packet asks the President to call the Electronic Industries Association Board of Governors to thank the industry for support and discuss exports, R&D, tax policy, high-tech employment, and endorsements.",
      evidence:
        "Itemized from recommended-call pages and a Situation Room fax cover sheet found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "baker-choice-november-third-draft-remarks",
      documentType: "Memorandum and Remarks Draft",
      category: "campaign-remarks-draft",
      disposition: "itemized-campaign-remarks-draft",
      title: "James A. Baker III memorandum and draft remarks: The Choice on November Third",
      documentDate: "1992-10-20",
      pages: 15,
      excerpt:
        "James A. Baker III sends the President a draft speech titled 'The Choice on November Third: Philosophy, Policy, Character,' arguing for a final contrast with Clinton.",
      evidence:
        "Itemized from a Baker memorandum, attachment marker, and draft-remarks pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "margaret-tutwiler-handwritten-note",
      documentType: "Handwritten Note",
      category: "handwritten-note-item",
      disposition: "itemized-handwritten-note",
      title: "Handwritten note from Margaret Tutwiler to the President",
      documentDate: "1992-10-21",
      pages: 1,
      excerpt:
        "Margaret Tutwiler thanks the President for kind remarks and encouragement in a handwritten note.",
      evidence:
        "Itemized from the Margaret Tutwiler handwritten note found in rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "october-21-pool-reports-north-carolina",
      documentType: "Pool Reports",
      category: "pool-report-packet",
      disposition: "itemized-pool-report-packet",
      title: "Pool reports: Gastonia, State Fair, and Raleigh, October 21, 1992",
      documentDate: "1992-10-21",
      pages: 3,
      excerpt:
        "Pool reports cover the President at a Gastonia Waffle House, the North Carolina State Fair, and the Raleigh motorcade to the Radisson.",
      evidence:
        "Itemized from Pool Report headings and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mrs-bush-press-clippings-october-21-1992",
      documentType: "Daily Press Clippings",
      category: "daily-press-clippings",
      disposition: "itemized-daily-press-clippings",
      title: "Mrs. Bush's Press Office Daily Press Clippings: Wednesday, October 21, 1992",
      documentDate: "1992-10-21",
      pages: 21,
      excerpt:
        "Mrs. Bush's Press Office clipping packet includes Republican events, ice-cream polling, Clinton flag-burning charges and apologies, Prescott Bush, Hillary Clinton, women in politics, and campaign-family stories.",
      evidence:
        "Itemized from a Mrs. Bush's Press Office Daily Press Clippings cover page and clipping run found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "alec-courtelis-campaign-correspondence",
      documentType: "Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Alec P. Courtelis correspondence packet re final debate and Clinton character issues",
      documentDate: "1992-10-21",
      pages: 4,
      excerpt:
        "The packet includes the President's response to Alec Courtelis, Courtelis's October 19 personal fax, and advice on character arguments after the last debate.",
      evidence:
        "Itemized from George Bush letterhead, Courtelis fax pages, and related correspondence found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "lauren-campaign-train-correspondence",
      documentType: "Correspondence Packet",
      category: "campaign-correspondence",
      disposition: "itemized-campaign-correspondence",
      title: "Lauren correspondence re campaign train and school campaign report",
      documentDate: "1992-10-21",
      pages: 2,
      excerpt:
        "The President writes Lauren about being on the train with her father, a television report, and Lauren's report on the campaign in school, with an incoming handwritten page attached.",
      evidence:
        "Itemized from George Bush letterhead and the attached handwritten page found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "mortgage-discrimination-talking-points",
      documentType: "Talking Points",
      category: "campaign-talking-points",
      disposition: "itemized-campaign-talking-points",
      title: "Mortgage discrimination talking points",
      documentDate: "1992-10-20",
      pages: 1,
      excerpt:
        "Talking points marked as seen by the President address mortgage discrimination, OCC advisories, fair-lending enforcement, and Administration actions.",
      evidence:
        "Itemized from a faxed talking-points page with President Has Seen marking found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "loose-campaign-press-clippings-october-21-1992",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Loose campaign press clippings on debates, Iraq, tax, Clinton, Perot, defense, and the campaign trail",
      documentDate: "1992-10-21",
      pages: 69,
      excerpt:
        "A loose clipping run draws from The Washington Post, The New York Times, Los Angeles Times, The Washington Times, Newsday, and other outlets on the presidential debates, voter anger, tax legislation, Iraq/Kuwait cables, Clinton and Perot, campaign strategy, and military and media issues.",
      evidence:
        "Itemized from a long sequence of newspaper clipping starts, mastheads, and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "us-news-campaign-iraqgate-article-packet",
      documentType: "Magazine Article Packet",
      category: "magazine-article-packet",
      disposition: "itemized-magazine-article-packet",
      title: "U.S. News and World Report campaign and Iraqgate article packet",
      documentDate: "1992-10-21",
      pages: 19,
      excerpt:
        "U.S. News and World Report pages include best-jobs cover material, debate spin, Washington Whispers, Clinton campaign analysis, Iraqgate reporting, and Mortimer Zuckerman's Arrogance of Power editorial.",
      evidence:
        "Itemized from U.S. News and World Report cover/article pages and continuation pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "wall-street-journal-october-21-campaign-economy-articles",
      documentType: "Press Articles",
      category: "press-article-packet",
      disposition: "itemized-press-article-packet",
      title: "Wall Street Journal articles on Clinton, markets, GATT, the Bush campaign, and the economy",
      documentDate: "1992-10-21",
      pages: 9,
      excerpt:
        "The Wall Street Journal packet covers Clinton's compensation-tax position, bond-market expectations, the presidential homestretch, GATT, Bush campaign missteps, and Alan Reynolds on the economy.",
      evidence:
        "Itemized from Wall Street Journal mastheads and article starts found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "education-media-and-broadcasting-clippings",
      documentType: "Press Clippings",
      category: "press-clipping-packet",
      disposition: "itemized-press-clipping-packet",
      title: "Loose education, media, and broadcasting clippings",
      documentDate: "1992-10-21",
      pages: 9,
      excerpt:
        "Loose clippings include USA Today education-policy arguments, taxes and deficit commentary, Time material, Broadcasting articles on television and FCC issues, and media-business pages.",
      evidence:
        "Itemized from USA Today, Time, Broadcasting, and related clipping pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "new-republic-baker-clinton-conservatism-articles",
      documentType: "Magazine Article Packet",
      category: "magazine-article-packet",
      disposition: "itemized-magazine-article-packet",
      title: "New Republic articles on James Baker, Clinton, and conservatism",
      documentDate: "1992-10-21",
      pages: 8,
      excerpt:
        "The New Republic packet includes Sidney Blumenthal on James Baker, Joshua Muravchik on supporting Bill Clinton, and articles on conservatism and the First Amendment.",
      evidence:
        "Itemized from New Republic masthead and article pages found in full-PDF OCR and rendered page review of the NARA direct folder scan.",
    },
    {
      slug: "official-white-house-photo-transfer-pages-october-1992",
      documentType: "Official White House Photographs",
      category: "official-white-house-photographs",
      disposition: "itemized-official-white-house-photographs",
      title: "Official White House photo transfer pages, October 1992",
      documentDate: "1992-10-21",
      pages: 14,
      excerpt:
        "Official White House photo pages and transfer placeholders appear at the end of the direct folder scan, including campaign-event photographs with handwritten location notes.",
      evidence:
        "Itemized from official White House photograph pages and transfer placeholders found in rendered page review of the NARA direct folder scan.",
    },
  ],
  470418164: [
    {
      slug: "manor-house-reception-acceptances",
      documentType: "Acceptance List",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Acceptances for Manor House Reception",
      documentDate: "1992-11-03",
      pages: 2,
      excerpt:
        "An acceptance list for the Manor House reception, updated as of 12:55 p.m. on election day, records family, staff, campaign, and supporter attendees.",
      evidence:
        "Itemized from the Acceptances for Manor House Reception heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "leroy-shaw-chad-photo-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "LeRoy B. Shaw correspondence re Chad photo and campaign support",
      documentDate: "1992-11-03",
      pages: 3,
      excerpt:
        "The President sends LeRoy B. Shaw a signed photo for Chad, wishes Chad well at Duke, and thanks the Shaws for encouragement and support.",
      evidence:
        "Itemized from presidential letter and attached low-confidence incoming pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "presidential-phone-calls-handwritten-note",
      documentType: "Presidential Phone Calls Note",
      category: "presidential-phone-call-note",
      disposition: "itemized-presidential-phone-call-note",
      title: "Presidential Phone Calls handwritten note",
      documentDate: "",
      pages: 1,
      excerpt:
        "A Presidential Phone Calls form appears with George Bush handwriting and brief subject/follow-up fields.",
      evidence:
        "Itemized from the Presidential Phone Calls form and Bush Library handwriting marker found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "concession-address-draft-handwriting",
      documentType: "Speech Draft",
      category: "concession-address",
      disposition: "itemized-concession-address-draft",
      title: "Concession Address draft with George Bush handwriting",
      documentDate: "1992-11-03",
      pages: 13,
      excerpt:
        "A draft of the Houston concession address includes the opening call to Governor Clinton, thanks to campaign and administration leaders, and extensive George Bush handwriting.",
      evidence:
        "Itemized from Concession Address heading, typed speech pages, and George Bush handwriting markers found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "hugh-liedtke-betty-memorial-correspondence",
      documentType: "Incoming Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Hugh Liedtke correspondence re Betty Liedtke memorial service",
      documentDate: "1992-10-29",
      pages: 4,
      excerpt:
        "A President Has Seen incoming letter from Hugh Liedtke thanks George Bush for attending Betty Liedtke's memorial service, with related letterhead and envelope pages.",
      evidence:
        "Itemized from President Has Seen marker, Hugh Liedtke correspondence, and envelope pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "zamaria-secret-service-odonnell-arrival",
      documentType: "Memorandum",
      category: "election-night-event-material",
      disposition: "itemized-election-night-event-material",
      title: "Memorandum from Rose Zamaria to Secret Service re Peter and Edith O'Donnell",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "Rose Zamaria alerts the Secret Service that Peter and Edith O'Donnell are expected that evening and asks that they not be detained.",
      evidence:
        "Itemized from Rose Zamaria memorandum heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-130-update",
      documentType: "News Update",
      category: "news-summary-item",
      disposition: "itemized-news-summary",
      title: "White House News Summary: November 3, 1992 1:30 P.M. CST News Update",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "The 1:30 p.m. CST White House News Summary update covers President Bush in Houston, Clinton voting, the abortion gag-rule decision, women in combat, Iraq/BNL, and Clinton Middle East comments.",
      evidence:
        "Itemized from White House News Summary update heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-1000-update",
      documentType: "News Update",
      category: "news-summary-item",
      disposition: "itemized-news-summary",
      title: "White House News Summary: November 3, 1992 10:00 A.M. CST News Update",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "The 10:00 a.m. CST White House News Summary update covers election-day voting in Houston, the CBS poll, economic indicators, Vice President Quayle, and the Villalpando inquiry.",
      evidence:
        "Itemized from White House News Summary update heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "white-house-news-summary-600-edition",
      documentType: "News Summary",
      category: "news-summary-item",
      disposition: "itemized-news-summary",
      title: "White House News Summary: Tuesday, November 3, 1992 6:00 A.M. EST Edition",
      documentDate: "1992-11-03",
      pages: 21,
      excerpt:
        "The 6:00 a.m. EST White House News Summary compiles election-day trip, national, international, and network news coverage on Bush, Clinton, Perot, voter turnout, and related issues.",
      evidence:
        "Itemized from News Summary heading and A/B-section continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "negative-advertising-response-talking-points",
      documentType: "Talking Points",
      category: "campaign-talking-points",
      disposition: "itemized-campaign-talking-points",
      title: "Talking points re negative advertising and Clinton campaign charges",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "Election-day talking points argue that Bush-Quayle advertisements are documented and accurate while Clinton campaign advertisements are false.",
      evidence:
        "Itemized from numbered advertising-response talking points found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "weinberger-additional-indictment-fact-paper",
      documentType: "Fact Paper",
      category: "iran-contra-material",
      disposition: "itemized-iran-contra-material",
      title: "Fact Paper: The Weinberger Additional Indictment",
      documentDate: "",
      pages: 8,
      excerpt:
        "A fact paper argues that the Weinberger note adds no new facts to the Iran-Contra record and is filed with Congressional Report excerpts and a chronology of Vice President Bush's exposure to the Shultz-Weinberger position.",
      evidence:
        "Itemized from Fact Paper heading, chapter excerpts, and chronology pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "washington-post-iran-contra-president-side-article",
      documentType: "Article",
      category: "iran-contra-material",
      disposition: "itemized-iran-contra-material",
      title: "Washington Post article clipping re the President's side of Iran-Contra",
      documentDate: "",
      pages: 1,
      excerpt:
        "A Washington Post clipping argues that Bush did not know of the Iran-Contra diversion until just before it was revealed and distinguishes the Iran initiative from the diversion.",
      evidence:
        "Itemized from Washington Post clipping text found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "boyden-gray-washington-post-iran-contra-letter",
      documentType: "Letter",
      category: "iran-contra-material",
      disposition: "itemized-iran-contra-material",
      title: "Letter from C. Boyden Gray to the Washington Post editor re Iran-Contra reporting",
      documentDate: "1992-10-14",
      pages: 1,
      excerpt:
        "C. Boyden Gray writes that the Post mischaracterized President Bush's comments to Katie Couric about Iran-Contra and the January 1986 meeting.",
      evidence:
        "Itemized from White House letter heading and signature block found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "iraqgate-key-facts-supporting-material",
      documentType: "Fact Packet",
      category: "iraqgate-material",
      disposition: "itemized-iraqgate-material",
      title: "Key Facts on Iraqgate with supporting CCC and Clinton quotables material",
      documentDate: "",
      pages: 3,
      excerpt:
        "A Key Facts on Iraqgate packet argues there was no cover-up of pre-war Iraq policy and includes supporting material on CCC guarantees and Clinton quotations.",
      evidence:
        "Itemized from Key Facts on Iraqgate heading and adjacent supporting pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-27-louisville",
      documentType: "Pool Report",
      category: "pool-report",
      disposition: "itemized-pool-report",
      title: "Pool Report #27: Air Force One flight from Akron to Louisville",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "Mike Kranish reports on the uneventful Air Force One flight from Akron to Louisville and the motorcade to the rally hangar.",
      evidence:
        "Itemized from Pool Report #27 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-29-president-jogs-votes-shops",
      documentType: "Pool Report",
      category: "pool-report",
      disposition: "itemized-pool-report",
      title: "Pool Report #29: The President jogs, votes, and shops",
      documentDate: "1992-11-03",
      pages: 2,
      excerpt:
        "Pool Report #29 describes President Bush jogging in Memorial Park, voting at St. Mary's Seminary, breakfasting at the Houstonian, shopping, and the planned Manor House reception.",
      evidence:
        "Itemized from Pool Report #29 heading and continuation page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "pool-report-30-houstonian-corridor",
      documentType: "Pool Report",
      category: "pool-report",
      disposition: "itemized-pool-report",
      title: "Pool Report #30: Bush in corridor of Houstonian Hotel",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "Pool Report #30 records President Bush in a Houstonian Hotel corridor at about 6:00 p.m. and his brief comment on how he felt.",
      evidence:
        "Itemized from Pool Report #30 heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "hotline-election-day-reader",
      documentType: "Political Briefing",
      category: "political-briefing",
      disposition: "itemized-political-briefing",
      title: "The Hotline Daily Briefing on American Politics: Election Day Reader",
      documentDate: "1992-11-03",
      pages: 21,
      excerpt:
        "The Hotline election-day briefing compiles final presidential polls, an electoral scoreboard, campaign-final-lap coverage, Senate and House race notes, governors' races, and poll updates.",
      evidence:
        "Itemized from The Hotline Daily Briefing heading, index, and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "presidential-telephone-memorandum-packet",
      documentType: "Telephone Memorandum Packet",
      category: "telephone-log",
      disposition: "itemized-telephone-log",
      title: "Presidential telephone memorandum packet for November 3, 1992",
      documentDate: "1992-11-03",
      pages: 4,
      excerpt:
        "A telephone memorandum packet records election-day calls involving Nicholas Brady, Henry Kissinger, Dan Quayle, James Baker, Marlin Fitzwater, Robert Dole, Brian Mulroney, Bill Clinton, and others.",
      evidence:
        "Itemized from White House Signal Switchboard telephone memorandum pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "presidential-movements-houston",
      documentType: "Presidential Movements",
      category: "presidential-movements",
      disposition: "itemized-presidential-movements",
      title: "Presidential Movements: Houston, Texas, November 3, 1992",
      documentDate: "1992-11-03",
      pages: 1,
      excerpt:
        "The presidential movements sheet records President Bush's Houstonian Hotel, St. Mary's Seminary, shopping, and Westin Galleria movements on election day.",
      evidence:
        "Itemized from Presidential Movements heading found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "bush-quayle-campaign-materials-catalog",
      documentType: "Campaign Materials Catalog",
      category: "campaign-materials",
      disposition: "itemized-campaign-materials",
      title: "Bush-Quayle '92 campaign materials catalog and order form",
      documentDate: "",
      pages: 7,
      excerpt:
        "A Bush-Quayle '92 campaign materials catalog and order form lists lapel stickers, campaign buttons, bumper stickers, yard signs, apparel, and related merchandise.",
      evidence:
        "Itemized from campaign-materials catalog pages and order form found in full-PDF OCR of the NARA direct folder scan.",
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
  470418300: [
    {
      slug: "jake-kamin-houston-dinner-message",
      documentType: "Correspondence and Note Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Jake Kamin dinner message correspondence and presidential note",
      documentDate: "1993-01-14",
      pages: 3,
      excerpt:
        "A White House letter honors Jake Kamin for his Houston civic contributions, with the Sugar Creek National Bank request and a Bush Library photocopy of the President's handwritten proposed message.",
      evidence:
        "Itemized from White House letter, request letter, and Bush handwriting pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "points-of-light-celebration-briefing",
      documentType: "Staffing Memorandum and Briefing",
      category: "points-of-light-material",
      disposition: "itemized-points-of-light-material",
      title: "Staffing memorandum and Jennifer Grossman briefing re Points of Light Celebration",
      documentDate: "1993-01-12",
      pages: 2,
      excerpt:
        "A Staff Secretary routing memorandum forwards Jennifer Grossman's briefing for the President on the January 14 Points of Light Celebration.",
      evidence:
        "Itemized from Staff Secretary routing and Jennifer Grossman memorandum headings found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "points-of-light-celebration-remarks-draft",
      documentType: "Speech Draft",
      category: "points-of-light-material",
      disposition: "itemized-points-of-light-material",
      title: "Draft Presidential Remarks: Points of Light Celebration, January 14, 1993",
      documentDate: "1993-01-08",
      pages: 5,
      excerpt:
        "Draft One of the President's remarks for the Points of Light Celebration lays out a closing tribute to service and volunteerism.",
      evidence:
        "Itemized from the Draft One remarks heading and continuation pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "louise-mead-walker-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Louise Mead Walker correspondence re Dorothy Walker Bush and leaving office",
      documentDate: "1993-01-14",
      pages: 4,
      excerpt:
        "The President thanks Louise Mead Walker for her January 4 letter about his mother and writes that he and Mrs. Bush will return to Houston in six more days.",
      evidence:
        "Itemized from presidential letter and attached incoming letter pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "lyman-bullard-sympathy-correspondence",
      documentType: "Sympathy Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Mrs. Lyman G. Bullard sympathy correspondence re Dorothy Walker Bush",
      documentDate: "",
      pages: 4,
      excerpt:
        "A White House sympathy-response letter to Mrs. Lyman G. Bullard is filed with attached incoming correspondence about Dorothy Walker Bush.",
      evidence:
        "Itemized from sympathy letter and attached incoming pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "herve-henry-burghard-sympathy-correspondence",
      documentType: "Sympathy Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Mrs. Herve Henry Burghard sympathy correspondence re Dorothy Walker Bush",
      documentDate: "",
      pages: 2,
      excerpt:
        "A White House sympathy-response letter to Mrs. Herve Henry Burghard is filed with an attached incoming note about Dorothy Walker Bush.",
      evidence:
        "Itemized from sympathy letter and attached incoming page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "james-nuzzo-sympathy-correspondence",
      documentType: "Sympathy Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Dr. James L.J. Nuzzo sympathy correspondence re Dorothy Walker Bush",
      documentDate: "",
      pages: 2,
      excerpt:
        "A White House sympathy-response letter to Dr. James L.J. Nuzzo is filed with an attached incoming letter about Dorothy Walker Bush.",
      evidence:
        "Itemized from sympathy letter and attached incoming page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "elizabeth-reeder-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Elizabeth Steakley Reeder correspondence re New Haven friendship",
      documentDate: "1993-01-14",
      pages: 3,
      excerpt:
        "The President thanks Elizabeth Reeder for writing and recalls Bill and Sally Reeder's New Haven friendship with his family.",
      evidence:
        "Itemized from presidential letter and attached Elizabeth Steakley Reeder incoming pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "frederick-cooper-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Frederick E. Cooper correspondence re January 4 letter and loyal support",
      documentDate: "1993-01-14",
      pages: 2,
      excerpt:
        "The President thanks Frederick E. Cooper for his January 4 letter and loyal support, with Cooper's incoming letter attached.",
      evidence:
        "Itemized from presidential letter and attached Frederick E. Cooper incoming page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "donald-hall-arts-humanities-correspondence",
      documentType: "Letter and Incoming Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Donald J. Hall correspondence re Arts and Humanities committee and wedding anniversary",
      documentDate: "1993-01-14",
      pages: 6,
      excerpt:
        "The President thanks Donald J. Hall and Adele Hall for their support, with duplicate copies of Hall's January 6 correspondence about the President's Committee on the Arts and Humanities and the Halls' wedding anniversary.",
      evidence:
        "Itemized from presidential letter, Donald J. Hall incoming letters, and duplicate-copy pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "joseph-zappala-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Joseph Zappala correspondence re loyal support and Houston address",
      documentDate: "1993-01-14",
      pages: 3,
      excerpt:
        "The President thanks Joseph Zappala for his note and loyal support and gives the Houston address for future correspondence.",
      evidence:
        "Itemized from presidential letter and attached Joseph Zappala incoming pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "wendy-walker-whitworth-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Wendy Walker Whitworth correspondence re White House work and future plans",
      documentDate: "1993-01-14",
      pages: 3,
      excerpt:
        "The President tells Wendy Walker Whitworth it has been a joy to work with her and wishes her well in her future job and married life.",
      evidence:
        "Itemized from presidential letter and attached incoming pages, including CBS White House Producer text, found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "kenneth-duberstein-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Kenneth M. Duberstein correspondence re two notes to the President",
      documentDate: "1993-01-14",
      pages: 4,
      excerpt:
        "The President thanks Kenneth M. Duberstein for two notes, with low-confidence attachment and blank/photocopy pages retained in the packet.",
      evidence:
        "Itemized from presidential letter and attached low-confidence OCR pages found in the NARA direct folder scan.",
    },
    {
      slug: "scott-turow-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Scott Turow correspondence re January 3 letter and dinner invitation",
      documentDate: "1993-01-14",
      pages: 3,
      excerpt:
        "The President thanks Scott Turow for his January 3 letter, refers to a dinner invitation, and notes his move to Houston.",
      evidence:
        "Itemized from presidential letter and attached incoming pages found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "frederick-reeder-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Rear Admiral Frederick M. Reeder correspondence re pilots and finishing with style",
      documentDate: "1993-01-14",
      pages: 2,
      excerpt:
        "The President writes Rear Admiral Frederick M. Reeder about pilots and his Houston address; Reeder's January 7 letter thanks the President and Mrs. Bush and urges them to finish with style.",
      evidence:
        "Itemized from presidential letter and Rear Admiral Frederick M. Reeder incoming letter found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "robert-macauley-americares-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Robert C. Macauley AmeriCares correspondence re Christmas Day letter",
      documentDate: "1993-01-14",
      pages: 2,
      excerpt:
        "The President thanks Robert C. Macauley for his Christmas Day letter and praises Macauley's service to mankind through AmeriCares.",
      evidence:
        "Itemized from presidential letter and AmeriCares incoming letter found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "jw-lander-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "J.W. Lander Jr. correspondence re returning to Houston and golf",
      documentDate: "1993-01-14",
      pages: 2,
      excerpt:
        "The President writes J.W. Lander Jr. about coming back to Houston and golfing, with Lander's incoming letter attached.",
      evidence:
        "Itemized from presidential letter and attached J.W. Lander Jr. incoming page found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "terrence-boye-prescott-bush-correspondence",
      documentType: "Letter and Incoming Correspondence Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Terrence Boye and Prescott Bush correspondence re class vote and presidential photo",
      documentDate: "1993-01-14",
      pages: 5,
      excerpt:
        "The President thanks Terrence Boye for his visit and class vote, sends a picture with Ranger, and the packet includes Prescott Bush Resources correspondence requesting the note.",
      evidence:
        "Itemized from presidential letter, child incoming-letter pages, and Prescott Bush Resources request letter found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "ethel-creeger-camp-david-fish-pond-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Ethel Creeger correspondence re fish pond at Camp David",
      documentDate: "1992-12-15",
      pages: 3,
      excerpt:
        "Ethel Creeger writes about the fish in the pond at Camp David, Mrs. Bush, and the transition from President Bush to President-elect Clinton.",
      evidence:
        "Itemized from cover note, attached note page, and Ethel Creeger's December 15 incoming letter found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "roger-whittaker-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Roger Whittaker correspondence",
      documentDate: "",
      pages: 2,
      excerpt:
        "A correspondence packet addressed to Roger Whittaker in London appears with an attached low-confidence incoming or note page.",
      evidence:
        "Itemized from address page and attached low-confidence OCR page found in the NARA direct folder scan.",
    },
    {
      slug: "richard-perryman-painting-correspondence",
      documentType: "Correspondence and Note Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Richard N. Perryman painting correspondence",
      documentDate: "",
      pages: 2,
      excerpt:
        "A correspondence packet for Richard N. Perryman concerns a watercolor painting sent to Houston, with an explanatory note on Perryman's Army illustrator work for the NSC.",
      evidence:
        "Itemized from address note and explanatory painting note found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "charles-price-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Mrs. Charles H. Price III correspondence",
      documentDate: "",
      pages: 2,
      excerpt:
        "A correspondence packet addressed to Mrs. Charles H. Price III is filed with an attached low-confidence note or incoming page.",
      evidence:
        "Itemized from address page and attached low-confidence OCR page found in the NARA direct folder scan.",
    },
    {
      slug: "mee-lee-north-china-restaurant-correspondence",
      documentType: "Letter and Note Packet",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Mrs. Mee Lee North China Restaurant correspondence re final meal invitation",
      documentDate: "1993-01-14",
      pages: 2,
      excerpt:
        "The President thanks Mrs. Mee Lee for her phone call, explains that he cannot enjoy her husband's meal before leaving office, and wishes her a Happy Chinese New Year.",
      evidence:
        "Itemized from presidential letter and attached note about Man Kit Lee of North China Restaurant found in full-PDF OCR of the NARA direct folder scan.",
    },
    {
      slug: "nancy-dickerson-whitehead-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Nancy Dickerson Whitehead correspondence",
      documentDate: "",
      pages: 2,
      excerpt:
        "A correspondence packet addressed to Nancy Dickerson Whitehead appears with an attached low-confidence note or incoming page.",
      evidence:
        "Itemized from address page and attached low-confidence OCR page found in the NARA direct folder scan.",
    },
    {
      slug: "mill-reef-club-antigua-correspondence",
      documentType: "Letter and Incoming Correspondence",
      category: "presidential-correspondence",
      disposition: "itemized-presidential-correspondence",
      title: "Mill Reef Club Antigua correspondence",
      documentDate: "",
      pages: 2,
      excerpt:
        "A Mill Reef Club correspondence packet from Antigua appears at the end of the January 14 direct scan.",
      evidence:
        "Itemized from Mill Reef Club letterhead pages and low-confidence OCR found in the NARA direct folder scan.",
    },
  ],
};

const DIRECT_SCAN_FULL_MANUAL_ITEMIZATION_NAIDS = new Set([
  "470417059",
  "470417119",
  "470417135",
  "470417151",
  "470417227",
  "470417253",
  "470417305",
  "470417364",
  "470417389",
  "470417446",
  "470417483",
  "470417505",
  "470417565",
  "470418083",
]);

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
  if (DIRECT_SCAN_FULL_MANUAL_ITEMIZATION_NAIDS.has(folder.naId)) {
    return [packetDoc, ...buildDirectSupplementalItemDocuments(folder, packetDoc)];
  }
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
