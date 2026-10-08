import {
  estimateParsedStatsCost,
  estimateChapterTokenCost,
  getModelRates,
  fmtTokens,
  fmtCost,
  formatDuration,
  fmtPct,
  fmtMcpName,
} from "../filter/filter-formats.js";
import {
  FIRST_PROMPT_MAX_LEN,
  INDEX_OF_LOWER_JS,
  includesLower,
  safeSlice,
  shortToolPath,
  parseWebSearchLinks,
  countWords,
  countWordsInStrings,
  countNonEmptyLines,
  joinFirstLines,
  joinFirstNonEmptyLines,
} from "../parse/parse-utils.js";
import { detectGitOp, extractCommitMessageFromMFlag } from "../utils/git-op.js";
import {
  newChapter,
  buildChapterEventMaps,
  accumulateAssistantToolCall,
} from "../chapters/chapter-accumulate.js";
import {
  CORRECTION_HINT_RE,
  markUserPromptCorrections,
  countSelfCorrections,
  bashSplitFirstToken,
  bashFirstTwoTokens,
  compareToolTargets,
  isSameTarget,
  isSimilarInput,
  isSameCallTarget,
  isSimilarCallEntry,
} from "../chapters/chapter-patterns.js";
import {
  detectChapterRetries,
  classifyChapterOutcome,
  countGitOpsOfType,
  countOkCommands,
  computeChapterEfficiency,
  enrichChaptersEfficiency,
  enrichChaptersQualityCore,
} from "../chapters/chapter-quality.js";
import { enrichChaptersForRender } from "../chapters/chapter-render-enrich.js";
import { chapterFileKeys, chapterToolKeys } from "../chapters/chapter-keys.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { CHAPTERS_JS } from "./render-chapters.js";
import { UI_DETAIL_JS } from "./render-ui-detail.js";
import { UI_CHAPTERS_JS } from "./render-ui-chapters.js";
import { UI_ERRORS_JS } from "./render-ui-errors.js";
import { ANALYTICS_JS } from "./render-analytics-compose.js";
import { CORE_JS } from "./render-core.js";
import { INTERACTIONS_JS } from "./render-interactions.js";
import { MAIN_JS } from "./render-main.js";
import { SHARE_JS } from "./render-share.js";
import { joinBundleParts } from "./join-bundle.js";
import { fnSrc } from "../utils/fn-src.js";

const INCLUDES_LOWER_SRC = `${INDEX_OF_LOWER_JS}\n${fnSrc(includesLower)}`;
const GET_MODEL_RATES_SRC = fnSrc(getModelRates);
const ESTIMATE_PARSED_STATS_COST_SRC = estimateParsedStatsCost.toString();
const ESTIMATE_CHAPTER_TOKEN_COST_SRC = estimateChapterTokenCost.toString();
const FMT_TOKENS_SRC = fnSrc(fmtTokens);
const FMT_COST_SRC = fnSrc(fmtCost);
const FMT_PCT_SRC = fnSrc(fmtPct);
const FORMAT_DURATION_SRC = fnSrc(formatDuration);
const FMT_MCP_NAME_SRC = fnSrc(fmtMcpName);

const FIRST_PROMPT_MAX_LEN_SRC = `const FIRST_PROMPT_MAX_LEN = ${FIRST_PROMPT_MAX_LEN};`;
const SAFE_SLICE_SRC = fnSrc(safeSlice);
const SHORT_TOOL_PATH_SRC = fnSrc(shortToolPath);
const PARSE_WEB_SEARCH_LINKS_SRC = fnSrc(parseWebSearchLinks);
const COUNT_NON_EMPTY_LINES_SRC = fnSrc(countNonEmptyLines);
const JOIN_FIRST_LINES_SRC = fnSrc(joinFirstLines);
const JOIN_FIRST_NON_EMPTY_LINES_SRC = fnSrc(joinFirstNonEmptyLines);
const COUNT_WORDS_SRC = fnSrc(countWords);
const COUNT_WORDS_IN_STRINGS_SRC = fnSrc(countWordsInStrings);
const EXTRACT_COMMIT_MESSAGE_FROM_M_FLAG_SRC = fnSrc(extractCommitMessageFromMFlag);
const DETECT_GIT_OP_SRC = fnSrc(detectGitOp);
const BUILD_CHAPTER_EVENT_MAPS_SRC = fnSrc(buildChapterEventMaps);
const ACCUMULATE_ASSISTANT_TOOL_CALL_SRC = fnSrc(accumulateAssistantToolCall);
const NEW_CHAPTER_SRC = fnSrc(newChapter);
const BASH_SPLIT_FIRST_TOKEN_SRC = fnSrc(bashSplitFirstToken);
const BASH_FIRST_TWO_TOKENS_SRC = fnSrc(bashFirstTwoTokens);
const COMPARE_TOOL_TARGETS_SRC = fnSrc(compareToolTargets);
const IS_SAME_TARGET_SRC = fnSrc(isSameTarget);
const IS_SIMILAR_INPUT_SRC = fnSrc(isSimilarInput);
const IS_SAME_CALL_TARGET_SRC = fnSrc(isSameCallTarget);
const IS_SIMILAR_CALL_ENTRY_SRC = fnSrc(isSimilarCallEntry);
const CORRECTION_HINT_RE_SRC = `const CORRECTION_HINT_RE = ${CORRECTION_HINT_RE.toString()};`;
const MARK_USER_PROMPT_CORRECTIONS_SRC = fnSrc(markUserPromptCorrections);
const COUNT_SELF_CORRECTIONS_SRC = fnSrc(countSelfCorrections);
const DETECT_CHAPTER_RETRIES_SRC = fnSrc(detectChapterRetries);
const CLASSIFY_CHAPTER_OUTCOME_SRC = fnSrc(classifyChapterOutcome);
const COUNT_GIT_OPS_OF_TYPE_SRC = fnSrc(countGitOpsOfType);
const COUNT_OK_COMMANDS_SRC = fnSrc(countOkCommands);
const COMPUTE_CHAPTER_EFFICIENCY_SRC = fnSrc(computeChapterEfficiency);
const ENRICH_CHAPTERS_QUALITY_CORE_SRC = fnSrc(enrichChaptersQualityCore);
const ENRICH_CHAPTERS_EFFICIENCY_SRC = fnSrc(enrichChaptersEfficiency);
const BUILD_SESSION_CHAPTERS_SRC = fnSrc(buildSessionChapters);
const ENRICH_CHAPTERS_FOR_RENDER_SRC = fnSrc(enrichChaptersForRender);
const CHAPTER_FILE_KEYS_SRC = fnSrc(chapterFileKeys);
const CHAPTER_TOOL_KEYS_SRC = fnSrc(chapterToolKeys);

