import { readFile } from "node:fs/promises";

export type ImagePromptInput = {
  content: string;
  title: string;
};

const templateUrl = new URL("../../prompts/image-generation.txt", import.meta.url);

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`Cannot render an image prompt without ${label}.`);
  }

  return value.trim();
}

/**
 * Renders the user's checked-in prompt verbatim except for its two documented
 * runtime placeholders: {blog title} and {blog content}.
 */
export function renderImagePrompt(template: string, input: ImagePromptInput): string {
  const replacements: Record<string, string> = {
    "{blog title}": requireNonEmpty(input.title, "a title"),
    "{blog content}": requireNonEmpty(input.content, "blog content")
  };

  let rendered = template;

  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }

  if (rendered.includes("{blog title}") || rendered.includes("{blog content}")) {
    throw new Error("Image prompt template contains an unresolved placeholder.");
  }

  return rendered;
}

export async function loadImagePrompt(input: ImagePromptInput): Promise<string> {
  const template = await readFile(templateUrl, "utf8");
  return renderImagePrompt(template, input);
}
