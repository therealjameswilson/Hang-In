import { mkdir, readFile, writeFile } from "node:fs/promises";

const SEEN_DOCUMENTS_DATA = "assets/data/seen-documents.js";
const OUTFILE = "reports/coverage-audit.json";

function decodeSeenDocuments(source) {
  const prefix = "window.HANG_IN_SEEN_DOCUMENTS = ";
  if (!source.startsWith(prefix)) {
    throw new Error(`${SEEN_DOCUMENTS_DATA} does not contain the expected global assignment.`);
  }
  return JSON.parse(source.slice(prefix.length).replace(/;\s*$/, ""));
}

function countBy(items, getter) {
  return items.reduce((acc, item) => {
    const key = getter(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  const data = decodeSeenDocuments(await readFile(SEEN_DOCUMENTS_DATA, "utf8"));
  const representedFolderIds = new Set(data.documents.map((doc) => doc.folderId));
  const directScanRecords = data.documents.filter(
    (doc) => doc.evidenceStatus === "direct-folder-scan"
  );
  const unrepresentedFolders = data.folders.filter((folder) => !representedFolderIds.has(folder.id));

  const audit = {
    generatedAt: new Date().toISOString(),
    dateRange: data.metadata.dateRange,
    summary: {
      folderCount: data.metadata.folderCount,
      documentCount: data.metadata.documentCount,
      redactionSheetDocumentCount: data.metadata.redactionSheetDocumentCount,
      directFolderScanCount: data.metadata.directFolderScanCount,
      foldersWithoutParsedRows: data.metadata.foldersWithoutParsedRows,
      foldersStillUnrepresented: data.metadata.foldersStillUnrepresented,
    },
    directScanCategoryCounts: countBy(directScanRecords, (doc) => doc.directScanCategory),
    auditNote:
      "Direct folder scans keep source material visible when no numbered withdrawal/redaction-sheet rows were parsed. They should be itemized page by page before treating this as exhaustive document-by-document coverage.",
    directScanRecords: directScanRecords.map((doc) => ({
      date: doc.seenDate,
      title: doc.title,
      naId: doc.folderNaId,
      folderId: doc.folderLocalId,
      containerId: doc.folderContainerId,
      category: doc.directScanCategory,
      type: doc.documentType,
      catalogUrl: doc.catalogUrl,
      pdfUrl: doc.pdfUrl,
      excerpt: doc.excerpt,
      needsItemization: Boolean(doc.needsItemization),
    })),
    unrepresentedFolders: unrepresentedFolders.map((folder) => ({
      date: folder.date,
      title: folder.title,
      naId: folder.naId,
      folderId: folder.localId,
      containerId: folder.containerId,
      catalogUrl: folder.catalogUrl,
      pdfUrl: folder.pdfUrl,
    })),
  };

  await mkdir("reports", { recursive: true });
  await writeFile(OUTFILE, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(
    `Wrote ${directScanRecords.length} direct-scan records and ${unrepresentedFolders.length} unrepresented folders to ${OUTFILE}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
