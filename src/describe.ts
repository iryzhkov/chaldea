// Static discovery metadata. Importing this module never loads a service or config.
export const description = {
  "name": "chaldea",
  "summary": "Fleet compute, quota observation, durable waits, decisions and access trust.",
  "help": "chaldea --help",
  "commands": [
    {
      "name": "exec",
      "summary": "Run a command on a fleet job host",
      "access": "write"
    },
    {
      "name": "exec list",
      "summary": "List retained jobs and prune expired local state",
      "access": "write"
    },
    {
      "name": "exec show",
      "summary": "Show a retained job and prune expired local state",
      "access": "write"
    },
    {
      "name": "exec fetch",
      "summary": "Recover job output and artifacts",
      "access": "write"
    },
    {
      "name": "quota observe",
      "summary": "Record quota events and optionally switch providers",
      "access": "write"
    },
    {
      "name": "t3 set-auto-resume",
      "summary": "Change T3 auto-resume settings",
      "access": "write"
    },
    {
      "name": "wait time",
      "summary": "Register a durable time wait",
      "access": "write"
    },
    {
      "name": "wait thread",
      "summary": "Register a thread completion wait",
      "access": "write"
    },
    {
      "name": "wait status",
      "summary": "Read a durable wait",
      "access": "read"
    },
    {
      "name": "wait cancel",
      "summary": "Cancel a durable wait",
      "access": "write"
    },
    {
      "name": "decision prepare",
      "summary": "Register native decision policy",
      "access": "write"
    },
    {
      "name": "decision track",
      "summary": "Track a native decision",
      "access": "write"
    },
    {
      "name": "decision ask",
      "summary": "Create a decision request",
      "access": "write"
    },
    {
      "name": "decision answer",
      "summary": "Answer a decision request",
      "access": "write"
    },
    {
      "name": "decision status",
      "summary": "Read a decision request",
      "access": "read"
    },
    {
      "name": "waits serve",
      "summary": "Run the durable waits service",
      "access": "write"
    },
    {
      "name": "mcp",
      "summary": "Serve waits and decision MCP operations",
      "access": "write"
    },
    {
      "name": "access initialize-state",
      "summary": "Initialize trust high-water state",
      "access": "write"
    },
    {
      "name": "access clock-health",
      "summary": "Write chrony health evidence",
      "access": "write"
    },
    {
      "name": "access install-bundle",
      "summary": "Install a verified trust bundle",
      "access": "write"
    },
    {
      "name": "access sign-bundle",
      "summary": "Sign and install a trust bundle",
      "access": "write"
    },
    {
      "name": "access verify",
      "summary": "Verify a token and update trust high-water state",
      "access": "write"
    }
  ]
} as const;

export const discoveryHelp = "Commands (read/write describes all effects, including local state):\n" +
  description.commands.map(c => "  chaldea " + c.name + " [" + c.access + "]  " + c.summary).join("\n") +
  "\nRun chaldea <group> --help for details; exec accepts --help.\n";
