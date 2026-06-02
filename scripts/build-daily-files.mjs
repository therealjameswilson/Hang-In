import { mkdir, writeFile } from "node:fs/promises";

const BASE_URL =
  "https://www.bush41library.gov/digital-research-room/search";
const FILTER = "presidential_daily_type:Presidential Daily Files";
const OUTFILE = "assets/data/daily-files.js";
const RANGE_START = "1991-02-28";
const RANGE_END = "1993-01-20";

const chapters = [
  {
    id: "gulf-war-settlement",
    title: "Gulf War Settlement",
    dateRange: "February 28-April 11, 1991",
    start: "1991-02-28",
    end: "1991-04-11",
    question:
      "How victory in Kuwait became an argument about American power, coalition discipline, and limits.",
  },
  {
    id: "victory-afterlife",
    title: "After Victory",
    dateRange: "April 12-August 18, 1991",
    start: "1991-04-12",
    end: "1991-08-18",
    question:
      "How the administration tried to convert success abroad into order at home and abroad.",
  },
  {
    id: "soviet-endgame",
    title: "Soviet Endgame",
    dateRange: "August 19-December 31, 1991",
    start: "1991-08-19",
    end: "1991-12-31",
    question:
      "How the White House watched an adversary become a set of diplomatic, nuclear, and historical questions.",
  },
  {
    id: "economy-contestation",
    title: "Economy and Contestation",
    dateRange: "January 1-June 30, 1992",
    start: "1992-01-01",
    end: "1992-06-30",
    question:
      "How recession, recovery, trade, taxes, and the early campaign reshaped the presidency.",
  },
  {
    id: "campaign-continuity",
    title: "Campaign of Continuity",
    dateRange: "July 1-November 3, 1992",
    start: "1992-07-01",
    end: "1992-11-03",
    question:
      "How an incumbent made the case for stewardship against exhaustion, insurgency, and change.",
  },
  {
    id: "transition-accounting",
    title: "Transition and Accounting",
    dateRange: "November 4, 1992-January 20, 1993",
    start: "1992-11-04",
    end: "1993-01-20",
    question:
      "How defeat turned into transfer, memory, personnel, and the final ordering of papers.",
  },
];

const monthNames = new Map([
  ["jan", 1],
  ["january", 1],
  ["januari", 1],
  ["feb", 2],
  ["february", 2],
  ["februari", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["juli", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["septemb", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
  ["decemb", 12],
]);

const monthPattern = Array.from(monthNames.keys())
  .sort((a, b) => b.length - a.length)
  .join("|");

function searchUrl(page = 0) {
  const params = new URLSearchParams();
  params.set("f[0]", FILTER);
  params.set("page", String(page));
  return `${BASE_URL}?${params.toString()}`;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " "));
}

function titleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bH\. W\.\b/g, "H. W.");
}

function normalizeTitle(value) {
  return value
    .replace(/\bJanuari\b/g, "January")
    .replace(/\bFebruari\b/g, "February")
    .replace(/\bJuli\b/g, "July")
    .replace(/\bSeptemb\b/g, "September")
    .replace(/\bDecemb\b/g, "December")
    .replace(/^Magazin\b/g, "Magazines")
    .replace(/\s+(\d{4})\s+(\d+)$/g, " $1 [$2]");
}

