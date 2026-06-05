# Hang In

Static GitHub Pages site for organizing primary documents for a book on the
George H. W. Bush presidency from February 28, 1991, through January 20, 1993.

The site is designed as an archive workbench: search, filter, cite, and open
NARA Catalog records while keeping the source documents at the National
Archives. It now includes a document/source-record index parsed from NARA
Catalog extracted text for the Presidential Daily File withdrawal/redaction
sheets, plus direct folder scans when no numbered sheet rows are present.

## Sources

- George H. W. Bush Presidential Library and Museum Digital Research Room:
  Presidential Daily Files
- National Archives Catalog record for the Presidential Daily Diary collection
- NARA Presidential Daily Diary research overview

The generated Daily File folder index is lightweight metadata only: title, date,
catalog ID, chapter grouping, folder/container hints, FOIA number, and citation.
The generated document index adds document number, type, title, seen/filed date,
document date when available, page count, restriction/classification hints, PDF
URL, and citation. Records have an evidence status:

- `redaction-sheet-listed`: a numbered document row parsed from a NARA
  withdrawal/redaction sheet.
- `direct-folder-scan`: parent packet/source records for folders whose OCR did
  not yield numbered withdrawal/redaction-sheet rows. These parents remain in
  the data so the underlying scan stays visible and auditable.
- `direct-scan-itemized`: a high-confidence child record itemized from direct
  folder-scan OCR markers, cover-memo attachment lists, or full-PDF OCR checks.
  The parent packet remains in the data so residual pages can still be audited.

As of the current audit, all 127 direct packet scans that require itemization
have page-backed `direct-scan-itemized` child records, and no folders in the
document index are unrepresented.

## Update The Daily File Index

```bash
node scripts/build-daily-files.mjs
```

The script reads the public Bush Library Digital Research Room search results,
filters records to `1991-02-28` through `1993-01-20`, and writes
`assets/data/daily-files.js`.

## Update The Document-Level Index

```bash
node scripts/build-seen-documents.mjs
```

The script reads `assets/data/daily-files.js`, queries the NARA Catalog proxy
for each folder's PDF URL and extracted text, parses withdrawal/redaction sheet
rows, adds direct-scan representative records for folders with OCR but no
numbered rows, and writes `assets/data/seen-documents.js`. Catalog responses are
cached under `.cache/catalog-records/`, which is ignored by Git.

The parser is intentionally conservative. After rebuilding the document index,
rerun the coverage audit and check that `foldersStillUnrepresented` remains `0`
and `directItemizedFolderCount` matches `directPacketScanCount`.

Note: the public Bush Library Digital Research Room search can drift or omit
records in a fresh folder-index rebuild. Treat large `daily-files.js` count
changes as a review item before publishing them.

## Update The Coverage Audit

```bash
node scripts/audit-seen-documents.mjs
```

The audit script reads `assets/data/seen-documents.js` and writes
`reports/coverage-audit.json`, including direct-scan records that still need
item-by-item review.

## Publish

GitHub Pages is deployed by `.github/workflows/pages.yml` from the root of the
`main` branch.
