(function () {
  const folderData = window.HANG_IN_DAILY_FILES;
  const documentData = window.HANG_IN_SEEN_DOCUMENTS;
  const records = documentData?.documents?.length ? documentData.documents : folderData?.records || [];
  const folders = documentData?.folders?.length ? documentData.folders : folderData?.records || [];
  const chapters = folderData?.chapters || [];
  const coverage = documentData?.metadata || null;
  const isDocumentIndex = Boolean(documentData?.documents?.length);
  const pageSize = 24;
  const state = {
    query: "",
    chapter: "all",
    theme: "all",
    year: "all",
    type: "all",
    sort: "date-asc",
    page: 1,
    selectedId: records[0]?.id || "",
  };

  const els = {
    heroStats: document.querySelector("#heroStats"),
    searchInput: document.querySelector("#searchInput"),
    chapterFilter: document.querySelector("#chapterFilter"),
    yearFilter: document.querySelector("#yearFilter"),
    typeFilter: document.querySelector("#typeFilter"),
    themeFilter: document.querySelector("#themeFilter"),
    sortControl: document.querySelector("#sortControl"),
    resultCount: document.querySelector("#resultCount"),
    coverageStats: document.querySelector("#coverageStats"),
    monthStrip: document.querySelector("#monthStrip"),
    recordsList: document.querySelector("#recordsList"),
    detailPanel: document.querySelector("#detailPanel"),
    chapterCards: document.querySelector("#chapterCards"),
    pager: document.querySelector("#pager"),
    resetFilters: document.querySelector("#resetFilters"),
  };

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const longDateFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function localDate(isoDate) {
    return new Date(`${isoDate}T12:00:00`);
  }

  function formatDate(isoDate) {
    return dateFormatter.format(localDate(isoDate));
  }

  function formatLongDate(isoDate) {
    return longDateFormatter.format(localDate(isoDate));
  }

  function prettyTitle(title) {
    return title
      .replace(
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) ([A-Z][a-z]+) (\d{1,2}) (\d{4})(.*)$/,
        "$1, $2 $3, $4$5"
      )
      .replace(/^Magazines ([A-Z][a-z]+) (\d{1,2}) (\d{4})(.*)$/, "Magazines, $1 $2, $3$4");
  }

  function countBy(items, getter) {
    return items.reduce((acc, item) => {
      const key = getter(item);
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());
  }

  function allThemes() {
    const counts = new Map();
    records.forEach((record) => {
      record.themes.forEach((theme) => {
        const current = counts.get(theme.id) || { ...theme, count: 0 };
        current.count += 1;
        counts.set(theme.id, current);
      });
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
  }

  function searchHaystack(record) {
    return [
      record.title,
      record.naId,
      record.folderNaId,
      record.localId,
      record.folderLocalId,
      record.containerId,
      record.folderContainerId,
      record.foia,
      record.chapter,
      record.type,
      record.documentNumber,
      record.documentType,
      record.documentDate,
      record.folderTitle,
      record.directScanCategory,
      record.evidenceStatus,
      record.restriction,
      record.classification,
      record.excerpt,
      record.themes.map((theme) => theme.label).join(" "),
      record.keywords?.join(" "),
      record.searchTerms?.join(" "),
    ]
      .join(" ")
      .toLowerCase();
  }

  function filteredRecords() {
    const query = state.query.trim().toLowerCase();
    const filtered = records.filter((record) => {
      const matchesQuery = !query || searchHaystack(record).includes(query);
      const matchesChapter = state.chapter === "all" || record.chapterId === state.chapter;
      const matchesTheme =
        state.theme === "all" || record.themes.some((theme) => theme.id === state.theme);
      const matchesYear = state.year === "all" || record.year === state.year;
      const matchesType =
        state.type === "all" || (record.documentType || record.type) === state.type;
      return matchesQuery && matchesChapter && matchesTheme && matchesYear && matchesType;
    });

    return filtered.sort((a, b) => {
      if (state.sort === "date-desc") {
        return b.date.localeCompare(a.date) || a.title.localeCompare(b.title);
      }
      if (state.sort === "title-asc") {
        return a.title.localeCompare(b.title) || a.date.localeCompare(b.date);
      }
      return a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
    });
  }

  function catalogSearchUrl(record) {
    const params = new URLSearchParams();
    params.set("search_api_fulltext", record.folderTitle || record.title);
    params.set("f[0]", "presidential_daily_type:Presidential Daily Files");
    return `https://www.bush41library.gov/digital-research-room/search?${params.toString()}`;
  }

  function renderHero() {
    const recordLabel = coverage?.directFolderScanCount
      ? "Document/source records"
      : isDocumentIndex
        ? "Listed documents"
        : "Daily File catalog records";
    els.heroStats.innerHTML = [
      [records.length.toLocaleString(), recordLabel],
      [(coverage?.folderCount || folders.length).toLocaleString(), "Daily File folders"],
      [chapters.length.toLocaleString(), "Book chapter files"],
    ]
      .map(
        ([number, label]) => `
          <div class="stat">
            <strong>${number}</strong>
            <span>${label}</span>
          </div>
        `
      )
      .join("");
  }

  function renderCoverage() {
    if (!els.coverageStats) return;
    if (!coverage) {
      els.coverageStats.textContent =
        "Folder-level index only. Run scripts/build-seen-documents.mjs for document-level coverage.";
      return;
    }
    els.coverageStats.innerHTML = `
      <strong>${coverage.documentCount.toLocaleString()}</strong> document/source records from
      <strong>${coverage.folderCount.toLocaleString()}</strong> Daily File folders:
      <strong>${(coverage.redactionSheetDocumentCount || 0).toLocaleString()}</strong> numbered withdrawal-sheet rows plus
      <strong>${(coverage.directFolderScanCount || 0).toLocaleString()}</strong> direct folder scans.
      <strong>${(coverage.foldersStillUnrepresented || 0).toLocaleString()}</strong> folders remain unrepresented at folder-scan level.
    `;
  }

  function renderStaticFilters() {
    const chapterCounts = countBy(records, (record) => record.chapterId);
    const allCount = records.length;
    els.chapterFilter.innerHTML = [
      `<button class="filter-button" type="button" data-chapter="all" aria-pressed="true">
        <span>All chapters</span><span class="filter-count">${allCount}</span>
      </button>`,
      ...chapters.map(
        (chapter) => `
          <button class="filter-button" type="button" data-chapter="${escapeHtml(chapter.id)}" aria-pressed="false">
            <span>${escapeHtml(chapter.title)}</span>
            <span class="filter-count">${chapterCounts.get(chapter.id) || 0}</span>
          </button>
        `
      ),
    ].join("");

    const years = Array.from(new Set(records.map((record) => record.year))).sort();
    els.yearFilter.innerHTML = [
      `<option value="all">All years</option>`,
      ...years.map((year) => `<option value="${year}">${year}</option>`),
    ].join("");

    const types = Array.from(new Set(records.map((record) => record.documentType || record.type))).sort();
    els.typeFilter.innerHTML = [
      `<option value="all">All types</option>`,
      ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`),
    ].join("");

    els.themeFilter.innerHTML = [
      `<button class="chip-button" type="button" data-theme="all" aria-pressed="true">
        <span>All themes</span><span class="filter-count">${records.length}</span>
      </button>`,
      ...allThemes().map(
        (theme) => `
          <button class="chip-button" type="button" data-theme="${escapeHtml(theme.id)}" aria-pressed="false">
            <span>${escapeHtml(theme.label)}</span>
            <span class="filter-count">${theme.count}</span>
          </button>
        `
      ),
    ].join("");
  }

  function renderMonthStrip(items) {
    const months = Array.from(new Set(records.map((record) => record.month))).sort();
    const counts = countBy(items, (record) => record.month);
    const max = Math.max(1, ...months.map((month) => counts.get(month) || 0));

    els.monthStrip.innerHTML = months
      .map((month) => {
        const count = counts.get(month) || 0;
        const height = count ? Math.max(0.35, (count / max) * 2.8) : 0.15;
        return `<span class="month-bar" style="height:${height}rem" title="${month}: ${count} records"></span>`;
      })
      .join("");
  }

  function renderRecords(items) {
    const maxPage = Math.max(1, Math.ceil(items.length / pageSize));
    state.page = Math.min(state.page, maxPage);
    const start = (state.page - 1) * pageSize;
    const visible = items.slice(start, start + pageSize);

    if (visible.length && !visible.some((record) => record.id === state.selectedId)) {
      state.selectedId = visible[0].id;
    }

    if (!visible.length) {
      els.recordsList.innerHTML = `<div class="empty-state">No records match the current filters.</div>`;
      els.pager.innerHTML = "";
      return;
    }

    els.recordsList.innerHTML = visible
      .map((record) => {
        const title = prettyTitle(record.title);
        const selected = record.id === state.selectedId ? " is-selected" : "";
        const tags = record.themes
          .map((theme) => `<span class="tag">${escapeHtml(theme.label)}</span>`)
          .join("");
        const catalogId = record.folderNaId || record.naId;
        const folderLabel = record.folderLocalId || record.localId || "";
        const typeLabel = record.documentType || record.type;
        const numberLabel =
          record.evidenceStatus === "direct-folder-scan"
            ? "Direct scan"
            : record.documentNumber
              ? `Doc ${record.documentNumber}`
              : "";
        return `
          <article class="record-card${selected}">
            <div class="record-head">
              <div>
                <div class="record-meta">
                  <span>${escapeHtml(record.chapter)}</span>
                  <span>NAID ${escapeHtml(catalogId)}</span>
                  ${numberLabel ? `<span>${escapeHtml(numberLabel)}</span>` : ""}
                </div>
                <h3 class="record-title">${escapeHtml(title)}</h3>
              </div>
              <div class="record-date">${formatDate(record.seenDate || record.date)}</div>
            </div>
            <div class="tag-row">${tags}</div>
            <div class="record-meta">
              <span>${escapeHtml(typeLabel)}</span>
              ${record.pages ? `<span>${record.pages} pp.</span>` : ""}
              ${record.documentDate ? `<span>Document ${formatDate(record.documentDate)}</span>` : ""}
              ${folderLabel ? `<span>Folder ${escapeHtml(folderLabel)}</span>` : ""}
              ${
                record.needsItemization
                  ? `<span>Needs itemization</span>`
                  : ""
              }
              ${record.classification ? `<span>${escapeHtml(record.classification)}</span>` : ""}
            </div>
            <div class="record-actions">
              <button type="button" data-select="${escapeHtml(record.id)}">
                <i data-lucide="panel-right-open" aria-hidden="true"></i>
                <span>Detail</span>
              </button>
              <a class="link-button secondary" href="${escapeHtml(record.catalogUrl)}" target="_blank" rel="noreferrer">
                <i data-lucide="external-link" aria-hidden="true"></i>
                <span>Catalog</span>
              </a>
              ${
                record.pdfUrl
                  ? `<a class="link-button secondary" href="${escapeHtml(record.pdfUrl)}" target="_blank" rel="noreferrer">
                      <i data-lucide="file-text" aria-hidden="true"></i>
                      <span>PDF</span>
                    </a>`
                  : ""
              }
              <button class="secondary" type="button" data-copy="${escapeHtml(record.id)}">
                <i data-lucide="copy" aria-hidden="true"></i>
                <span>Citation</span>
              </button>
            </div>
          </article>
        `;
      })
      .join("");

    els.pager.innerHTML = `
      <button type="button" data-page="prev" ${state.page === 1 ? "disabled" : ""}>
        <i data-lucide="chevron-left" aria-hidden="true"></i>
        <span>Previous</span>
      </button>
      <span class="pager-status">Page ${state.page} of ${maxPage}</span>
      <button type="button" data-page="next" ${state.page === maxPage ? "disabled" : ""}>
        <span>Next</span>
        <i data-lucide="chevron-right" aria-hidden="true"></i>
      </button>
    `;
  }

  function renderDetail(items) {
    if (!items.length) {
      els.detailPanel.innerHTML = `<p class="empty-state">No selected document in this filter set.</p>`;
      return;
    }

    const record =
      items.find((candidate) => candidate.id === state.selectedId) ||
      records.find((candidate) => candidate.id === state.selectedId) ||
      items[0];

    if (!record) {
      els.detailPanel.innerHTML = `<p class="empty-state">Select a document to see details.</p>`;
      return;
    }

    const title = prettyTitle(record.title);
    const themes = record.themes
      .map((theme) => `<span class="tag">${escapeHtml(theme.label)}</span>`)
      .join("");
    const keywords = record.keywords?.length
      ? record.keywords.map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join("")
      : `<span class="tag">Chronology</span>`;
    const catalogId = record.folderNaId || record.naId;
    const typeLabel = record.documentType || record.type;
    const documentLabel =
      record.evidenceStatus === "direct-folder-scan"
        ? typeLabel
        : `${record.documentNumber} ${typeLabel}`;

    els.detailPanel.innerHTML = `
      <p class="eyebrow">Selected document</p>
      <h3>${escapeHtml(title)}</h3>
      <div class="tag-row">${themes}</div>
      <div class="tag-row">${keywords}</div>
      <dl class="detail-list">
        ${
          record.documentNumber
            ? `<div class="detail-row">
                <dt>Document</dt>
                <dd>${escapeHtml(documentLabel)}</dd>
              </div>`
            : ""
        }
        <div class="detail-row">
          <dt>Seen/Filed</dt>
          <dd>${formatLongDate(record.seenDate || record.date)}</dd>
        </div>
        ${
          record.documentDate
            ? `<div class="detail-row">
                <dt>Doc Date</dt>
                <dd>${formatLongDate(record.documentDate)}</dd>
              </div>`
            : ""
        }
        ${
          record.folderTitle
            ? `<div class="detail-row">
                <dt>Folder</dt>
                <dd>${escapeHtml(record.folderTitle)}</dd>
              </div>`
            : ""
        }
        ${
          record.pages
            ? `<div class="detail-row">
                <dt>Pages</dt>
                <dd>${record.pages}</dd>
              </div>`
            : ""
        }
        ${
          record.restriction
            ? `<div class="detail-row">
                <dt>Restriction</dt>
                <dd>${escapeHtml(record.restriction)}</dd>
              </div>`
            : ""
        }
        ${
          record.classification
            ? `<div class="detail-row">
                <dt>Class.</dt>
                <dd>${escapeHtml(record.classification)}</dd>
              </div>`
            : ""
        }
        <div class="detail-row">
          <dt>Evidence</dt>
          <dd>${escapeHtml(record.evidence || "NARA Catalog record")}</dd>
        </div>
        ${
          record.excerpt
            ? `<div class="detail-row">
                <dt>OCR Start</dt>
                <dd>${escapeHtml(record.excerpt)}</dd>
              </div>`
            : ""
        }
        ${
          record.needsItemization
            ? `<div class="detail-row">
                <dt>Audit</dt>
                <dd>Folder-level direct scan; item-by-item page audit still needed.</dd>
              </div>`
            : ""
        }
        <div class="detail-row">
          <dt>Chapter</dt>
          <dd>${escapeHtml(record.chapter)}</dd>
        </div>
        <div class="detail-row">
          <dt>Catalog</dt>
          <dd>NAID ${escapeHtml(catalogId)}</dd>
        </div>
        <div class="detail-row">
          <dt>Folder ID</dt>
          <dd>${escapeHtml(record.folderLocalId || record.localId || "Unlisted")}</dd>
        </div>
        <div class="detail-row">
          <dt>Container</dt>
          <dd>${escapeHtml(record.folderContainerId || record.containerId || "Unlisted")}</dd>
        </div>
      </dl>
      <div class="citation-box">${escapeHtml(record.citation)}</div>
      <div class="detail-actions">
        <a class="link-button" href="${escapeHtml(record.catalogUrl)}" target="_blank" rel="noreferrer">
          <i data-lucide="archive" aria-hidden="true"></i>
          <span>Open Catalog</span>
        </a>
        <a class="link-button secondary" href="${escapeHtml(catalogSearchUrl(record))}" target="_blank" rel="noreferrer">
          <i data-lucide="search" aria-hidden="true"></i>
          <span>Bush Search</span>
        </a>
        ${
          record.pdfUrl
            ? `<a class="link-button secondary" href="${escapeHtml(record.pdfUrl)}" target="_blank" rel="noreferrer">
                <i data-lucide="file-text" aria-hidden="true"></i>
                <span>PDF</span>
              </a>`
            : ""
        }
        <button class="tool-button secondary" type="button" data-copy="${escapeHtml(record.id)}">
          <i data-lucide="copy" aria-hidden="true"></i>
          <span>Copy</span>
        </button>
      </div>
    `;
  }

  function renderChapters() {
    const counts = countBy(records, (record) => record.chapterId);
    els.chapterCards.innerHTML = chapters
      .map(
        (chapter) => `
          <article class="chapter-card">
            <div class="chapter-count">
              <span>${escapeHtml(chapter.dateRange)}</span>
              <strong>${counts.get(chapter.id) || 0}</strong>
            </div>
            <h3>${escapeHtml(chapter.title)}</h3>
            <p>${escapeHtml(chapter.question)}</p>
          </article>
        `
      )
      .join("");
  }

  function updatePressedStates() {
    document.querySelectorAll("[data-chapter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.chapter === state.chapter));
    });
    document.querySelectorAll("[data-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.theme === state.theme));
    });
    els.yearFilter.value = state.year;
    els.typeFilter.value = state.type;
    els.sortControl.value = state.sort;
  }

  function refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function render() {
    const items = filteredRecords();
    const label = coverage?.directFolderScanCount
      ? "source records"
      : isDocumentIndex
        ? "documents"
        : "records";
    els.resultCount.textContent = `${items.length.toLocaleString()} ${label}`;
    renderMonthStrip(items);
    renderRecords(items);
    renderDetail(items);
    updatePressedStates();
    refreshIcons();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showToast("Citation copied");
  }

  function showToast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function resetFilters() {
    state.query = "";
    state.chapter = "all";
    state.theme = "all";
    state.year = "all";
    state.type = "all";
    state.sort = "date-asc";
    state.page = 1;
    els.searchInput.value = "";
    render();
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", (event) => {
      state.query = event.target.value;
      state.page = 1;
      render();
    });

    els.yearFilter.addEventListener("change", (event) => {
      state.year = event.target.value;
      state.page = 1;
      render();
    });

    els.typeFilter.addEventListener("change", (event) => {
      state.type = event.target.value;
      state.page = 1;
      render();
    });

    els.sortControl.addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.page = 1;
      render();
    });

    els.resetFilters.addEventListener("click", resetFilters);

    document.addEventListener("click", (event) => {
      const chapterButton = event.target.closest("[data-chapter]");
      if (chapterButton) {
        state.chapter = chapterButton.dataset.chapter;
        state.page = 1;
        render();
        return;
      }

      const themeButton = event.target.closest("[data-theme]");
      if (themeButton) {
        state.theme = themeButton.dataset.theme;
        state.page = 1;
        render();
        return;
      }

      const selectButton = event.target.closest("[data-select]");
      if (selectButton) {
        state.selectedId = selectButton.dataset.select;
        render();
        return;
      }

      const copyButton = event.target.closest("[data-copy]");
      if (copyButton) {
        const record = records.find((candidate) => candidate.id === copyButton.dataset.copy);
        if (record) copyText(record.citation);
        return;
      }

      const pageButton = event.target.closest("[data-page]");
      if (pageButton && !pageButton.disabled) {
        state.page += pageButton.dataset.page === "next" ? 1 : -1;
        render();
      }
    });
  }

  function boot() {
    if (!records.length) {
      document.body.innerHTML = `<main class="empty-state">No document data is available.</main>`;
      return;
    }
    renderHero();
    renderCoverage();
    renderStaticFilters();
    renderChapters();
    bindEvents();
    render();
  }

  boot();
})();