function parseDate(text) {
  const match = text
    .toLowerCase()
    .match(new RegExp(`\\b(${monthPattern})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`));
  if (!match) return null;
  const month = monthNames.get(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extract(pattern, text) {
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function getChapter(date) {
  return (
    chapters.find((chapter) => date >= chapter.start && date <= chapter.end) ||
    chapters[chapters.length - 1]
  );
}

const chapterThemeMap = new Map([
  ["gulf-war-settlement", [{ id: "gulf-war", label: "Gulf War" }]],
  ["victory-afterlife", [{ id: "foreign-policy", label: "Foreign Policy" }]],
  ["soviet-endgame", [{ id: "soviet-union", label: "Soviet Union" }]],
  ["economy-contestation", [{ id: "domestic-economy", label: "Domestic Economy" }]],
  ["campaign-continuity", [{ id: "campaign-1992", label: "1992 Campaign" }]],
  ["transition-accounting", [{ id: "transition", label: "Transition" }]],
]);

const chapterSearchTerms = new Map([
  ["gulf-war-settlement", ["Kuwait", "Iraq", "Desert Storm", "Saddam", "Coalition", "Cease-fire"]],
  ["victory-afterlife", ["New World Order", "Europe", "Middle East", "Congress", "Foreign Policy"]],
  ["soviet-endgame", ["Gorbachev", "Yeltsin", "Soviet", "USSR", "Russia", "Ukraine", "Nuclear"]],
  ["economy-contestation", ["Economy", "Budget", "Tax", "Recession", "Unemployment", "NAFTA"]],
  ["campaign-continuity", ["Campaign", "Election", "Clinton", "Perot", "Convention", "Polls"]],
  ["transition-accounting", ["Transition", "President-elect", "Clinton", "Inaugural", "Personnel"]],
]);

function uniqueTerms(terms) {
  return Array.from(new Set(terms.filter(Boolean)));
}

function getThemes(recordText, chapterId) {
  const text = recordText.toLowerCase();
  const themes = [...(chapterThemeMap.get(chapterId) || [])];
  const checks = [
    ["gulf-war", "Gulf War", /\b(kuwait|iraq|desert storm|saddam|coalition|cease[- ]?fire)\b/],
    ["soviet-union", "Soviet Union", /\b(gorbachev|yeltsin|soviet|ussr|russia|ukraine|nuclear)\b/],
    ["domestic-economy", "Domestic Economy", /\b(economy|economic|budget|tax|recession|unemployment|recovery|deficit)\b/],
    ["campaign-1992", "1992 Campaign", /\b(campaign|election|clinton|perot|poll|convention|republican national committee)\b/],
    ["trade", "Trade", /\b(nafta|trade|mexico|canada|exports|tariff)\b/],
    ["transition", "Transition", /\b(transition|inaugural|inauguration|president-elect|clinton)\b/],
  ];
  for (const [id, label, pattern] of checks) {
    if (pattern.test(text)) themes.push({ id, label });
  }
  return Array.from(new Map(themes.map((theme) => [theme.id, theme])).values());
}

function getKeywords(recordText) {
  const text = recordText.toLowerCase();
  const terms = [
    "Baker",
    "Scowcroft",
    "Cheney",
    "Gorbachev",
    "Yeltsin",
    "Soviet",
    "USSR",
    "Russia",
    "Ukraine",
    "Nuclear",
    "Kuwait",
    "Iraq",
    "Desert Storm",
    "Saddam",
    "Coalition",
    "Clinton",
    "Perot",
    "Campaign",
    "Election",
    "NAFTA",
    "Mexico",
    "Canada",
    "Budget",
    "Tax",
    "Recession",
    "Unemployment",
    "Transition",
    "Inaugural",
  ];
  return terms.filter((term) =>
    new RegExp(`\\b${term.toLowerCase().replace(/ /g, "[- ]?")}\\b`).test(text)
  );
}

function getSearchTerms(recordText, chapterId) {
  return uniqueTerms([...getKeywords(recordText), ...(chapterSearchTerms.get(chapterId) || [])]);
}

function parseRows(html) {
  return html
    .split('<div class="views-row">')
    .slice(1)
    .map((chunk) => {
      const titleMatch = chunk.match(
        /views-field-aggregated-field-title[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>/
      );
      if (!titleMatch) return null;

      const excerptMatch = chunk.match(
        /views-field-search-api-excerpt[\s\S]*?<span class="field-content">([\s\S]*?)<\/span>/
      );

      const catalogUrl = decodeEntities(titleMatch[1]);
      const rawTitle = stripHtml(titleMatch[2]);
      const title = normalizeTitle(
        titleCase(rawTitle)
          .replace(/\bIi\b/g, "II")
          .replace(/\bIii\b/g, "III")
      );
      const excerpt = excerptMatch ? stripHtml(excerptMatch[1]) : "";
      const date = parseDate(title) || parseDate(excerpt);
      if (!date || date < RANGE_START || date > RANGE_END) return null;

      const localId =
        extract(/Folder ID Number:\s*([0-9-]+)/i, excerpt) ||
        extract(/Local ID\s+([0-9-]+)/i, excerpt);
      const containerId =
        extract(/Container ID\s+([0-9]+)/i, excerpt) ||
        extract(/OA\/ID Number:\s*([0-9]+)/i, excerpt);
      const foia = extract(/FOIA Number:\s*([A-Z0-9-[\]]+)/i, excerpt);
      const naId = catalogUrl.split("/").pop();
      const chapter = getChapter(date);
      const isMagazine = /^magazines?,/i.test(title);
      const recordText = `${title} ${excerpt}`;

      return {
        id: `nara-${naId}`,
        naId,
        title,
        date,
        year: date.slice(0, 4),
        month: date.slice(0, 7),
        type: isMagazine ? "Presidential Daily File: Magazines" : "Presidential Daily File",
        chapterId: chapter.id,
        chapter: chapter.title,
        themes: getThemes(recordText, chapter.id),
        keywords: getKeywords(recordText),
        searchTerms: getSearchTerms(recordText, chapter.id),
        localId,
        containerId,
        foia: foia || "2009-0166-S",
        catalogUrl,
        sourceUrl: searchUrl(0),
        citation: `George H. W. Bush Papers, Presidential Daily Files, ${title}, National Archives Catalog NAID ${naId}.`,
      };
    })
    .filter(Boolean);
}

async function fetchPage(page) {
  const response = await fetch(searchUrl(page), {
    headers: {
      "User-Agent":
        "Hang-In research index builder (metadata only; contact via GitHub repository)",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed page ${page}: ${response.status}`);
  }
  return response.text();
}

async function main() {
  const firstHtml = await fetchPage(0);
  const totalMatch = firstHtml.match(/Displaying\s+1\s+-\s+\d+\s+of\s+(\d+)\s+results/i);
  const total = totalMatch ? Number(totalMatch[1]) : 2192;
  const pageCount = Math.ceil(total / 30);

  const records = [];
  for (let page = 0; page < pageCount; page += 1) {
    const html = page === 0 ? firstHtml : await fetchPage(page);
    records.push(...parseRows(html));
    process.stdout.write(`Fetched ${page + 1}/${pageCount}\r`);
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  process.stdout.write("\n");

  const unique = Array.from(
    new Map(records.map((record) => [record.naId, record])).values()
  ).sort((a, b) =>
    a.date === b.date
      ? a.title.localeCompare(b.title)
      : a.date.localeCompare(b.date)
  );

  const payload = {
    metadata: {
      title: "Hang In: Primary Documents for the Late Bush Presidency",
      dateRange: `${RANGE_START}/${RANGE_END}`,
      generatedAt: new Date().toISOString(),
      recordCount: unique.length,
      source:
        "George H. W. Bush Presidential Library and Museum Digital Research Room; NARA Catalog links for Presidential Daily Files.",
      sourceSearchUrl: searchUrl(0),
      archivesOverviewUrl:
        "https://www.archives.gov/presidential-records/research/presidential-daily-diary",
      catalogSeriesUrl: "https://catalog.archives.gov/id/186322",
    },
    chapters: chapters.map(({ start, end, ...chapter }) => chapter),
    records: unique,
  };

  await mkdir("assets/data", { recursive: true });
  await writeFile(
    OUTFILE,
    `window.HANG_IN_DAILY_FILES = ${JSON.stringify(payload, null, 2)};\n`
  );
  console.log(`Wrote ${unique.length} records to ${OUTFILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