/** Named segments of chapter helper injection (order matters for browser VM). */
export const CHAPTERS_BUNDLE_PARTS = [
  { id: "chapterFileKeys", source: CHAPTER_FILE_KEYS_SRC },
  { id: "chapterToolKeys", source: CHAPTER_TOOL_KEYS_SRC },
  { id: "firstPromptMaxLen", source: FIRST_PROMPT_MAX_LEN_SRC },
  { id: "safeSlice", source: SAFE_SLICE_SRC },
  { id: "shortToolPath", source: SHORT_TOOL_PATH_SRC },
  { id: "parseWebSearchLinks", source: PARSE_WEB_SEARCH_LINKS_SRC },
  { id: "countNonEmptyLines", source: COUNT_NON_EMPTY_LINES_SRC },
  { id: "joinFirstLines", source: JOIN_FIRST_LINES_SRC },
  { id: "joinFirstNonEmptyLines", source: JOIN_FIRST_NON_EMPTY_LINES_SRC },
  { id: "countWords", source: COUNT_WORDS_SRC },
  { id: "countWordsInStrings", source: COUNT_WORDS_IN_STRINGS_SRC },
  { id: "extractCommitMessageFromMFlag", source: EXTRACT_COMMIT_MESSAGE_FROM_M_FLAG_SRC },
  { id: "detectGitOp", source: DETECT_GIT_OP_SRC },
  { id: "buildChapterEventMaps", source: BUILD_CHAPTER_EVENT_MAPS_SRC },
  { id: "accumulateAssistantToolCall", source: ACCUMULATE_ASSISTANT_TOOL_CALL_SRC },
  { id: "newChapter", source: NEW_CHAPTER_SRC },
  { id: "bashSplitFirstToken", source: BASH_SPLIT_FIRST_TOKEN_SRC },
  { id: "bashFirstTwoTokens", source: BASH_FIRST_TWO_TOKENS_SRC },
  { id: "compareToolTargets", source: COMPARE_TOOL_TARGETS_SRC },
  { id: "isSameTarget", source: IS_SAME_TARGET_SRC },
  { id: "isSimilarInput", source: IS_SIMILAR_INPUT_SRC },
  { id: "isSameCallTarget", source: IS_SAME_CALL_TARGET_SRC },
  { id: "isSimilarCallEntry", source: IS_SIMILAR_CALL_ENTRY_SRC },
  { id: "correctionHintRe", source: CORRECTION_HINT_RE_SRC },
  { id: "markUserPromptCorrections", source: MARK_USER_PROMPT_CORRECTIONS_SRC },
  { id: "countSelfCorrections", source: COUNT_SELF_CORRECTIONS_SRC },
  { id: "detectChapterRetries", source: DETECT_CHAPTER_RETRIES_SRC },
  { id: "classifyChapterOutcome", source: CLASSIFY_CHAPTER_OUTCOME_SRC },
  { id: "countGitOpsOfType", source: COUNT_GIT_OPS_OF_TYPE_SRC },
  { id: "countOkCommands", source: COUNT_OK_COMMANDS_SRC },
  { id: "computeChapterEfficiency", source: COMPUTE_CHAPTER_EFFICIENCY_SRC },
  { id: "enrichChaptersQualityCore", source: ENRICH_CHAPTERS_QUALITY_CORE_SRC },
  { id: "buildSessionChapters", source: BUILD_SESSION_CHAPTERS_SRC },
  { id: "enrichChaptersEfficiency", source: ENRICH_CHAPTERS_EFFICIENCY_SRC },
  { id: "enrichChaptersForRender", source: ENRICH_CHAPTERS_FOR_RENDER_SRC },
];

