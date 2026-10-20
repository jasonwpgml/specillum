#!/usr/bin/env node
import { ensureStation, port, profileDir } from "./station.js";
import { runServer } from "./server.js";

const HELP = `specillum — isolated browser pods for AI agents in your own logged-in Chrome

Usage:
  specillum          Run the MCP server over stdio (what your agent launches)
  specillum open     Open the station browser so you can log in to sites once
  specillum help     Show this help

Environment:
  SPECILLUM_PORT      Debugging port of the station (default 9333)
  SPECILLUM_PROFILE   Profile directory (default ${profileDir()})
  SPECILLUM_CHROME    Path to Chrome/Edge/Chromium
  SPECILLUM_POD       Fixed label for this agent's pod
  SPECILLUM_KEEP_POD  Set to 1 to keep the pod window open after the agent exits
  SPECILLUM_POD_WINDOW  visible (default) or minimized
  SPECILLUM_WINDOW    Pod window size (default 1280x900)
`;

const command = process.argv[2];

if (command === "open") {
  await ensureStation();
  console.log(`Station is running on 127.0.0.1:${port} with profile ${profileDir()}.\nLog in to the sites your agents need; logins are shared by every pod.`);
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
} else if (command === undefined) {
  await runServer();
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}
