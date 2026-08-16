export type SlackflowCommand = "draft" | null;

/** Parses only the compact commands that follow a Slackflow mention. */
export function parseSlackflowCommand(text: string): SlackflowCommand {
  const command = text.replace(/<@[^>]+>/g, "").trim().toLowerCase();

  if (command === "draft") {
    return command;
  }

  return null;
}
