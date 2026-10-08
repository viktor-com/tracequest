import '../helpers/skip-lr-watch-env.js';
import { installModVersionTestHygiene } from '../helpers/mod-version-hygiene.js';
import { registerApiSessionsCacheLiveTests } from '../lib/api-sessions-cache-suite.js';

installModVersionTestHygiene();
import { registerApiSearchCacheTests } from '../lib/api-search-cache-suite.js';

registerApiSessionsCacheLiveTests();
registerApiSearchCacheTests();