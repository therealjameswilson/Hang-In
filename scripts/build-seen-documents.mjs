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
  return /^(n\.d\.|ne|no date|\d{1,2}\/\d{1,2}(?:\/(?:\d{2,4}|\[\d{2}\]))?|\d{1,2}\/\d{2}|\d{2}\/\d{2}\]?)$/i.test(
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
  if (/^n\.d\.|ne|no date$/i.test(clean)) return "";
  const match = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : Number(folderDate.slice(0, 4));
  if (year < 100) year += year > 80 ? 1900 : 2000;
  if (!month || !day || !year) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDocStart(line) {
  const match = line.match(/^(\d{1,3}[a-z]?)\.\s+(.+)$/i);
  if (!match) return null;
  const type = cleanLine(match[2]);
  if (/^(schedule|log|report|note|memo|memorandum|talking points|letter|cable|summary|list|coversheet|agenda|fax|form|map|chart|photograph|press release|briefing|statement|speech|draft|directive|telegram|message|article|newspaper|magazine|book|card|index cards|diagram|transcript|telephone log|schedule of the president)/i.test(type)) {
    return { number: match[1], type };
  }
  return null;
}

function parseDocumentBlock(lines, folder) {
  const start = parseDocStart(lines[0]);
  if (!start) return null;

  const titleLines = [];
  const restrictionLines = [];
  const classificationLines = [];
  let dateRaw = "";
  let sawColumnValue = false;

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
    if (sawColumnValue) continue;
    titleLines.push(line);
  }

  const title = normalizeWhitespace(titleLines.join(" "))
    .replace(/\s+\(\s+/g, " (")
    .replace(/\s+\)/g, ")");
  if (!title || /^page \d+ of \d+$/i.test(title)) return null;

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
    const docs = text ? parseDocumentsFromText(text, enrichedFolder) : [];
    results[index] = {
      folder: enrichedFolder,
      documentCount: docs.length,
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
      ? a.documentNumber.localeCompare(b.documentNumber, undefined, { numeric: true })
      : a.date.localeCompare(b.date)
  );
  const foldersWithNoText = parsedFolders.filter((entry) => !entry.hasExtractedText).length;
  const foldersWithNoDocuments = parsedFolders.filter(
    (entry) => entry.hasExtractedText && entry.documentCount === 0
  ).length;

  const payload = {
    metadata: {
      title: "Hang In: Documents Listed in the Presidential Daily Files",
      generatedAt: new Date().toISOString(),
      dateRange: `${RANGE_START}/${RANGE_END}`,
      folderCount: parsedFolders.length,
      documentCount: documents.length,
      foldersWithNoText,
      foldersWithNoDocuments,
      coverageNote:
        "Document records are parsed from NARA Catalog extracted text for Presidential Daily File withdrawal/redaction sheets. They identify documents listed in the folders but do not prove that every document is fully digitized or readable.",
      source: "NARA Catalog proxy records with digital object extracted text.",
    },
    folders: parsedFolders.map(({ folder, documentCount, hasExtractedText }) => ({
      ...folder,
      documentCount,
      hasExtractedText,
    })),
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
