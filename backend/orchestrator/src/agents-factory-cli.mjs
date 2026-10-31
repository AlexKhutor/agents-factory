#!/usr/bin/env node

// agents-factory: install and run Agents Factory without an LLM and without
// PowerShell (docs/distribution/cli.md, stage-0.md). Everything is in
// agents-factory-commands.mjs; this file only runs it.

import { runCli } from "./agents-factory-commands.mjs";

process.exitCode = await runCli(process.argv.slice(2));
