import { defineCommand, runMain } from 'citty';
import { logger } from '@mcpmake/core';
import openapiCommand from './commands/from/openapi.js';
import harCommand from './commands/from/har.js';
import urlCommand from './commands/from/url.js';
import describeCommand from './commands/from/describe.js';
import postmanCommand from './commands/from/postman.js';
import websiteCommand from './commands/from/website.js';
import stainlessCommand from './commands/from/stainless.js';
import verifyCommand from './commands/verify.js';
import updateCommand from './commands/update.js';
import deployCommand from './commands/deploy.js';
import publishCommand from './commands/publish.js';
import mergeCommand from './commands/merge.js';
import lintCommand from './commands/lint.js';
import diffCommand from './commands/diff.js';
import bundleCommand from './commands/bundle.js';
import ciCommand from './commands/ci.js';
import rescanCommand from './commands/rescan.js';

const fromCommand = defineCommand({
  meta: {
    name: 'from',
    description: 'Generate an MCP server from a source',
  },
  subCommands: {
    openapi: openapiCommand,
    har: harCommand,
    url: urlCommand,
    describe: describeCommand,
    postman: postmanCommand,
    website: websiteCommand,
    stainless: stainlessCommand,
  },
});

const main = defineCommand({
  meta: {
    name: 'mcpmake',
    version: '0.1.0',
    description: 'Generate MCP servers from API specifications',
  },
  subCommands: {
    from: fromCommand,
    merge: mergeCommand,
    verify: verifyCommand,
    update: updateCommand,
    deploy: deployCommand,
    publish: publishCommand,
    lint: lintCommand,
    diff: diffCommand,
    bundle: bundleCommand,
    ci: ciCommand,
    rescan: rescanCommand,
  },
});

// Last-resort handlers for *unexpected* throws (the command failure sites use
// `fail()` instead). These fire too late to reliably await a network POST — the
// process is already tearing down — so we only log and signal a failed exit.
process.on('uncaughtException', (err) => {
  logger.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exitCode = 1;
});

runMain(main);