/** Function names that must appear in the assembled chapter helpers (smoke coverage). */
export const CHAPTERS_BUNDLE_FUNCTION_NAMES = [
  "chapterFileKeys",
  "chapterToolKeys",
  "safeSlice",
  "shortToolPath",
  "parseWebSearchLinks",
  "countNonEmptyLines",
  "joinFirstLines",
  "joinFirstNonEmptyLines",
  "countWords",
  "countWordsInStrings",
  "extractCommitMessageFromMFlag",
  "detectGitOp",
  "buildChapterEventMaps",
  "accumulateAssistantToolCall",
  "newChapter",
  "bashSplitFirstToken",
  "bashFirstTwoTokens",
  "compareToolTargets",
  "isSameTarget",
  "isSimilarInput",
  "isSameCallTarget",
  "isSimilarCallEntry",
  "markUserPromptCorrections",
  "countSelfCorrections",
  "detectChapterRetries",
  "classifyChapterOutcome",
  "countGitOpsOfType",
  "countOkCommands",
  "computeChapterEfficiency",
  "enrichChaptersQualityCore",
  "buildSessionChapters",
  "enrichChaptersEfficiency",
  "enrichChaptersForRender",
];

/** Join chapter pipeline helpers into one script block for the session viewer. */
export function buildChaptersHelpersScript() {
  return joinBundleParts(CHAPTERS_BUNDLE_PARTS);
}

/** Pre-built chapter helpers embedded in UI_JS and RENDER_JS. */
export const CHAPTERS_HELPERS_JS = buildChaptersHelpersScript();

/** Named segments of the session viewer UI script block (order matters). */
export const UI_BUNDLE_PARTS = [
  { id: "ui-errors", source: UI_ERRORS_JS },
  { id: "chapters-helpers", source: CHAPTERS_HELPERS_JS },
  { id: "chapters", source: CHAPTERS_JS },
  { id: "ui-chapters", source: UI_CHAPTERS_JS },
  { id: "ui-detail", source: UI_DETAIL_JS },
];

/** Pre-built UI script embedded in RENDER_JS. */
export const UI_JS = joinBundleParts(UI_BUNDLE_PARTS);

/** Named segments of the self-contained session viewer script (order matters). */
export const RENDER_BUNDLE_PARTS = [
  { id: "wrapper-open", source: "(function() {" },
  { id: "includesLower", source: INCLUDES_LOWER_SRC },
  { id: "getModelRates", source: GET_MODEL_RATES_SRC },
  { id: "estimateParsedStatsCost", source: ESTIMATE_PARSED_STATS_COST_SRC },
  { id: "estimateChapterTokenCost", source: ESTIMATE_CHAPTER_TOKEN_COST_SRC },
  { id: "fmtTokens", source: FMT_TOKENS_SRC },
  { id: "fmtCost", source: FMT_COST_SRC },
  { id: "fmtPct", source: FMT_PCT_SRC },
  { id: "formatDuration", source: FORMAT_DURATION_SRC },
  { id: "fmtMcpName", source: FMT_MCP_NAME_SRC },
  { id: "core", source: CORE_JS },
  ...UI_BUNDLE_PARTS.map((p) => ({ id: p.id, source: "  " + p.source })),
  { id: "analytics", source: "  " + ANALYTICS_JS },
  { id: "main", source: MAIN_JS },
  { id: "interactions", source: "  " + INTERACTIONS_JS },
  { id: "share", source: "  " + SHARE_JS },
  { id: "bootstrap-readUrlState", source: "  // Read URL state before first render" },
  { id: "bootstrap-readUrlState-call", source: "  readUrlState();" },
  { id: "bootstrap-render", source: "  render();" },
  { id: "wrapper-close", source: "})();" },
];

/** Function names that must appear in the assembled client bundle (smoke coverage). */
export const RENDER_BUNDLE_FUNCTION_NAMES = [
  "getModelRates",
  "estimateParsedStatsCost",
  "estimateChapterTokenCost",
  "fmtTokens",
  "fmtCost",
  "fmtPct",
  "formatDuration",
  "fmtMcpName",
  "readUrlState",
  "render",
  "buildChapters",
  "getChapters",
  "renderHeader",
  "renderChapters",
  "attachExpandToggles",
  "openShareModal",
  "scanSessionForSecrets",
  "shareGist",
  "shareHf",
];

/** Join injected filter-format helpers with render-* modules into one IIFE script. */
export function buildRenderScript() {
  return joinBundleParts(RENDER_BUNDLE_PARTS);
}

/** Pre-built session viewer script embedded in renderHTML. */
export const RENDER_JS = buildRenderScript();