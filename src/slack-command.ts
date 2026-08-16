export type SlackflowCommand = "connect" | "disconnect" | "draft" | "help" | "schema" | "status" | null;

const SUPPORTED_COMMANDS = new Set<Exclude<SlackflowCommand, null>>([
  "connect",
  "disconnect",
  "draft",
  "help",
  "schema",
  "status"
]);

/** Parses only the compact commands that follow a Slackflow mention. */
export function parseSlackflowCommand(text: string): SlackflowCommand {
  const command = text.replace(/<@[^>]+>/g, "").trim().toLowerCase();

  if (SUPPORTED_COMMANDS.has(command as Exclude<SlackflowCommand, null>)) {
    return command as Exclude<SlackflowCommand, null>;
  }

  return null;
}
