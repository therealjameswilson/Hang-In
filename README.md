# Hang In

Static GitHub Pages site for organizing primary documents for a book on the
George H. W. Bush presidency from February 28, 1991, through January 20, 1993.

The site is designed as an archive workbench: search, filter, cite, and open
NARA Catalog records while keeping the source documents at the National
Archives. It now includes a document-level index parsed from NARA Catalog
extracted text for the Presidential Daily File withdrawal/redaction sheets.

## Sources

- George H. W. Bush Presidential Library and Museum Digital Research Room:
  Presidential Daily Files
- National Archives Catalog record for the Presidential Daily Diary collection
- NARA Presidential Daily Diary research overview

The generated Daily File folder index is lightweight metadata only: title, date,
catalog ID, chapter grouping, folder/container hints, FOIA number, and citation.
The generated document index adds document number, type, title, seen/filed date,
document date when available, page count, restriction/classification hints, PDF
URL, and citation.

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
rows, and writes `assets/data/seen-documents.js`. Catalog responses are cached
under `.cache/catalog-records/`, which is ignored by Git.

The parser is intentionally conservative: it includes rows that look like
document entries in the withdrawal/redaction sheets and reports how many folders
had OCR but no parsable document rows. This is evidence of document-level
coverage, not a claim that every page is fully digitized or readable.

## Publish

In the repository settings for `therealjameswilson/Hang-In`, enable GitHub
Pages from the root of the default branch. No build step is required.
