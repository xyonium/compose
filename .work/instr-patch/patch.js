const fs = require("fs"), path = require("path");
function walk(d) {
  let r = [];
  for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) r = r.concat(walk(f));
    else if (e.name.endsWith(".js")) r.push(f);
  }
  return r;
}

const bang = "**SearXNG !bang:** prefix the query to pick a source category: !science (papers/academic), !it (programming), !general (default web), !news, !images. For academic or research queries ALWAYS prefix with !science instead of adding keywords like \"research paper\" to the query. Example: \"!science continuous glucose monitoring sensor accuracy\".";

const cleanDesc = "LLM-based cleaning pass that removes residual boilerplate (cookie banners, ads, social widgets, breadcrumbs, comments) that onlyMainContent misses. Preserves headings, lists, tables, code blocks, links. Can combine with onlyMainContent. Auto-skipped (preserving original) if content exceeds model token limit. Recommended to enable for complex structured websites when speed is not critical. If the returned content is unexpectedly short or seems to be missing key content, try disabling this option and re-scraping.";

let n = 0;
for (const f of walk("/app/dist")) {
  let c = fs.readFileSync(f, "utf8");
  let modified = false;
  let logs = [];

  // 1. Insert !bang guidance into the search description, right after the
  //    operators sentence. Upstream removed the old "**Sources:**" anchor
  //    (v3.24-ish), so anchor on "the set is non-exhaustive." instead;
  //    idempotency guard checks the inserted marker itself.
  //    Escape via JSON.stringify minus the wrapping quotes: since the
  //    2026-09-28 image the first anchor occurrence sits inside a
  //    double-quoted .describe("...") in the bundle, so a raw " would
  //    terminate the string and break the whole file (crash loop).
  //    \" is harmless in template-literal / single-quoted contexts too.
  if (!c.includes("**SearXNG !bang:**") && c.includes("the set is non-exhaustive.")) {
    const bangEsc = JSON.stringify(bang).slice(1, -1);
    c = c.replace("the set is non-exhaustive.", "the set is non-exhaustive. " + bangEsc);
    modified = true; logs.push("!bang");
  }

  // 2. Add onlyCleanContent to schema after onlyMainContent
  if (!c.includes("onlyCleanContent")) {
    const nc = c.replace(
      /(onlyMainContent:\s*)(\w+)\.boolean\(\)\.optional\(\)/g,
      (m, p, v) => p + v + ".boolean().optional(),onlyCleanContent: " + v + ".boolean().optional().describe(\"" + cleanDesc + "\")"
    );
    if (nc !== c) { c = nc; modified = true; logs.push("onlyCleanContent"); }
  }

  // 3. (removed 2026-10-21) example-clean: upstream dropped the
  //    "onlyMainContent": true example literals in 3.23.0; verified a
  //    silent no-op across npm 3.23.0-3.33.4 and on the pinned deploy
  //    digest. Tombstone kept to preserve patch numbering.

  // 4. Strip the remaining feedback pointer from the search
  //    description. The prose trio ("**After the search:**" etc.)
  //    disappeared upstream in 3.23.0, but the rewrite left one tail
  //    line pointing at a tool this stack disables via
  //    FIRECRAWL_NO_SEARCH_FEEDBACK -- a guaranteed-dead pointer.
  //    Old digest: line absent, no-op by design (A/B verified).
  if (c.includes("for optional search feedback")) {
    const nc = c.replace(
      " Authenticated responses can include an \\`id\\` for optional search feedback.",
      ""
    );
    if (nc !== c) { c = nc; modified = true; logs.push("feedback-pointer-strip"); }
  }

  // 5. categories enum 保留全部四项：github/research/pdf 是 SearXNG 查询改写
  //    （自托管可用），developer 由本栈 research-proxy 服务兜底。
  //    research 工具同理（registerResearchTools 不再禁用）——均由
  //    RESEARCH_PROXY_URL -> research-proxy 提供。

  // 6. Disable monitor tools (cloud-only)
  if (c.includes("registerMonitorTools") && !c.includes("monitor-disabled")) {
    const before = c;
    c = c.replace(/registerMonitorTools\s*\([^)]*\)\s*;/g, "/* monitor-disabled */");
    if (c !== before) { modified = true; logs.push("monitor-disable"); }
  }

  // 7. Disable agent + interact tools (cloud-only)
  {
    const before = c;
    c = c.replace(
      /server\.addTool\((\s*\{\s*name:\s*[\x22\x27]firecrawl_(?:agent|agent_status|interact|interact_stop)[\x22\x27])/g,
      "(() => {})($1"
    );
    if (c !== before) { modified = true; logs.push("agent-interact-disable"); }
  }

  // 8. (removed 2026-10-21) agent-refs: the four scrape/map prose
  //    lines this strip targeted were removed upstream in 3.23.0;
  //    silent no-op since (verified on the pinned deploy digest).
  //    Agent/interact registration stays disabled via #7. Tombstone
  //    kept to preserve patch numbering.

  // 9. parse tool: this MCP is a remote deployment — filePath is resolved
  //    on the MCP container filesystem, so client-local paths always
  //    ENOENT. Upstream now explains local-vs-hosted generically; what it
  //    lacks is that THIS deployment is remote plus the concrete endpoint.
  //    Keep the note short; no backticks or dollar-brace (would break
  //    the template literal / compose interpolation), no apostrophes
  //    (would break the single-quoted node -e).
  if (!c.includes("REMOTE PARSE NOTE") && c.includes("Parse one supported document into markdown")) {
    c = c.replace(
      "Parse one supported document into markdown",
      "REMOTE PARSE NOTE: this MCP server is a remote deployment; filePath is resolved on the server filesystem and caller-local paths fail with ENOENT. To parse a caller-local file, POST it as multipart/form-data to https://" + (process.env.FIRECRAWL_DOMAIN || "firecrawl.example.com") + "/v2/parse (field file, plus an optional options JSON string). Parse one supported document into markdown"
    );
    modified = true; logs.push("parse-remote-note");
  }

  // 10. Disable credit_usage tool (cloud-only): self-hosted api has no
  //     Autumn billing backend (AUTUMN_SECRET_KEY missing -> 500). The
  //     tool registration call site is unique; commenting it out drops
  //     the tool plus its creditUsageOutputSchema cleanly. Upstream has
  //     no env switch for this (checked all FIRECRAWL_* env reads).
  if (c.includes("registerUsageTools(server, getClient);")) {
    c = c.replace(
      "registerUsageTools(server, getClient);",
      "/* usage-tools-disabled: no Autumn billing backend in self-host */"
    );
    modified = true; logs.push("usage-tools-disable");
  }

  // 11. Fill the empty .describe() slots on research tool params
  //     (upstream shipped them blank; the tool descriptions carry most
  //     of the semantics, so keep these to what a caller cannot infer
  //     from the name — no apostrophes here, see patch 9 note).
  //     Anchors are the unique zod param blocks; (\w+) capture makes
  //     the patch alias-agnostic so tsup z-aliasing (z6, z7, z9, z12)
  //     does not silently drift (root cause of 2026-10-21 dry-run
  //     pinned latest sync revert; upstream alias had moved z6 to z9).
  {
    const before = c;
    c = c.replace(
      /seed_ids: (\w+)\.array\(\1\.string\(\)\)\.min\(1\)\.max\(10\)(?!\.describe)/,
      "seed_ids: $1.array($1.string()).min(1).max(10).describe(\"1-10 paper IDs; the first is the seed, the rest are anchors.\")"
    );
    c = c.replace(
      /intent: (\w+)\.string\(\)\.min\(1\)(?!\.describe)/,
      "intent: $1.string().min(1).describe(\"What the related papers should be about; used to rank candidates.\")"
    );
    c = c.replace(
      /mode: (\w+)\.enum\(\[\"similar\", \"citers\", \"references\"\]\)\.optional\(\)(?!\.describe)/,
      "mode: $1.enum([\"similar\", \"citers\", \"references\"]).optional().describe(\"similar (default): co-citation/bibliographic coupling; citers: papers citing the seed; references: papers the seed cites.\")"
    );
    c = c.replace(
      /k: (\w+)\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\)(?!\.describe)/g,
      "k: $1.number().int().min(1).max(500).optional().describe(\"Number of ranked papers to return (default 10).\")"
    );
    c = c.replace(
      /question: (\w+)\.string\(\)\.min\(1\)(?!\.describe)/g,
      "question: $1.string().min(1).describe(\"What to look for in the full text; passages are selected by relevance to it.\")"
    );
    if (c !== before) { modified = true; logs.push("research-param-desc"); }
  }

  // 12. Disable find_tools (cloud-only): self-hosted api has no
  //     Alexandria catalogue, every call fails with "Alexandria
  //     requires an API key on a team with Alexandria access".
  //     The registration is a single unconditional statement.
  if (c.includes("server.addTool(findToolsTool);")) {
    c = c.replace(
      "server.addTool(findToolsTool);",
      "/* find-tools-disabled: no Alexandria catalogue in self-host */"
    );
    modified = true; logs.push("find-tools-disable");
  }

  // 13. Strip dead Alexandria guidance from the scrape/search
  //     descriptions: the paragraphs point at find_tools and the
  //     alexandria scrape mode, which cannot work self-hosted and
  //     otherwise lure the model into guaranteed-failure calls.
  //     Delete whole template paragraphs; anchors verified unique.
  //     Param-level .describe() mentions are left alone (dead but
  //     harmless). search-surface variants are /v2/mcp-search only,
  //     not used here.
  {
    const before = c;
    c = c.replace(
      "\n\nOn an authenticated session with Alexandria access, \\`firecrawl_search\\` with \\`sources\\` unset and \\`firecrawl_find_tools\\` can discover providers for the same fields across several pages; a matching provider returns typed records in one call. Keyless sessions have no provider matches.\n\nAlexandria mode, on an authenticated session with Alexandria access: \\`alexandria\\` selects catalogued capability execution and is mutually exclusive with \\`url\\`.\n",
      "\n"
    );
    c = c.replace(
      "\n\n${ALEXANDRIA_SEARCH_LEAD}\n\nOn an authenticated session, tool matches describe available capabilities; \\`firecrawl_find_tools\\` returns their contracts and \\`firecrawl_scrape\\` with an \\`alexandria\\` body executes a selected capability. Keyless sessions get no Alexandria matches in data.tools.",
      ""
    );
    if (c !== before) { modified = true; logs.push("alexandria-desc-strip"); }
  }

  // 13b. Same strip for the reworded scrape description: upstream
  //      rewrote the find_tools/alexandria guidance in 3.33.x, so the
  //      original #13 anchor no longer matches this variant. Kept as
  //      a separate block with its own mark so drift shows in logs;
  //      on the frozen digest this is a no-op (text absent there).
  if (c.includes("can discover providers for the same fields across several pages")) {
    const before = c;
    c = c.replace(
      "\n\n\\`firecrawl_search\\` and \\`firecrawl_find_tools\\` can discover providers for the same fields across several pages; a matching provider returns typed records in one call.\n\nWith \\`alexandria\\` in place of \\`url\\`, the tool runs catalogued provider capabilities instead of fetching a page. Provider discovery and execution require an API key on a team with Alexandria enabled.\n",
      "\n"
    );
    if (c !== before) { modified = true; logs.push("alexandria-desc-strip-v2"); }
  }

  // 14. Disable gov_search: the upstream tool goes to a US Government
  //     Index backend that only exists on the firecrawl cloud api --
  //     self-host has no route for it, every call would 404. Same
  //     reasoning as #7/#10/#12.
  if (c.includes("registerGovTools(server, getClient);")) {
    c = c.replace(
      "registerGovTools(server, getClient);",
      "/* gov-tools-disabled: no Government Index backend in self-host */"
    );
    modified = true; logs.push("gov-tools-disable");
  }

  // 15. Strip cloud-only guidance from FULL/KEYLESS profile
  //     instructions. The initialize instructions steer the agent more
  //     strongly than any single tool description (read first, every
  //     session): they still steer toward firecrawl_agent/-
  //     agent_status (disabled by #7), firecrawl_find_tools (#12),
  //     firecrawl_monitor_* (#6), firecrawl_gov_search (#14), and the
  //     Alexandria catalogue surface (no backend on self-host --
  //     a guaranteed-dead pointer per session). Both interpolation
  //     sources ALEXANDRIA_CATALOGUE_SENTENCE /
  //     ALEXANDRIA_SOURCES_ALWAYS_ON are blanked so every other
  //     hidden reference degrades to an empty string too.
  //     Dist bundles keep raw backslash-quote in Firecrawl\\x27s and
  //     a single-quoted string for SOURCES_ALWAYS_ON, so both source
  //     assignments are matched with hex-class regexes -- zero raw
  //     apostrophe in this body per AGENTS.md the sh transport rule.
  {
    const before = c;

    // 15a. Blank the two Alexandria interpolation consts. Dist bundles
    //     both as single-expression consts ending with ; before the
    //     next var -- match [^]*? up to the final quote boundary so
    //     upstream wording drift still lands on the whole assignment.
    c = c.replace(
      /var ALEXANDRIA_CATALOGUE_SENTENCE = "Alexandria is Firecrawl[^]*?published contracts\."/,
      "var ALEXANDRIA_CATALOGUE_SENTENCE = \"\""
    );
    c = c.replace(
      /var ALEXANDRIA_SOURCES_ALWAYS_ON = [\x22\x27]Authenticated searches[^]*?website-matched tools only\.[\x22\x27]/,
      "var ALEXANDRIA_SOURCES_ALWAYS_ON = \"\""
    );

    // 15b. FULL: capability-list opener -- drop monitoring and
    //     multi-source research wording (agent + monitor both off).
    c = c.replace(
      "Firecrawl provides web search, page retrieval, site URL discovery, multi-page collection, structured page data, monitoring, and multi-source research that returns structured data.",
      "Firecrawl provides web search, page retrieval, site URL discovery, multi-page collection, and structured page data."
    );

    // 15c. FULL: rewrite tool-boundary sentence (drop agent/agent_status).
    c = c.replace(
      "Match the requested operation to the tool boundary: firecrawl_scrape retrieves one supplied page and can return JSON matching a supplied schema, firecrawl_map enumerates URLs under a site without retrieving their content, and firecrawl_agent runs multi-source research and returns structured data when the URLs are not known or the answer spans several sites (an entity plus its fields, a list, a dataset); its result is read with firecrawl_agent_status.",
      "Match the requested operation to the tool boundary: firecrawl_scrape retrieves one supplied page and can return JSON matching a supplied schema, and firecrawl_map enumerates URLs under a site without retrieving their content."
    );

    // 15d. FULL: strip Alexandria provider/discovery sentences.
    c = c.replace(
      " Authenticated firecrawl_search returns web results together with matching Alexandria providers in data.tools.",
      ""
    );
    c = c.replace(
      " ${ALEXANDRIA_CATALOGUE_SENTENCE} A matching provider can return the same fields across several entities, provenance, exact figures or timestamps, or a large set of records through firecrawl_scrape with its published contract.",
      ""
    );
    c = c.replace(
      " For the same fields across multiple pages, firecrawl_find_tools offers free provider discovery. Use firecrawl_find_tools to read a contract that was not returned in full or to browse the catalogue by category.",
      ""
    );
    c = c.replace(
      " ${ALEXANDRIA_SOURCES_ALWAYS_ON} If no provider fits, continue with web search or firecrawl_agent.",
      ""
    );

    // 15e. FULL: strip gov-search + alexandria-sources tail block.
    c = c.replace(
      " For a legal or regulatory question, firecrawl_gov_search searches primary law and regulatory material from US federal, state, and local government sources: statutes, regulations, codes, court opinions, and other government publications; firecrawl_search with categories: [\"gov\"] reaches the same sources and cannot be combined with other categories. firecrawl_search with sources: [{type: \"alexandria\"}] returns compact tool summaries in data.tools; toolDetail: \"full\" includes contracts, firecrawl_find_tools starts with categories, lists providers, then compact tools, and expands the selected full contract, and firecrawl_scrape with alexandria: [{provider, capability, options}] executes up to ten capabilities and returns their results. Alexandria access needs an API key on a team with it enabled.",
      ""
    );

    // 15f. KEYLESS: drop gov categories line.
    c = c.replace(
      " For legal or regulatory questions, firecrawl_search with categories: [\"gov\"] searches US government legal and regulatory sources and cannot be combined with other categories.",
      ""
    );

    // 15g. KEYLESS: rewrite bearer-key tail (drop agent/find_tools/Alexandria).
    c = c.replace(
      "An Authorization bearer API key can provide higher usage limits and expose additional tools, subject to plan, deployment, and team policy, including firecrawl_map for site URL discovery, firecrawl_agent and firecrawl_agent_status for multi-source research that returns structured data when the URLs are not known, firecrawl_research_* for paper-index and repository research, and firecrawl_find_tools as the progressive Alexandria catalogue lookup alongside the Alexandria options of firecrawl_search and firecrawl_scrape for catalogued data providers.",
      "An Authorization bearer API key can provide higher usage limits and expose additional tools, subject to plan, deployment, and team policy, including firecrawl_map for site URL discovery and firecrawl_research_* for paper-index and repository research."
    );

    // 15h. firecrawl_search main description still steers to the
    //     disabled gov tool -- the sentence names firecrawl_gov_search
    //     as the dedicated tool for legal/regulatory questions, a dead
    //     pointer on the live 11-tool surface (same class as the #4
    //     feedback pointer). Strip the sentence; leave the research
    //     category sentence that follows intact.
    c = c.replace(
      / For a legal or regulatory question,[^]*?before citing current law\./g,
      ""
    );

    // 15j. SEARCH_PROFILE_INSTRUCTIONS (firecrawl_search service
    //     profile): the full list-of-features sentence still names
    //     firecrawl_find_tools and Alexandria catalogue copy. Strip
    //     per sentence so wording drift in the preamble stays no-op.
    c = c.replace(
      " Use firecrawl_search to find relevant results across the web and specialized indexes; authenticated searches also return matching Alexandria providers in data.tools. firecrawl_find_tools provides catalogue browsing and provider contracts; firecrawl_scrape with an alexandria body executes a selected capability; firecrawl_scrape with a url retrieves one supplied page.",
      " Use firecrawl_search to find relevant results across the web and specialized indexes. firecrawl_scrape with a url retrieves one supplied page."
    );
    c = c.replace(
      " For a biomedical, life-science, clinical, or arXiv literature question, the firecrawl_research_* tools search the paper index, while categories: [\"research\"] on firecrawl_search filters ordinary web results to research-affiliated websites. Use the firecrawl_research_* tools to search academic and research literature, expand from anchor papers via the citation graph, and read full-text passages from a specific paper. Search and discovery tools are read-only and return ranked results.",
      " Use the firecrawl_research_* tools to search academic and research literature, expand from anchor papers via the citation graph, and read full-text passages from a specific paper."
    );
    // Billing line drops the gov-search free note and the dead
    //     Alexandria-discovery prices clause.
    c = c.replace(
      " Billing: web, developer, and research search are billed per request; government search is free; Alexandria discovery (firecrawl_search with sources [\"alexandria\"] alone, and firecrawl_find_tools) is free; firecrawl_scrape is billed, as a page retrieval in url mode or per executed capability in alexandria mode (pass includeCosts to firecrawl_find_tools to see prices).",
      " firecrawl_scrape is billed per retrieved page in url mode."
    );

    // 15k. ALEXANDRIA_SEARCH_INSTRUCTIONS is compile-time folded into
    //     SEARCH_PROFILE_INSTRUCTIONS, so blanking the const alone
    //     does not undo the Alexandria catalogue copy already inlined
    //     in the live description. Rewrite the SEARCH_PROFILE template
    //     as a whole with the stripped wording. SEARCH_PROFILE serves
    //     the mcp-search endpoint profile we do not expose, but the
    //     description is still end-user visible via
    //     firecrawl_search toolDetail=full.
    c = c.replace(
      /var SEARCH_PROFILE_INSTRUCTIONS = ALEXANDRIA_SEARCH_INSTRUCTIONS \+ ` Firecrawl provides[^]*?Returns result groups in \\`data\\` and an operation \\`id\\`\.\n`,/,
      "var SEARCH_PROFILE_INSTRUCTIONS = ` Firecrawl provides web, developer, and research search. Use firecrawl_search to find relevant results across the web and specialized indexes. firecrawl_scrape with a url retrieves one supplied page. For a programming question, firecrawl_developer_search searches indexed public repositories, GitHub issues, merged pull requests, READMEs, and code documentation and returns the matched passages, and skills: \"only\" narrows it to agent-skill files; firecrawl_search with categories: [\"developer\"] reaches the same index beside ordinary web results, returning the hits in the web group rather than as passages and offering no skills filter. For a biomedical, life-science, clinical, or arXiv literature question, the firecrawl_research_* tools search the paper index, while categories: [\"research\"] on firecrawl_search filters ordinary web results to research-affiliated websites. Use the firecrawl_research_* tools to search academic and research literature, expand from anchor papers via the citation graph, and read full-text passages from a specific paper. Search and discovery tools are read-only and return ranked results. Billing: web, developer, and research search are billed per request; firecrawl_scrape is billed per retrieved page. Returns result groups in \\`data\\` and an operation \\`id\\`.\n\n`"
    );

    // 15l. searchQueryIsValid refine error message in the live
    //     firecrawl_search tool still points at the disabled
    //     firecrawl_find_tools -- the agent sees this string on an
    //     empty query. Rewrite it.
    c = c.replace(
      "A query is required. Use firecrawl_find_tools to browse the catalogue.",
      "A query is required."
    );

    if (c !== before) { modified = true; logs.push("instr-desc-strip"); }
  }

  if (modified) {
    fs.writeFileSync(f, c);
    n++;
    console.log("Patched [" + logs.join(",") + "]: " + f);
  }
}
console.log("Total patched: " + n);
