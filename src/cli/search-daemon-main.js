#!/usr/bin/env node
// Entry of the resident search process (see search-daemon.js).
import { enableCompileCache } from "node:module";
import { runSearchDaemon } from "./search-daemon.js";

enableCompileCache?.();
runSearchDaemon(process.argv[2]).catch(() => process.exit(1));
