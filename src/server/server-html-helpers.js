const ESCAPE_RE = /[&<>"]/g;
const ESCAPE_TEST_RE = /[&<>"]/;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function esc(s) {
  const str = String(s);
  if (!ESCAPE_TEST_RE.test(str)) return str;
  return str.replace(ESCAPE_RE, ch => ESCAPE_MAP[ch]);
}

const KNOWN_SUFFIX = "\n</body>\n</html>";

export function withLiveReload(html) {
  const script = `<script>(function(){var retries=0,maxRetries=5;function connect(){var es=new EventSource("/__livereload");retries=0;es.onmessage=function(e){if(e.data==="reload"){if(!window._stayLoaded)location.reload()}else if(e.data==="data-update"){if(window._refreshData)window._refreshData();else if(!window._stayLoaded)location.reload()}};es.onerror=function(){es.close();if(++retries<maxRetries)setTimeout(connect,2000*retries)}}connect()})();</script>`;
  if (html.endsWith(KNOWN_SUFFIX)) {
    const idx = html.length - KNOWN_SUFFIX.length + 1; // position of '<' in '</body>'
    return html.slice(0, idx) + script + html.slice(idx);
  }
  const idx = html.lastIndexOf("</body>");
  if (idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
  return html + script;
}