import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl
} from "obsidian";

type PaperFlowSettings = typeof DEFAULT_SETTINGS;

type PaperRecord = Record<string, any> & {
  key?: string;
  title?: string;
  authors?: string[];
  year?: number;
  citationCount?: number;
  paperId?: string;
  lookupId?: string;
  identifier?: string;
  doi?: string;
  arxivId?: string;
  references?: any[];
  sourceFiles?: string[];
  sourceUrlsByFile?: Record<string, string[]>;
};

type PaperFlowData = {
  settings: PaperFlowSettings;
  papers: Record<string, PaperRecord>;
  files: Record<string, any>;
  lastCitationUpdate: string | null;
};

const DEFAULT_SETTINGS = {
  autoProcess: true,
  downloadPdfs: true,
  pdfFolder: "papers",
  citationUpdateIntervalDays: 7,
  graphMaxPapers: 18,
  semanticScholarApiKey: "",
  insertGeneratedBlock: true
};

const DEFAULT_DATA = {
  settings: DEFAULT_SETTINGS,
  papers: {},
  files: {},
  lastCitationUpdate: null
};

const PAPER_BLOCK_START = "<!-- paper-flow:start -->";
const PAPER_BLOCK_END = "<!-- paper-flow:end -->";
const MAP_BLOCK_START = "<!-- paper-flow-map:start -->";
const MAP_BLOCK_END = "<!-- paper-flow-map:end -->";

export default class PaperFlowPlugin extends Plugin {
  data: PaperFlowData;
  settings: PaperFlowSettings;
  processingPaths: Set<string>;
  modifyTimers: Map<string, number>;

