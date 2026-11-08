import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";
import { normalizeRecipe } from "../recipe-normalizer.js";
import { loadStyleGuide, STYLE_GUIDE_HINT } from "../style-guide.js";
import { auditRecipe } from "../style-audit.js";

const toMinutes = (seconds) => Math.round(seconds / 60);
const toSeconds = (minutes) => Math.round(minutes * 60);
const toIngredient = (i) => {
  if (i.heading) {
    return { name: i.name, quantity: null, note: null, isHeading: true, rawIngredient: i.name };
  }
  const note = i.note?.trim() || null;
  return {
    name: i.name,
    quantity: i.quantity,
    note,
    rawIngredient: `${i.quantity || ''} ${i.name}${note ? `, ${note}` : ''}`.trim(),
  };
};

export function register(server, getClient) {
  const { elicitRequiredField, elicitConfirmation } = createElicitationHelpers(server);

  server.registerTool("recipes", {
    title: "Recipes",
    description: `Manage AnyList recipes. Actions:
- list: Browse recipes (returns summaries: name, rating, times, servings). Use 'search' to filter.
- get: Get full recipe details (ingredients, steps) by name
- create: Create a new recipe
- update: Partially update an existing recipe by name (only the fields you pass change; the rest are preserved). Pass new_name to rename it.
- delete: Delete a recipe by name
- import_url: Import a recipe from a website URL (parses ingredients, steps, etc.)
- normalize: Preview/parse a recipe from a URL or raw text without saving (set save=true to also save)
- list_ingredients: Every ingredient line across recipes (recipe, line number, quantity, name, note), for review or bulk cleanup. Filter with search (text in quantity, name, or note), name (one recipe), or since (YYYY-MM-DD, recipes created on or after)
- edit_ingredients: Edit ingredient lines in place across recipes. Each edit gives recipe, line, current_name (the line's name now, from list_ingredients), and the fields to change (quantity, name, note, heading). Lines keep their position and identity, so shopping-list links survive
- audit: Check recipes against the style guide (all, or one with name) and list what to fix; changes nothing${loadStyleGuide() ? STYLE_GUIDE_HINT : ""}`,
    inputSchema: {
      action: z.enum(["list", "get", "create", "update", "delete", "import_url", "normalize",
        "list_ingredients", "edit_ingredients", "audit"]).describe("The recipe action to perform"),
      name: z.string().optional().describe("Recipe name (required for get, create, update, delete; optional filter for list_ingredients and audit)"),
      new_name: z.string().optional().describe("New name for the recipe (update only)"),
      search: z.string().optional().describe("Search query to filter recipes (list), or ingredient lines (list_ingredients)"),
      since: z.string().optional().describe("YYYY-MM-DD: only recipes created on or after this date (list_ingredients)"),
      edits: z.array(z.object({
        recipe: z.string().describe("Recipe name"),
        line: z.number().int().min(1).describe("Line number from list_ingredients (headings count)"),
        current_name: z.string().describe("The line's name now, from list_ingredients; the edit is skipped if it no longer matches"),
        quantity: z.string().optional().describe("New quantity; empty string clears it"),
        name: z.string().optional().describe("New name"),
        note: z.string().optional().describe("New note; empty string clears it"),
        heading: z.boolean().optional().describe("Make the line a heading (true) or an ingredient (false)"),
      })).optional().describe("Ingredient line edits (edit_ingredients)"),
      ingredients: z.array(z.object({
        name: z.string().describe("Ingredient name, e.g. 'flour'. For a heading, the heading text, e.g. 'Sauce'"),
        quantity: z.string().optional().describe("Quantity with unit, e.g. '2 cups'. Omit for headings"),
        note: z.string().optional().describe("Ingredient note, e.g. 'finely chopped' or 'about 1/2 tsp, optional'"),
        heading: z.boolean().optional().describe("True if this entry is a section heading (e.g. 'Sauce', 'For the crust') rather than an ingredient"),
      })).optional().describe("Ingredients in order, with name, quantity, optional note, and optional heading entries that group the ingredients after them (create, update). On update, replaces the entire ingredient list."),
      steps: z.array(z.string()).optional().describe("Preparation steps in order (create, update). On update, replaces the entire step list."),
      note: z.string().optional().describe("Recipe notes (create, update)"),
      source_name: z.string().optional().describe("Source name (create, update)"),
      source_url: z.string().optional().describe("Source URL (create, update)"),
      prep_time: z.number().optional().describe("Prep time in minutes (create, update)"),
      cook_time: z.number().optional().describe("Cook time in minutes (create, update)"),
      servings: z.string().optional().describe("Servings, e.g. '4' or '4-6' (create, update)"),
      nutrition: z.string().optional().describe("Nutrition facts as plain text, one item per line, e.g. 'Calories: 65\\nFat: 4 g' (create, update). On update, pass an empty string to clear it."),
      photo_url: z.string().optional().describe("URL of a recipe photo, such as the source page's main image (create, update). AnyList shows the image in its apps. On update, replaces the photo link; pass an empty string to clear it. Photos already stored in AnyList are kept."),
      url: z.string().optional().describe("URL to import recipe from (import_url, normalize)"),
      text: z.string().optional().describe("Raw recipe text to parse (normalize only)"),
      save: z.boolean().optional().describe("If true, also save normalized recipe to AnyList (normalize only, default false)"),
    }
  }, async (params) => {
    const { action, name, new_name, search, since, edits, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings, photo_url, nutrition, url, text: recipeText, save: saveRecipe } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const recipes = await client.getRecipes(search || null);
          if (recipes.length === 0) return textResponse(search ? `No recipes found matching "${search}".` : "No recipes found.");
          const list = recipes.map(r => {
            const parts = [`- **${r.name}**`];
            if (r.rating) parts.push(`⭐${r.rating}`);
            if (r.prepTime) parts.push(`prep: ${toMinutes(r.prepTime)}min`);
            if (r.cookTime) parts.push(`cook: ${toMinutes(r.cookTime)}min`);
            if (r.servings) parts.push(`serves: ${r.servings}`);
            parts.push(`(id: ${r.identifier})`);
            return parts.join(' | ');
          }).join('\n');
          return textResponse(`Recipes (${recipes.length}):\n${list}`);
        }
        case "get": {
          let getRecipeName = name;
          if (!getRecipeName) getRecipeName = await elicitRequiredField("name", "Which recipe would you like to view?");
          const recipe = await client.getRecipeDetails(getRecipeName);
          let text = `# ${recipe.name}\n\nID: ${recipe.identifier}\n`;
          if (recipe.sourceName) text += `Source: ${recipe.sourceName}\n`;
          if (recipe.sourceUrl) text += `URL: ${recipe.sourceUrl}\n`;
          if (recipe.rating) text += `Rating: ${'⭐'.repeat(recipe.rating)}\n`;
          if (recipe.prepTime) text += `Prep: ${toMinutes(recipe.prepTime)} min\n`;
          if (recipe.cookTime) text += `Cook: ${toMinutes(recipe.cookTime)} min\n`;
          if (recipe.servings) text += `Servings: ${recipe.servings}\n`;
          if (recipe.createdAt) text += `Created: ${recipe.createdAt}\n`;
          if (recipe.photoIds?.length) text += `Photos: ${recipe.photoIds.length} stored in AnyList\n`;
          if (recipe.photoUrls?.length) text += `Photo links: ${recipe.photoUrls.join(', ')}\n`;
          if (recipe.note) text += `\nNotes: ${recipe.note}\n`;
          if (recipe.nutritionalInfo) text += `\nNutrition:\n${recipe.nutritionalInfo}\n`;
          if (recipe.ingredients.length > 0) {
            text += `\n## Ingredients\n`;
            recipe.ingredients.forEach(i => {
              if (i.isHeading) {
                text += `### ${i.name || i.rawIngredient}\n`;
                return;
              }
              text += i.name
                ? `- ${[i.quantity, i.name].filter(Boolean).join(' ')}${i.note ? ` (note: ${i.note})` : ''}\n`
                : `- ${i.rawIngredient || ''}\n`;
            });
          }
          if (recipe.preparationSteps.length > 0) {
            text += `\n## Steps\n`;
            recipe.preparationSteps.forEach((s, idx) => { text += `${idx + 1}. ${s}\n`; });
          }
          return textResponse(text);
        }
        case "create": {
          let recipeName = name;
          if (!recipeName) recipeName = await elicitRequiredField("name", "What should the recipe be called?");
          const existingRecipes = await client.getRecipes(recipeName);
          const exactMatch = existingRecipes.find(r => r.name.toLowerCase() === recipeName.toLowerCase());
          if (exactMatch) {
            const confirmed = await elicitConfirmation(`Recipe "${exactMatch.name}" already exists. Overwrite?`);
            if (!confirmed) return textResponse(`Cancelled — recipe "${exactMatch.name}" was not overwritten.`);
            await client.deleteRecipe(exactMatch.name);
          }
          const result = await client.createRecipe({
            name: recipeName,
            ingredients: (ingredients || []).map(toIngredient),
            preparationSteps: steps || [],
            note: note || null,
            sourceName: source_name || null,
            sourceUrl: source_url || null,
            prepTime: prep_time ? toSeconds(prep_time) : null,
            cookTime: cook_time ? toSeconds(cook_time) : null,
            servings: servings || null,
            photoUrls: photo_url ? [photo_url] : [],
            nutritionalInfo: nutrition || null,
          });
          return textResponse(`Created recipe "${result.name}"`);
        }
        case "update": {
          let updateRecipeName = name;
          if (!updateRecipeName) updateRecipeName = await elicitRequiredField("name", "Which recipe would you like to update?");
          // Build a partial patch: only fields the caller actually provided.
          // ingredients/steps, when present, replace the whole array (see client.updateRecipe).
          const fields = {};
          if (new_name !== undefined) {
            if (!new_name.trim()) return errorResponse('Action "update": new_name cannot be empty.');
            fields.name = new_name;
          }
          if (ingredients !== undefined) {
            fields.ingredients = ingredients.map(toIngredient);
          }
          if (steps !== undefined) fields.preparationSteps = steps;
          if (note !== undefined) fields.note = note;
          if (source_name !== undefined) fields.sourceName = source_name;
          if (source_url !== undefined) fields.sourceUrl = source_url;
          if (prep_time !== undefined) fields.prepTime = toSeconds(prep_time);
          if (cook_time !== undefined) fields.cookTime = toSeconds(cook_time);
          if (servings !== undefined) fields.servings = servings;
          if (photo_url !== undefined) fields.photoUrls = photo_url ? [photo_url] : [];
          if (nutrition !== undefined) fields.nutritionalInfo = nutrition || null;
          if (Object.keys(fields).length === 0) {
            return errorResponse('Action "update" requires at least one field to change (new_name, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings, photo_url, or nutrition).');
          }
          const updated = await client.updateRecipe(updateRecipeName, fields);
          if (fields.name !== undefined) return textResponse(`Renamed recipe "${updateRecipeName}" to "${updated.name}"`);
          return textResponse(`Updated recipe "${updated.name}"`);
        }
        case "list_ingredients": {
          const rows = await client.listIngredients({ search, recipeName: name, since });
          if (rows.length === 0) return textResponse("No ingredient lines match.");
          const recipes = new Set(rows.map(r => r.recipe));
          const lines = rows.map(r => r.isHeading
            ? `${r.recipe} | ${r.line} | heading | ${r.name}`
            : `${r.recipe} | ${r.line} | ${r.quantity} | ${r.name} | ${r.note}`);
          return textResponse(`${rows.length} line(s) in ${recipes.size} recipe(s). Columns: recipe | line | quantity | name | note\n${lines.join("\n")}`);
        }
        case "edit_ingredients": {
          if (!edits || edits.length === 0) throw new Error(`Action "edit_ingredients" requires edits`);
          const results = await client.editIngredients(edits.map(e => ({
            recipe: e.recipe, line: e.line, currentName: e.current_name,
            quantity: e.quantity, name: e.name, note: e.note, isHeading: e.heading,
          })));
          const updated = results.filter(r => r.outcome === "updated").length;
          const lines = results.map(r => `- ${r.recipe}, line ${r.line} ("${r.currentName}"): ${r.outcome}`);
          const text = `Updated ${updated} of ${results.length} line(s):\n${lines.join("\n")}`;
          return updated === results.length ? textResponse(text) : errorResponse(text);
        }
        case "audit": {
          const guide = loadStyleGuide();
          if (!guide) return errorResponse("No style guide is configured on this server (set STYLE_GUIDE_FILE).");
          let recipes = await client.getAllRecipeDetails();
          if (name) {
            recipes = recipes.filter(r => r.name && r.name.toLowerCase() === name.toLowerCase());
            if (recipes.length === 0) return errorResponse(`Recipe "${name}" not found`);
          }
          const flagged = recipes
            .map(r => ({ name: r.name, issues: auditRecipe(r, guide.rules) }))
            .filter(r => r.issues.length > 0);
          if (flagged.length === 0) return textResponse(`All ${recipes.length} recipe(s) pass the style guide checks.`);
          let report = `${flagged.length} of ${recipes.length} recipe(s) need attention:\n`;
          for (const r of flagged) {
            report += `\n## ${r.name}\n${r.issues.map(i => `- ${i}`).join("\n")}\n`;
          }
          report += "\nThese checks are mechanical; also apply the rest of the style guide.";
          return textResponse(report);
        }
        case "delete": {
          let deleteRecipeName = name;
          if (!deleteRecipeName) deleteRecipeName = await elicitRequiredField("name", "Which recipe would you like to delete?");
          await client.deleteRecipe(deleteRecipeName);
          return textResponse(`Deleted recipe "${deleteRecipeName}"`);
        }
        case "import_url": {
          let importUrl = url;
          if (!importUrl) importUrl = await elicitRequiredField("url", "What URL would you like to import a recipe from?");
          const result = await client.importRecipeFromUrl(importUrl);
          let importText = `Imported recipe "${result.name}"\n`;
          importText += `- ${result.ingredientCount} ingredients, ${result.stepCount} steps\n`;
          if (result.source) importText += `- Source: ${result.source}\n`;
          if (result.sourceUrl) importText += `- URL: ${result.sourceUrl}\n`;
          if (result.method) importText += `- Method: ${result.method}\n`;
          return textResponse(importText);
        }
        case "normalize": {
          if (!url && !recipeText) {
            throw new Error('Action "normalize" requires either "url" or "text" parameter');
          }
          const input = {};
          if (url) input.url = url;
          if (recipeText) input.text = recipeText;
          const normalized = await normalizeRecipe(input);

          let output = `# ${normalized.name}\n\n`;
          if (normalized.sourceName) output += `Source: ${normalized.sourceName}\n`;
          if (normalized.sourceUrl) output += `URL: ${normalized.sourceUrl}\n`;
          if (normalized.prepTime) output += `Prep: ${normalized.prepTime}\n`;
          if (normalized.cookTime) output += `Cook: ${normalized.cookTime}\n`;
          if (normalized.servings) output += `Servings: ${normalized.servings}\n`;
          if (normalized.note) output += `Note: ${normalized.note}\n`;
          output += `\n## Ingredients (${normalized.ingredients.length})\n`;
          normalized.ingredients.forEach(i => { output += `- ${i.rawIngredient}\n`; });
          output += `\n## Steps (${normalized.preparationSteps.length})\n`;
          normalized.preparationSteps.forEach((s, idx) => { output += `${idx + 1}. ${s}\n`; });

          if (saveRecipe) {
            const created = await client.createRecipe({
              name: normalized.name,
              ingredients: normalized.ingredients,
              preparationSteps: normalized.preparationSteps,
              note: normalized.note,
              sourceName: normalized.sourceName,
              sourceUrl: normalized.sourceUrl,
              prepTime: normalized.prepTime,
              cookTime: normalized.cookTime,
              servings: normalized.servings,
            });
            output += `\n✅ Saved to AnyList as "${created.name}"`;
          }
          return textResponse(output);
        }
      }
    } catch (error) {
      return errorResponse(`Recipes ${action} failed: ${error.message}`);
    }
  });
}
