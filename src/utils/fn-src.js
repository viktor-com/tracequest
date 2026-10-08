/**
 * Serialize a function for injection into browser bundles.
 * Strips a leading ESM `export ` prefix when present in Function#toString output.
 * @param {Function} fn
 * @returns {string}
 */
export function fnSrc(fn) {
  return fn.toString().replace(/^export /, "");
}