  async onload() {
    await this.loadPluginData();
    this.processingPaths = new Set();
    this.modifyTimers = new Map();

    this.addSettingTab(new PaperFlowSettingTab(this.app, this));

    this.addCommand({
      id: "process-current-note",
      name: "Process paper URLs in current note",
      callback: () => this.processActiveFile(true)
    });

    this.addCommand({
      id: "update-citations-now",
      name: "Update known paper citation counts now",
      callback: async () => {
        await this.updateAllCitations(true);
        new Notice("Paper Flow: citation counts updated.");
      }
    });

    this.addCommand({
      id: "generate-current-note-map",
      name: "Generate Mermaid paper map for current note",
      callback: () => this.generateMapForActiveFile()
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.autoProcess) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (this.processingPaths.has(file.path)) return;
        this.scheduleFileProcess(file);
      })
    );

    this.registerInterval(
      window.setInterval(() => this.updateCitationsIfDue(), 60 * 60 * 1000)
    );

    window.setTimeout(() => this.updateCitationsIfDue(), 15000);
  }

  onunload() {
    for (const timer of this.modifyTimers.values()) {
      window.clearTimeout(timer);
    }
  }

  async loadPluginData() {
    const loaded = await this.loadData();
    this.data = mergeDeep(DEFAULT_DATA, loaded || {});
    this.settings = mergeDeep(DEFAULT_SETTINGS, this.data.settings || {});
    this.data.settings = this.settings;
    this.data.papers = this.data.papers || {};
    this.data.files = this.data.files || {};
  }

  async savePluginData() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  scheduleFileProcess(file) {
    const oldTimer = this.modifyTimers.get(file.path);
    if (oldTimer) window.clearTimeout(oldTimer);

    const timer = window.setTimeout(async () => {
      this.modifyTimers.delete(file.path);
      try {
        await this.processFile(file, false);
      } catch (error) {
        console.error("Paper Flow: failed to process file", file.path, error);
      }
    }, 1800);

    this.modifyTimers.set(file.path, timer);
  }

  async processActiveFile(showNotice) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Paper Flow: open a Markdown note first.");
      return;
    }
    await this.processFile(file, showNotice);
  }

  async processFile(file, showNotice) {
    if (!file || file.extension !== "md") return;
    if (this.processingPaths.has(file.path)) return;

    this.processingPaths.add(file.path);
    try {
      const original = await this.app.vault.cachedRead(file);
      const cleanContent = stripGeneratedBlocks(stripCodeFences(original));
      const urls = extractHttpUrls(cleanContent);

      if (urls.length === 0) {
        this.data.files[file.path] = {
          urls: [],
          paperKeys: [],
          lastProcessed: nowIso()
        };
        await this.savePluginData();
        if (showNotice) new Notice("Paper Flow: no paper URLs found.");
        return;
      }

      this.removeFileFromPaperSources(file.path);
      const paperKeys = [];

      for (const url of urls) {
        const paper = await this.resolvePaperFromUrl(url);
        if (!paper) continue;
        if (!paperKeys.includes(paper.key)) paperKeys.push(paper.key);
        this.addPaperSource(paper.key, file.path, url);
      }

      this.data.files[file.path] = {
        urls,
        paperKeys,
        lastProcessed: nowIso()
      };
      await this.savePluginData();

      if (this.settings.insertGeneratedBlock && paperKeys.length > 0) {
        const next = replaceGeneratedBlock(
          original,
          PAPER_BLOCK_START,
          PAPER_BLOCK_END,
          this.renderPaperBlock(paperKeys)
        );

        if (next !== original) {
          await this.safeModify(file, next);
        }
      }

      if (showNotice) {
        new Notice(`Paper Flow: processed ${paperKeys.length} paper(s).`);
      }
    } finally {
      window.setTimeout(() => this.processingPaths.delete(file.path), 1000);
    }
  }

  async safeModify(file, content) {
    this.processingPaths.add(file.path);
    try {
      await this.app.vault.modify(file, content);
    } finally {
      window.setTimeout(() => this.processingPaths.delete(file.path), 1000);
    }
  }

  removeFileFromPaperSources(path) {
    for (const paper of Object.values(this.data.papers)) {
      paper.sourceFiles = (paper.sourceFiles || []).filter((item) => item !== path);
      paper.sourceUrlsByFile = paper.sourceUrlsByFile || {};
      delete paper.sourceUrlsByFile[path];
    }
  }

  addPaperSource(key, filePath, url) {
    const paper = this.data.papers[key];
    if (!paper) return;

    paper.sourceFiles = paper.sourceFiles || [];
    if (!paper.sourceFiles.includes(filePath)) paper.sourceFiles.push(filePath);

    paper.sourceUrlsByFile = paper.sourceUrlsByFile || {};
    paper.sourceUrlsByFile[filePath] = paper.sourceUrlsByFile[filePath] || [];
    if (!paper.sourceUrlsByFile[filePath].includes(url)) {
      paper.sourceUrlsByFile[filePath].push(url);
    }
  }

  async resolvePaperFromUrl(url) {
    const parsed = parsePaperIdentifier(url);
    let metadata = null;

    if (parsed.lookupId) {
      metadata = await this.fetchSemanticScholarPaper(parsed.lookupId).catch(() => null);
    }

    if (!metadata && parsed.type === "arxiv") {
      metadata = await this.fetchArxivPaper(parsed.value).catch(() => null);
      const openAlex = await this.fetchOpenAlexByArxivId(parsed.value).catch(() => null);
      metadata = mergeCitationMetadata(metadata, openAlex);
    }

    if (!metadata && parsed.type === "doi") {
      metadata = await this.fetchCrossrefPaper(parsed.value).catch(() => null);
      const openAlex = await this.fetchOpenAlexByDoi(parsed.value).catch(() => null);
      metadata = mergeCitationMetadata(metadata, openAlex);
    }

    if (!metadata) {
      metadata = await this.fetchCitationMetaFromPage(url).catch(() => null);
      if (metadata && metadata.doi) {
        const s2 = await this.fetchSemanticScholarPaper(`DOI:${metadata.doi}`).catch(() => null);
        const openAlex = await this.fetchOpenAlexByDoi(metadata.doi).catch(() => null);
        metadata = mergePaperMetadata(mergeCitationMetadata(metadata, openAlex), s2);
      } else if (metadata && metadata.title) {
        const s2 = await this.searchSemanticScholarByTitle(metadata.title).catch(() => null);
        const openAlex = await this.searchOpenAlexByTitle(metadata.title).catch(() => null);
        metadata = mergePaperMetadata(mergeCitationMetadata(metadata, openAlex), s2);
      }
    }

    if (!metadata && looksLikePdfUrl(url)) {
      metadata = {
        title: filenameTitleFromUrl(url),
        authors: [],
        year: null,
        citationCount: null,
        sourceUrl: url,
        pdfUrl: url,
        lookupId: parsed.lookupId || null,
        identifier: parsed.lookupId || url,
        lastUpdated: nowIso()
      };
    }

    if (!metadata || !metadata.title) return null;

    metadata.sourceUrl = metadata.sourceUrl || url;
    metadata.pdfUrl = metadata.pdfUrl || parsed.pdfUrl || null;
    metadata.lookupId = metadata.lookupId || parsed.lookupId || null;
    metadata.identifier = metadata.identifier || parsed.lookupId || url;
    metadata.lastUpdated = nowIso();

    const key = metadata.paperId ? `S2:${metadata.paperId}` : stablePaperKey(parsed, metadata, url);
    const oldPaper = this.data.papers[key] || {};
    const paper = mergePaperMetadata(oldPaper, metadata);
    paper.key = key;
    paper.urls = unique([...(oldPaper.urls || []), url]);

    this.data.papers[key] = paper;

    if (this.settings.downloadPdfs) {
      await this.downloadPaperPdf(key, url).catch((error) => {
        console.error("Paper Flow: PDF download failed", url, error);
      });
    }

    return this.data.papers[key];
  }

  async fetchSemanticScholarPaper(lookupId, withReferences = false) {
    const fields = [
      "paperId",
      "corpusId",
      "title",
      "authors",
      "year",
      "venue",
      "publicationDate",
      "citationCount",
      "externalIds",
      "url",
      "openAccessPdf",
      "isOpenAccess",
      "abstract"
    ];

    if (withReferences) {
      fields.push(
        "references.paperId",
        "references.title",
        "references.authors",
        "references.year",
        "references.citationCount"
      );
    }

    const endpoint = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(lookupId)}?fields=${encodeURIComponent(fields.join(","))}`;
    const response = await requestUrl({
      url: endpoint,
      method: "GET",
      headers: this.semanticScholarHeaders()
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Semantic Scholar returned ${response.status}`);
    }

    return normalizeSemanticScholarPaper(response.json, lookupId);
  }

  async searchSemanticScholarByTitle(title) {
    const fields = [
      "paperId",
      "corpusId",
      "title",
      "authors",
      "year",
      "venue",
      "publicationDate",
      "citationCount",
      "externalIds",
      "url",
      "openAccessPdf",
      "isOpenAccess",
      "abstract"
    ].join(",");
    const endpoint = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${encodeURIComponent(fields)}`;
    const response = await requestUrl({
      url: endpoint,
      method: "GET",
      headers: this.semanticScholarHeaders()
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Semantic Scholar search returned ${response.status}`);
    }

    const first = response.json && response.json.data && response.json.data[0];
    return first ? normalizeSemanticScholarPaper(first, null) : null;
  }

  async fetchOpenAlexByDoi(doi) {
    const response = await requestUrl({
      url: `https://api.openalex.org/works?filter=doi:${encodeURIComponent(normalizeDoi(doi))}&per-page=1`,
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAlex returned ${response.status}`);
    }

    const first = response.json && response.json.results && response.json.results[0];
    return first ? normalizeOpenAlexPaper(first, `DOI:${normalizeDoi(doi)}`) : null;
  }

  async fetchOpenAlexByArxivId(arxivId) {
    const arxiv = await this.fetchArxivPaper(arxivId).catch(() => null);
    if (!arxiv || !arxiv.title) return null;
    const openAlex = await this.searchOpenAlexByTitle(arxiv.title).catch(() => null);
    if (!openAlex || !titlesLookSame(arxiv.title, openAlex.title)) return null;
    return openAlex;
  }

  async searchOpenAlexByTitle(title) {
    const response = await requestUrl({
      url: `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5`,
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAlex search returned ${response.status}`);
    }

    const results = (response.json && response.json.results) || [];
    const best =
      results.find((item) => titlesLookSame(title, item.title || item.display_name)) ||
      results[0];

    return best ? normalizeOpenAlexPaper(best, null) : null;
  }

  semanticScholarHeaders() {
    const headers = { Accept: "application/json" };
    const apiKey = (this.settings.semanticScholarApiKey || "").trim();
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  async fetchCrossrefPaper(doi) {
    const response = await requestUrl({
      url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Crossref returned ${response.status}`);
    }

    const message = response.json && response.json.message;
    if (!message) return null;

    const authors = (message.author || [])
      .map((author) => [author.given, author.family].filter(Boolean).join(" "))
      .filter(Boolean);

    const year =
      extractYearFromCrossrefDate(message["published-print"]) ||
      extractYearFromCrossrefDate(message["published-online"]) ||
      extractYearFromCrossrefDate(message.created);

    return {
      title: arrayFirst(message.title),
      authors,
      year,
      venue: arrayFirst(message["container-title"]),
      citationCount: typeof message["is-referenced-by-count"] === "number"
        ? message["is-referenced-by-count"]
        : null,
      doi,
      identifier: `DOI:${doi}`,
      lookupId: `DOI:${doi}`,
      sourceUrl: message.URL || `https://doi.org/${doi}`,
      pdfUrl: findCrossrefPdfUrl(message),
      lastUpdated: nowIso(),
      citationSource: "Crossref"
    };
  }

  async fetchArxivPaper(arxivId) {
    const cleanId = cleanArxivId(arxivId);
    const response = await requestUrl({
      url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`,
      method: "GET"
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`arXiv returned ${response.status}`);
    }

    const entryMatch = response.text.match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) return null;
    const entry = entryMatch[1];
    const authors = [];
    const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;
    let match;
    while ((match = authorRegex.exec(entry)) !== null) {
      authors.push(decodeXml(match[1]).trim());
    }

    const title = normalizeWhitespace(decodeXml(matchXmlTag(entry, "title") || ""));
    const published = matchXmlTag(entry, "published");

    return {
      title,
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      venue: "arXiv",
      citationCount: null,
      arxivId: cleanId,
      identifier: `ARXIV:${cleanId}`,
      lookupId: `ARXIV:${cleanId}`,
      sourceUrl: `https://arxiv.org/abs/${cleanId}`,
      pdfUrl: `https://arxiv.org/pdf/${cleanId}.pdf`,
      lastUpdated: nowIso(),
      citationSource: "arXiv metadata"
    };
  }

  async fetchCitationMetaFromPage(url) {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });

    if (response.status < 200 || response.status >= 300 || !response.text) {
      throw new Error(`Page returned ${response.status}`);
    }

    const metas = parseMetaTags(response.text);
    const title =
      firstMeta(metas, "citation_title") ||
      firstMeta(metas, "dc.title") ||
      firstMeta(metas, "og:title") ||
      parseHtmlTitle(response.text);

    const authors = allMeta(metas, "citation_author");
    const date =
      firstMeta(metas, "citation_publication_date") ||
      firstMeta(metas, "citation_date") ||
      firstMeta(metas, "dc.date");
    const doi =
      firstMeta(metas, "citation_doi") ||
      extractDoi(firstMeta(metas, "dc.identifier") || "");

    const pdfUrl = absolutizeUrl(
      firstMeta(metas, "citation_pdf_url") ||
      firstMeta(metas, "citation_fulltext_html_url"),
      url
    );

    if (!title) return null;

    return {
      title: normalizeWhitespace(decodeHtml(title)),
      authors: authors.map((author) => normalizeWhitespace(decodeHtml(author))),
      year: extractYear(date),
      doi: doi || null,
      identifier: doi ? `DOI:${doi}` : url,
      lookupId: doi ? `DOI:${doi}` : null,
      sourceUrl: url,
      pdfUrl,
      lastUpdated: nowIso(),
      citationSource: "page metadata"
    };
  }

  async downloadPaperPdf(key, sourceUrl) {
    const paper = this.data.papers[key];
    if (!paper) return;

    const pdfUrl = paper.pdfUrl || (looksLikePdfUrl(sourceUrl) ? sourceUrl : null);
    if (!pdfUrl) return;

    const folder = normalizePath(this.settings.pdfFolder || DEFAULT_SETTINGS.pdfFolder);
    await ensureFolder(this.app, folder);

    const fileName = makePdfFileName(paper);
    const targetPath = normalizePath(`${folder}/${fileName}`);
    if (await this.app.vault.adapter.exists(targetPath)) {
      paper.pdfPath = targetPath;
      return;
    }

    const response = await requestUrl({
      url: pdfUrl,
      method: "GET",
      headers: { Accept: "application/pdf,*/*" }
    });

    if (response.status < 200 || response.status >= 300 || !response.arrayBuffer) {
      throw new Error(`PDF request returned ${response.status}`);
    }

    await this.app.vault.createBinary(targetPath, response.arrayBuffer);
    paper.pdfPath = targetPath;
    paper.pdfUrl = pdfUrl;
    await this.savePluginData();
  }

  async updateCitationsIfDue() {
    const days = Number(this.settings.citationUpdateIntervalDays ?? 7);
    if (days <= 0) return;

    const last = this.data.lastCitationUpdate ? new Date(this.data.lastCitationUpdate).getTime() : 0;
    const dueMs = days * 24 * 60 * 60 * 1000;
    if (Date.now() - last < dueMs) return;

    await this.updateAllCitations(false).catch((error) => {
      console.error("Paper Flow: scheduled citation update failed", error);
    });
  }

  async updateAllCitations(showNotice) {
    const entries = Object.entries(this.data.papers || {});
    let updated = 0;

    for (const [key, paper] of entries) {
      const lookupId = paper.paperId ? paper.paperId : paper.lookupId || paper.identifier;
      const fresh = await this.fetchFreshCitationMetadata(paper, lookupId).catch(() => null);
      if (!fresh) continue;

      this.data.papers[key] =
        fresh.citationSource === "Semantic Scholar"
          ? mergePaperMetadata(paper, fresh)
          : mergeCitationMetadata(paper, fresh);
      this.data.papers[key].lastUpdated = nowIso();
      updated += 1;
      await sleep(350);
    }

    this.data.lastCitationUpdate = nowIso();
    await this.savePluginData();
    await this.refreshGeneratedBlocks();

    if (showNotice) {
      new Notice(`Paper Flow: updated ${updated} citation count(s).`);
    }
  }

  async fetchFreshCitationMetadata(paper, lookupId) {
    if (lookupId) {
      const semantic = await this.fetchSemanticScholarPaper(lookupId).catch(() => null);
      if (semantic && typeof semantic.citationCount === "number") return semantic;
    }

    if (paper.doi) {
      const openAlex = await this.fetchOpenAlexByDoi(paper.doi).catch(() => null);
      if (openAlex && typeof openAlex.citationCount === "number") return openAlex;

      const crossref = await this.fetchCrossrefPaper(paper.doi).catch(() => null);
      if (crossref && typeof crossref.citationCount === "number") return crossref;
    }

    if (paper.arxivId) {
      const openAlex = await this.fetchOpenAlexByArxivId(paper.arxivId).catch(() => null);
      if (openAlex && typeof openAlex.citationCount === "number") return openAlex;
    }

    if (paper.title) {
      const openAlex = await this.searchOpenAlexByTitle(paper.title).catch(() => null);
      if (openAlex && titlesLookSame(paper.title, openAlex.title)) return openAlex;
    }

    return null;
  }

  async refreshGeneratedBlocks() {
    for (const [path, fileInfo] of Object.entries(this.data.files || {})) {
      if (!fileInfo || !fileInfo.paperKeys || fileInfo.paperKeys.length === 0) continue;
      const abstractFile = this.app.vault.getAbstractFileByPath(path);
      if (!(abstractFile instanceof TFile)) continue;

      const original = await this.app.vault.cachedRead(abstractFile);
      if (!original.includes(PAPER_BLOCK_START)) continue;

      const next = replaceGeneratedBlock(
        original,
        PAPER_BLOCK_START,
        PAPER_BLOCK_END,
        this.renderPaperBlock(fileInfo.paperKeys)
      );
      if (next !== original) await this.safeModify(abstractFile, next);
    }
  }

  renderPaperBlock(paperKeys) {
    const rows = (unique(paperKeys) as string[])
      .map((key) => this.data.papers[key])
      .filter(Boolean)
      .sort(comparePapersForDisplay)
      .map((paper) => {
        const title = escapeMarkdownCell(paper.title || "Untitled");
        const source = paper.sourceUrl || first(paper.urls) || "";
        const titleLink = source ? `[${title}](${source})` : title;
        const authors = escapeMarkdownCell(formatAuthors(paper.authors));
        const year = paper.year || "";
        const citations = typeof paper.citationCount === "number" ? paper.citationCount : "";
        const pdf = paper.pdfPath ? `[PDF](${encodeMarkdownLink(paper.pdfPath)})` : "";
        const id = escapeMarkdownCell(paper.identifier || paper.lookupId || paper.doi || paper.arxivId || "");
        return `| ${titleLink} | ${authors} | ${year} | ${citations} | ${pdf} | ${id} |`;
      });

    const updatedAt = this.data.lastCitationUpdate || nowIso();
    return [
      PAPER_BLOCK_START,
      "## Paper Flow",
      "",
      "| Title | Authors | Year | Citations | PDF | ID |",
      "| --- | --- | ---: | ---: | --- | --- |",
      ...rows,
      "",
      `_Last updated: ${updatedAt}_`,
      PAPER_BLOCK_END
    ].join("\n");
  }

  async generateMapForActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Paper Flow: open a Markdown note first.");
      return;
    }

    await this.generateMapForFile(file);
  }

  async generateMapForFile(file) {
    let fileInfo = this.data.files[file.path];
    if (!fileInfo || !fileInfo.paperKeys || fileInfo.paperKeys.length === 0) {
      await this.processFile(file, false);
      fileInfo = this.data.files[file.path];
    }

    const paperKeys = unique((fileInfo && fileInfo.paperKeys) || []) as string[];
    if (paperKeys.length < 2) {
      new Notice("Paper Flow: at least two papers are needed for a map.");
      return;
    }

    for (const key of paperKeys) {
      await this.ensureGraphDetails(key);
      await sleep(350);
    }

    const papers = paperKeys
      .map((key) => this.data.papers[key])
      .filter(Boolean);

    const selected = selectImportantPapers(papers, this.settings.graphMaxPapers);
    const mermaid = this.renderMermaidMap(selected);

    const original = await this.app.vault.cachedRead(file);
    const next = replaceGeneratedBlock(original, MAP_BLOCK_START, MAP_BLOCK_END, mermaid);
    await this.safeModify(file, next);
    await this.savePluginData();

    new Notice(`Paper Flow: generated map with ${selected.length} paper(s).`);
  }

  async ensureGraphDetails(key) {
    const paper = this.data.papers[key];
    if (!paper) return;
    if (paper.references && paper.references.length > 0) return;

    const lookupId = paper.paperId ? paper.paperId : paper.lookupId || paper.identifier;
    if (!lookupId) return;

    const fresh = await this.fetchSemanticScholarPaper(lookupId, true).catch(() => null);
    if (!fresh) return;

    this.data.papers[key] = mergePaperMetadata(paper, fresh);
    this.data.papers[key].lastUpdated = nowIso();
  }

  renderMermaidMap(papers) {
    const sorted = papers.slice().sort(comparePapersChronologically);
    const idByPaperId = new Map();
    const nodeIdByKey = new Map();

    sorted.forEach((paper, index) => {
      const nodeId = `P${index + 1}`;
      nodeIdByKey.set(paper.key, nodeId);
      if (paper.paperId) idByPaperId.set(paper.paperId, paper);
    });

    const edges = buildPaperEdges(sorted, idByPaperId);

    const lines = [
      MAP_BLOCK_START,
      "## Paper Map",
      "",
      "```mermaid",
      "flowchart TD"
    ];

    for (const paper of sorted) {
      const nodeId = nodeIdByKey.get(paper.key);
      lines.push(`    ${nodeId}["${escapeMermaidLabel(renderNodeLabel(paper))}"]`);
    }

    for (const edge of edges) {
      const sourceId = nodeIdByKey.get(edge.source.key);
      const targetId = nodeIdByKey.get(edge.target.key);
      if (!sourceId || !targetId || sourceId === targetId) continue;
      lines.push(`    ${sourceId} -->|"${escapeMermaidLabel(edge.label)}"| ${targetId}`);
    }

    lines.push("```", MAP_BLOCK_END);
    return lines.join("\n");
  }
};

