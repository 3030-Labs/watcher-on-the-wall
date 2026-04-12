/**
 * Public surface of the wiki module.
 */
export { parsePage, serializePage, newPage } from "./page.js";
export { WikiStore, CATEGORY_DIRS, sanitizeSlug, slugFromPath, pageStat } from "./store.js";
export { IndexManager } from "./index-manager.js";
export { WikiSearch, type SearchHit, type SearchFilters } from "./search.js";
export {
  repairBidirectionalLinks,
  extractWikiLinks,
  normalizeSlug,
  toWikiSlug,
} from "./cross-reference.js";
