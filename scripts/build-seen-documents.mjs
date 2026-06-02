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
  const match = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : Number(folderDate.slice(0, 4));
  if (year < 100) year += year > 80 ? 1900 : 2000;
  if (!month || !day || !year) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
  const lower = text.toLowerCase();
  const title = folder.title.toLowerCase();

  if (/magazines/.test(title)) return "magazine-issue";
  if (/telephone memorandum|signal switchboard|telephone log/.test(lower)) return "telephone-log";
  if (/remarks by the president|address|speech|statement by the press secretary/.test(lower)) {
    return "speech-material";
  }
  if (/\bletter\b|^dear |[\n ]dear /.test(lower)) return "letter-packet";
  if (/the president has seen|memorandum for the president|memorandum to john h\. sununu|subject:/.test(lower)) {
    return "memorandum-packet";
  }
  if (/luncheon|dinner|reception|schedule|arrival|departure|participants|guest list|program/.test(lower)) {
    return "event-packet";
  }
  if (/upi|associated press|reuters|white house reporter|newspaper|washington post|new york times|editorials/.test(lower)) {
    return "press-article";
  }
  if (/response of the administration|report|overview|transmitted to the congress|issues update/.test(lower)) {
    return "report-packet";
  }
  return "direct-scan";
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

function buildDirectScanDocument(text, folder) {
  const contentLines = contentLinesFromText(text);
  if (!contentLines.length) return null;

  const category = classifyDirectScan(folder, contentLines);
  const typeLabel = DIRECT_SCAN_TYPES[category] || DIRECT_SCAN_TYPES["direct-scan"];
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
    needsItemization: true,
    citation: `George H. W. Bush Papers, Presidential Daily Files, ${folder.title}, direct folder scan, National Archives Catalog NAID ${folder.naId}.`,
  };
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
    const directScanDoc =
      text && !redactionSheetDocs.length ? buildDirectScanDocument(text, enrichedFolder) : null;
    const docs = redactionSheetDocs.length ? redactionSheetDocs : directScanDoc ? [directScanDoc] : [];
    results[index] = {
      folder: enrichedFolder,
      documentCount: docs.length,
      redactionSheetDocumentCount: redactionSheetDocs.length,
      directFolderScanCount: directScanDoc ? 1 : 0,
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

  const payload = {
    metadata: {
      title: "Hang In: Documents Listed in the Presidential Daily Files",
      generatedAt: new Date().toISOString(),
      dateRange: `${RANGE_START}/${RANGE_END}`,
      folderCount: parsedFolders.length,
      documentCount: documents.length,
      redactionSheetDocumentCount,
      directFolderScanCount,
      foldersWithNoText,
      foldersWithoutParsedRows,
      foldersStillUnrepresented,
      foldersWithNoDocuments: foldersWithoutParsedRows,
      directScanCategoryCounts,
      coverageNote:
        "Document records include numbered NARA withdrawal/redaction-sheet rows plus folder-level direct-scan records when OCR contains source material but no parsable numbered rows. Direct-scan records may contain multiple items and require page-level itemization before claiming exhaustive document-by-document coverage.",
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
