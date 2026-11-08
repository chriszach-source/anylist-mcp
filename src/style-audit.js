// Mechanical checks of a recipe against the style guide. Reports only; changes
// nothing. Works on AnyList's structured ingredient fields (quantity, name,
// note, heading), not the stored text. Checks from Pipas/anylist-mcp's audit
// (spaces, numbered or empty steps, duplicates, title case, spellings), plus
// field-level checks and opt-in rules. Rules, all optional, from the guide's
// JSON block:
//   titleLowercaseWords  words kept lowercase in titles unless first
//   spellings            { "wrong": "right" }, matched as whole words
//   prepInNote           true: ", diced" and similar in a name belongs in the note
//   requireGrams         true: every ingredient line needs a gram weight
//   noQuantityOk         names allowed without a quantity, e.g. "salt"
//   requireNutrition     true: the recipe needs nutrition facts

const GRAMS = /(?<![\p{L}\d])\d+(?:[.,]\d+)?\s*(?:g|kg|grams?)(?![\p{L}])/iu;
const LEADING_NUMBER = /^(?:\d|[½¼¾⅓⅔⅛])/u;

function startsUpper(word) {
  const first = word.match(/\p{L}/u);
  return !first || first[0] === first[0].toUpperCase();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSpellings(text, spellings) {
  return Object.entries(spellings || {})
    .filter(([wrong]) => new RegExp(`(?<![\\p{L}])${escapeRegExp(wrong)}(?![\\p{L}])`, "iu").test(text))
    .map(([wrong, right]) => `spelling "${wrong}" → "${right}"`);
}

function spacing(value) {
  if (!value) return [];
  const issues = [];
  if (value !== value.trim()) issues.push("leading/trailing spaces");
  if (/ {2,}/.test(value)) issues.push("double spaces");
  return issues;
}

export function auditTitle(title, rules = {}) {
  const issues = spacing(title);
  const lowercaseWords = new Set((rules.titleLowercaseWords || []).map(w => w.toLowerCase()));
  if (lowercaseWords.size > 0) {
    const words = title.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(w => /\p{L}/u.test(w));
    words.forEach((word, idx) => {
      const isSmallWord = lowercaseWords.has(word.toLowerCase());
      if (idx > 0 && isSmallWord && startsUpper(word)) issues.push(`"${word}" should be lowercase`);
      else if ((idx === 0 || !isSmallWord) && !startsUpper(word)) issues.push(`"${word}" should start with a capital`);
    });
  }
  issues.push(...findSpellings(title, rules.spellings));
  return issues;
}

export function auditIngredient(ing, rules = {}) {
  const name = ing.name || ing.rawIngredient || "";
  const quantity = ing.quantity || "";
  const note = ing.note || "";
  const issues = [];
  for (const [field, value] of [["name", name], ["quantity", quantity], ["note", note]]) {
    for (const issue of spacing(value)) issues.push(`${field}: ${issue}`);
  }
  if (ing.isHeading) {
    if (quantity.trim()) issues.push("heading has a quantity");
    return issues;
  }
  if (LEADING_NUMBER.test(name.trim())) issues.push("quantity is in the name; move it to the quantity field");
  if (rules.prepInNote && /,\s*\S/.test(name)) issues.push("text after a comma in the name belongs in the note");
  const quantityOptional = (rules.noQuantityOk || []).some(word => name.toLowerCase().includes(String(word).toLowerCase()));
  if (!quantity.trim() && !quantityOptional) issues.push("no quantity");
  if (rules.requireGrams && !quantityOptional && !GRAMS.test(`${quantity} ${note}`)) issues.push("no gram weight");
  issues.push(...findSpellings(`${name} ${note}`, rules.spellings));
  return issues;
}

export function auditStep(step, rules = {}) {
  const issues = [];
  if (!step.trim()) issues.push("empty step");
  else if (step !== step.trim()) issues.push("blank lines or spaces at start/end");
  if (/^\s*\d+[.)]\s/.test(step)) issues.push("numbered by hand");
  issues.push(...findSpellings(step, rules.spellings));
  return issues;
}

export function auditRecipe(recipe, rules = {}) {
  const issues = auditTitle(recipe.name || "", rules).map(i => `Title: ${i}`);
  const seen = new Set();
  (recipe.ingredients || []).forEach((ing, index) => {
    const label = `Ingredient ${index + 1} "${(ing.name || ing.rawIngredient || "").trim()}"`;
    for (const i of auditIngredient(ing, rules)) issues.push(`${label}: ${i}`);
    if (!ing.isHeading) {
      const key = `${(ing.quantity || "").trim()} ${(ing.name || "").trim()}`.toLowerCase();
      if (seen.has(key)) issues.push(`${label}: listed twice`);
      seen.add(key);
    }
  });
  (recipe.preparationSteps || []).forEach((step, idx) => {
    for (const i of auditStep(step, rules)) issues.push(`Step ${idx + 1}: ${i}`);
  });
  if (rules.requireNutrition && !String(recipe.nutritionalInfo || "").trim()) issues.push("No nutrition facts");
  return issues;
}
