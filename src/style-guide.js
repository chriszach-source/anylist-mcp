import fs from "fs";

// An optional style guide for how recipes and items are written in this
// AnyList. STYLE_GUIDE_FILE points to a Markdown file; on Render, upload it as
// a Secret File and point the variable at /etc/secrets/<name>. The file is
// read on each use, so an edit takes effect without a restart. A ```json
// block in it holds the rules the audit checks mechanically. Approach from
// Pipas/anylist-mcp's style guide.

export function loadStyleGuide() {
  const filePath = process.env.STYLE_GUIDE_FILE;
  if (!filePath) return null;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!text.trim()) return null;
  return { text, rules: parseRules(text) };
}

export function parseRules(text) {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return {};
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.error(`Style guide: ignoring invalid JSON rules block (${error.message})`);
    return {};
  }
}

// Sent as the server's MCP instructions, so the model has the guide from the
// start of a session.
export function styleGuideInstructions() {
  const guide = loadStyleGuide();
  if (!guide) return undefined;
  return `The owner of this AnyList has a style guide. Follow it whenever you create, import, or edit recipes, ingredients, meal plans, or shopping items.\n\n${guide.text}`;
}

export const STYLE_GUIDE_HINT =
  "\n\nStyle guide: before creating or changing recipes, read it with the `style_guide` tool and follow it.";