class PaperFlowSettingTab extends PluginSettingTab {
  plugin: PaperFlowPlugin;

  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Flow 设置" });

    new Setting(containerEl)
      .setName("自动处理修改过的 Markdown 文件")
      .setDesc("开启后，插件会监听笔记改动，并在短暂延迟后处理里面的论文 URL。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoProcess)
        .onChange(async (value) => {
          this.plugin.settings.autoProcess = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("插入自动生成的论文信息块")
      .setDesc("开启后，包含论文 URL 的笔记会自动插入标题、作者、年份、引用数和 PDF 链接表格。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.insertGeneratedBlock)
        .onChange(async (value) => {
          this.plugin.settings.insertGeneratedBlock = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("下载 PDF")
      .setDesc("当能找到开放访问 PDF 链接时，自动下载论文。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.downloadPdfs)
        .onChange(async (value) => {
          this.plugin.settings.downloadPdfs = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("PDF 保存目录")
      .setDesc("下载的 PDF 会保存在库内这个目录。")
      .addText((text) => text
        .setPlaceholder("papers")
        .setValue(this.plugin.settings.pdfFolder)
        .onChange(async (value) => {
          this.plugin.settings.pdfFolder = normalizePath(value || "papers");
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("引用数自动更新间隔")
      .setDesc("单位为天。设为 0 可以关闭定期更新。")
      .addText((text) => text
        .setPlaceholder("7")
        .setValue(String(this.plugin.settings.citationUpdateIntervalDays))
        .onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.citationUpdateIntervalDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Mermaid 图最多论文数")
      .setDesc("论文太多时，优先选择引用数较高的论文，然后按年份排列。")
      .addText((text) => text
        .setPlaceholder("18")
        .setValue(String(this.plugin.settings.graphMaxPapers))
        .onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.graphMaxPapers = Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : 18;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Semantic Scholar API key")
      .setDesc("可选。填写后能提高元数据和引用数更新的访问额度。")
      .addText((text) => text
        .setPlaceholder("optional")
        .setValue(this.plugin.settings.semanticScholarApiKey || "")
        .onChange(async (value) => {
          this.plugin.settings.semanticScholarApiKey = value.trim();
          await this.plugin.savePluginData();
        }));
  }
}

function mergeDeep(base, override) {
  const result = Array.isArray(base) ? base.slice() : { ...base };
  if (!override || typeof override !== "object") return result;

  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = mergeDeep(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripGeneratedBlocks(content) {
  return content
    .replace(blockRegex(PAPER_BLOCK_START, PAPER_BLOCK_END), "")
    .replace(blockRegex(MAP_BLOCK_START, MAP_BLOCK_END), "");
}

function stripCodeFences(content) {
  return content.replace(/```[\s\S]*?```/g, "");
}

function extractHttpUrls(content) {
  const urls = [];
  const regex = /https?:\/\/[^\s<>"'`)]+/gi;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const clean = match[0].replace(/[.,;:!?]+$/g, "");
    if (!urls.includes(clean)) urls.push(clean);
  }

  return urls;
}

function blockRegex(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
}

function replaceGeneratedBlock(content, start, end, fullBlock) {
  const regex = blockRegex(start, end);
  if (regex.test(content)) {
    return content.replace(regex, `${fullBlock}\n`);
  }

  const insertAt = insertionIndexAfterFrontmatter(content);
  return `${content.slice(0, insertAt)}${fullBlock}\n\n${content.slice(insertAt)}`;
}

function insertionIndexAfterFrontmatter(content) {
  if (!content.startsWith("---\n")) return 0;
  const close = content.indexOf("\n---\n", 4);
  if (close === -1) return 0;
  return close + "\n---\n".length;
}

function parsePaperIdentifier(url) {
  const raw = url.trim();
  const lower = raw.toLowerCase();

  const arxivMatch = lower.match(/arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?|[a-z-]+(?:\.[a-z-]+)?\/[0-9]{7}(?:v[0-9]+)?)/i);
  if (arxivMatch) {
    const arxivId = cleanArxivId(arxivMatch[1]);
    return {
      type: "arxiv",
      value: arxivId,
      lookupId: `ARXIV:${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`
    };
  }

  const doiFromUrl = parseDoiFromUrl(raw);
  if (doiFromUrl) {
    return {
      type: "doi",
      value: doiFromUrl,
      lookupId: `DOI:${doiFromUrl}`,
      pdfUrl: null
    };
  }

  const s2Match = raw.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([a-f0-9]{40})/i);
  if (s2Match) {
    return {
      type: "semantic-scholar",
      value: s2Match[1],
      lookupId: s2Match[1],
      pdfUrl: null
    };
  }

  return {
    type: looksLikePdfUrl(raw) ? "pdf" : "url",
    value: raw,
    lookupId: null,
    pdfUrl: looksLikePdfUrl(raw) ? raw : null
  };
}

function cleanArxivId(value) {
  return String(value || "")
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "")
    .trim();
}

function parseDoiFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (/doi\.org$/i.test(parsed.hostname) || /dx\.doi\.org$/i.test(parsed.hostname)) {
      const doi = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      return normalizeDoi(doi);
    }
  } catch (error) {
    // Continue with regex DOI extraction.
  }
  return extractDoi(url);
}

function extractDoi(text) {
  if (!text) return null;
  const match = String(text).match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? normalizeDoi(match[0]) : null;
}

function normalizeDoi(doi) {
  return String(doi || "")
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/[)\].,;]+$/g, "")
    .trim();
}

function stablePaperKey(parsed, metadata, url) {
  if (metadata.doi) return `DOI:${normalizeDoi(metadata.doi)}`;
  if (metadata.arxivId) return `ARXIV:${cleanArxivId(metadata.arxivId)}`;
  if (parsed.lookupId) return parsed.lookupId;
  return `URL:${url}`;
}

function normalizeSemanticScholarPaper(data, lookupId) {
  if (!data) return null;
  const externalIds = data.externalIds || {};
  const doi = externalIds.DOI || externalIds.Doi || null;
  const arxivId = externalIds.ArXiv || externalIds.ARXIV || null;

  return {
    paperId: data.paperId || null,
    corpusId: data.corpusId || null,
    title: data.title || null,
    authors: (data.authors || []).map((author) => author.name).filter(Boolean),
    year: data.year || extractYear(data.publicationDate),
    venue: data.venue || null,
    publicationDate: data.publicationDate || null,
    citationCount: typeof data.citationCount === "number" ? data.citationCount : null,
    doi,
    arxivId,
    identifier: doi ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : lookupId,
    lookupId: data.paperId || lookupId || null,
    sourceUrl: data.url || null,
    pdfUrl: data.openAccessPdf && data.openAccessPdf.url ? data.openAccessPdf.url : null,
    abstract: data.abstract || null,
    references: normalizeReferences(data.references),
    lastUpdated: nowIso(),
    citationSource: "Semantic Scholar"
  };
}

function normalizeOpenAlexPaper(data, lookupId) {
  if (!data) return null;
  const doi = data.doi ? normalizeDoi(data.doi) : null;
  const pdfUrl =
    data.open_access && data.open_access.oa_url ? data.open_access.oa_url :
    data.best_oa_location && data.best_oa_location.pdf_url ? data.best_oa_location.pdf_url :
    data.primary_location && data.primary_location.pdf_url ? data.primary_location.pdf_url :
    null;

  return {
    openAlexId: data.id || null,
    title: data.title || data.display_name || null,
    authors: normalizeOpenAlexAuthors(data.authorships),
    year: data.publication_year || extractYear(data.publication_date),
    venue: normalizeOpenAlexVenue(data),
    publicationDate: data.publication_date || null,
    citationCount: typeof data.cited_by_count === "number" ? data.cited_by_count : null,
    doi,
    identifier: doi ? `DOI:${doi}` : data.id || lookupId,
    lookupId: lookupId || null,
    sourceUrl:
      data.primary_location && data.primary_location.landing_page_url
        ? data.primary_location.landing_page_url
        : data.doi || data.id || null,
    pdfUrl,
    references: normalizeOpenAlexReferences(data.referenced_works),
    lastUpdated: nowIso(),
    citationSource: "OpenAlex"
  };
}

function normalizeOpenAlexAuthors(authorships) {
  if (!Array.isArray(authorships)) return [];
  return authorships
    .map((authorship) => authorship && authorship.author && authorship.author.display_name)
    .filter(Boolean);
}

function normalizeOpenAlexVenue(data) {
  const source =
    data.primary_location &&
    data.primary_location.source &&
    data.primary_location.source.display_name;
  return source || null;
}

function normalizeOpenAlexReferences(referencedWorks) {
  if (!Array.isArray(referencedWorks)) return [];
  return referencedWorks
    .filter(Boolean)
    .map((id) => ({
      openAlexId: id,
      title: null,
      year: null,
      citationCount: null,
      authors: []
    }));
}

function normalizeReferences(references) {
  if (!Array.isArray(references)) return [];
  return references
    .filter((ref) => ref && (ref.paperId || ref.title))
    .map((ref) => ({
      paperId: ref.paperId || null,
      title: ref.title || null,
      year: ref.year || null,
      citationCount: typeof ref.citationCount === "number" ? ref.citationCount : null,
      authors: (ref.authors || []).map((author) => author.name).filter(Boolean)
    }));
}

function mergePaperMetadata(base, fresh) {
  if (!fresh) return base || null;
  if (!base) return fresh;

  const merged = { ...base, ...fresh };
  merged.authors = fresh.authors && fresh.authors.length ? fresh.authors : base.authors || [];
  merged.references = fresh.references && fresh.references.length ? fresh.references : base.references || [];
  merged.urls = unique([...(base.urls || []), ...(fresh.urls || [])]);
  merged.sourceFiles = unique([...(base.sourceFiles || []), ...(fresh.sourceFiles || [])]);
  merged.sourceUrlsByFile = { ...(base.sourceUrlsByFile || {}), ...(fresh.sourceUrlsByFile || {}) };
  merged.pdfPath = fresh.pdfPath || base.pdfPath || null;
  merged.pdfUrl = fresh.pdfUrl || base.pdfUrl || null;
  merged.sourceUrl = fresh.sourceUrl || base.sourceUrl || null;
  merged.openAlexId = fresh.openAlexId || base.openAlexId || null;
  merged.paperId = fresh.paperId || base.paperId || null;
  merged.lookupId = fresh.lookupId || base.lookupId || null;
  merged.identifier = fresh.identifier || base.identifier || null;
  return merged;
}

function mergeCitationMetadata(base, fresh) {
  if (!fresh) return base || null;
  if (!base) return fresh;

  const merged = { ...base };
  if (typeof fresh.citationCount === "number") merged.citationCount = fresh.citationCount;
  if (fresh.references && fresh.references.length) merged.references = fresh.references;
  if (fresh.openAlexId) merged.openAlexId = fresh.openAlexId;
  if (!merged.pdfUrl && fresh.pdfUrl) merged.pdfUrl = fresh.pdfUrl;
  if (!merged.sourceUrl && fresh.sourceUrl) merged.sourceUrl = fresh.sourceUrl;
  merged.citationSource = fresh.citationSource || merged.citationSource;
  merged.lastUpdated = fresh.lastUpdated || nowIso();
  return merged;
}

function parseMetaTags(html) {
  const metas = {};
  const tagRegex = /<meta\s+[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(html)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRegex = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(tagMatch[0])) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[3] || attrMatch[4] || "";
    }
    const key = (attrs.name || attrs.property || "").toLowerCase();
    const content = attrs.content || "";
    if (!key || !content) continue;
    metas[key] = metas[key] || [];
    metas[key].push(content);
  }
  return metas;
}

function firstMeta(metas, key) {
  return first(allMeta(metas, key));
}

function allMeta(metas, key) {
  return metas[String(key).toLowerCase()] || [];
}

function parseHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]) : null;
}

function absolutizeUrl(url, baseUrl) {
  if (!url) return null;
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    return url;
  }
}

function extractYear(value) {
  if (!value) return null;
  const match = String(value).match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function titlesLookSame(a, b) {
  const left = normalizeTitleForCompare(a);
  const right = normalizeTitleForCompare(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.length > 12 && right.length > 12 && (left.includes(right) || right.includes(left));
}

function normalizeTitleForCompare(title) {
  return normalizeWhitespace(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractYearFromCrossrefDate(dateObject) {
  if (!dateObject) return null;
  const parts = dateObject["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0][0]) {
    return Number(parts[0][0]);
  }
  return null;
}

function findCrossrefPdfUrl(message) {
  const links = message.link || [];
  const pdf = links.find((link) => /pdf/i.test(link["content-type"] || "") || looksLikePdfUrl(link.URL || ""));
  return pdf ? pdf.URL : null;
}

function matchXmlTag(text, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1] : null;
}

function decodeXml(text) {
  return decodeHtml(text);
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)));
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function looksLikePdfUrl(url) {
  return /\.pdf(?:[?#].*)?$/i.test(String(url || ""));
}

function filenameTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "paper.pdf");
    return name.replace(/\.pdf$/i, "") || "Untitled paper";
  } catch (error) {
    return "Untitled paper";
  }
}

function makePdfFileName(paper) {
  const year = paper.year ? `${paper.year}-` : "";
  const title = sanitizeFileName(paper.title || "paper").slice(0, 110);
  const suffix = paper.arxivId ? `-${sanitizeFileName(paper.arxivId)}` : paper.doi ? `-${shortHash(paper.doi)}` : "";
  return `${year}${title}${suffix}.pdf`;
}

function sanitizeFileName(text) {
  return normalizeWhitespace(text)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "paper";
}

function shortHash(text) {
  let hash = 0;
  const value = String(text || "");
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function ensureFolder(app, folderPath) {
  const normalized = normalizePath(folderPath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

function comparePapersForDisplay(a, b) {
  const yearA = a.year || 9999;
  const yearB = b.year || 9999;
  if (yearA !== yearB) return yearA - yearB;
  return (b.citationCount || 0) - (a.citationCount || 0);
}

function comparePapersChronologically(a, b) {
  const yearA = a.year || 9999;
  const yearB = b.year || 9999;
  if (yearA !== yearB) return yearA - yearB;
  return (a.title || "").localeCompare(b.title || "");
}

function selectImportantPapers(papers, maxPapers) {
    const limit = Math.max(2, Number(maxPapers ?? 18));
  return papers
    .slice()
    .sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0))
    .slice(0, limit)
    .sort(comparePapersChronologically);
}

function buildPaperEdges(papers, idByPaperId) {
  const edges = [];
  const seen = new Set();

  for (const target of papers) {
    const refs = target.references || [];
    const candidates = refs
      .map((ref) => (ref.paperId ? idByPaperId.get(ref.paperId) : null))
      .filter(Boolean)
      .filter((source) => source.key !== target.key)
      .sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0))
      .slice(0, 2);

    for (const source of candidates) {
      const key = `${source.key}->${target.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source,
        target,
        label: inferRelationLabel(source, target, true)
      });
    }
  }

  if (edges.length > 0) return edges;

  for (let index = 1; index < papers.length; index += 1) {
    edges.push({
      source: papers[index - 1],
      target: papers[index],
      label: inferRelationLabel(papers[index - 1], papers[index], false)
    });
  }

  return edges;
}

function inferRelationLabel(source, target, cited) {
  const title = `${target.title || ""} ${target.abstract || ""}`.toLowerCase();
  if (/survey|review|benchmark/.test(title)) return "surveys and organizes";
  if (/transformer|attention/.test(title)) return "adds attention";
  if (/efficient|fast|lightweight|real-time/.test(title)) return "improves efficiency";
  if (/fusion|collaborat|cooperat|multi-agent|communication/.test(title)) return "improves fusion";
  if (/3d|point cloud|lidar/.test(title)) return "extends to 3D sensing";
  if (/robust|noise|uncertain/.test(title)) return "improves robustness";
  return cited ? "builds on" : "later development";
}

function renderNodeLabel(paper) {
  const author = first(paper.authors) || "Unknown";
  const year = paper.year || "n.d.";
  const citations = typeof paper.citationCount === "number" ? paper.citationCount : "?";
  return `${paper.title || "Untitled"}<br/>${author} et al., ${year}<br/>Cites: ${citations}`;
}

function escapeMermaidLabel(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ");
}

function escapeMarkdownCell(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function encodeMarkdownLink(path) {
  return String(path || "").replace(/ /g, "%20");
}

function formatAuthors(authors) {
  if (!authors || authors.length === 0) return "";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

function arrayFirst(value) {
  return Array.isArray(value) ? value[0] : value || null;
}

function first(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== ""))];
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
