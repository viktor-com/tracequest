import { fnSrc } from "../utils/fn-src.js";
import {
  shannonEntropy,
  redactMatchDisplay,
  normalizeRuleRegex,
  compileRules,
  textHasKeywords,
  isAllowlisted,
  scanText,
  scanObjectStrings,
  scanMcpInfo,
  scanDiffInfo,
  scanToolCall,
  scanAgentHistory,
  scanSessionScalars,
  scanSessionForSecrets,
} from "./scanner.js";
import { redactSession, redactString, redactValue, redactPemBlocks } from "./redactor.js";

/** Full scanner + redactor source for browser bundles (all helpers inlined). */
export function buildScannerRedactorSrc() {
  return [
    fnSrc(shannonEntropy),
    fnSrc(redactMatchDisplay),
    fnSrc(normalizeRuleRegex),
    fnSrc(compileRules),
    fnSrc(textHasKeywords),
    fnSrc(isAllowlisted),
    fnSrc(scanText),
    fnSrc(scanObjectStrings),
    fnSrc(scanMcpInfo),
    fnSrc(scanDiffInfo),
    fnSrc(scanToolCall),
    fnSrc(scanAgentHistory),
    fnSrc(scanSessionScalars),
    fnSrc(scanSessionForSecrets),
    fnSrc(redactString),
    fnSrc(redactValue),
    fnSrc(redactPemBlocks),
    fnSrc(redactSession),
  ].join("\n");
}