/**
 * wp_spec_validate — FULLY LOCAL. No network, no config, no session.
 *
 * Codes and their exact semantics (agent spec `mcp_tools[wp_spec_validate]`):
 *
 *   E_SPEC_SCHEMA   error   body fails design-spec.schema.json. STOPS all other checks.
 *   E_BOX_OVERLAP   error   a child region's box does not sit inside its parent's box,
 *                           with 2% slack taken from the PARENT's width/height.
 *   E_ORPHAN_CONTENT error  a content[].region_id does not resolve to any region id
 *                           anywhere in the (recursive) region tree.
 *   W_UNQUANTIZED   warning a concrete value in tokens_candidates (palette colors,
 *                           spacing step sizes, font sizes, layout contentSize/wideSize)
 *                           has no quantization_log entry whose snapped_to equals it.
 *   W_NO_RESPONSIVE warning a TOP-LEVEL region has no responsive_assumptions entry.
 *
 * `valid` is true iff there are zero E_* diagnostics.
 */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { DesignSpecIRSchema, checkWithZod, type DesignSpecIR, type Region } from '../schemas.js';
import { defineTool } from './_shared.js';

export const SPEC_DIAGNOSTIC_CODES = [
  'E_SPEC_SCHEMA',
  'E_BOX_OVERLAP',
  'E_ORPHAN_CONTENT',
  'W_UNQUANTIZED',
  'W_NO_RESPONSIVE',
] as const;
export type SpecDiagnosticCode = (typeof SPEC_DIAGNOSTIC_CODES)[number];

export interface SpecDiagnostic {
  code: SpecDiagnosticCode;
  path: string;
  message: string;
  fix_hint: string;
}

export interface SpecDiagnostics {
  valid: boolean;
  diagnostics: SpecDiagnostic[];
}

/** Slack applied to the parent box when checking containment. */
export const BOX_SLACK_RATIO = 0.02;

/**
 * Deliberately permissive for the same reason as wp_validate: a spec that fails
 * design-spec.schema.json must come back as `E_SPEC_SCHEMA` diagnostics, not as
 * an `invalid_input` tool error. Only the CONTAINERS are typed (number, object,
 * array) so MCP clients have a wire type to serialize against; the contents
 * stay unknown and flow through to the schema check.
 */
const InputSchema = z.looseObject({
  version: z.number().optional().describe('Must be the literal number 1.'),
  source: z.record(z.string(), z.unknown()).optional().describe('{kind: "image"|"figma"|"synthesized", files: string[], viewport: {width, height}}'),
  tokens_candidates: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('DesignTokens ({palette, spacing, typography, layout}) plus quantization_log: [{observed, snapped_to, delta, note?}].'),
  content: z
    .array(z.unknown())
    .optional()
    .describe('[{id, kind: "heading"|"paragraph"|"image"|"button"|"list"|"other", text?, image_ref?, region_id}]'),
  regions: z
    .array(z.unknown())
    .optional()
    .describe('Recursive regions: [{id, role, box:{x,y,w,h} in source px, layout?, style_refs?, children?, responsive_assumptions?}]'),
});

const OutputSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(
    z.object({
      code: z.enum(SPEC_DIAGNOSTIC_CODES),
      path: z.string(),
      message: z.string(),
      fix_hint: z.string(),
    }),
  ),
});

/* ------------------------------------------------------------------ checks */

function collectRegionIds(regions: Region[], into: Set<string>): void {
  for (const r of regions ?? []) {
    into.add(r.id);
    if (r.children?.length) collectRegionIds(r.children, into);
  }
}

function checkBoxes(regions: Region[], basePath: string, out: SpecDiagnostic[]): void {
  regions?.forEach((parent, i) => {
    const parentPath = `${basePath}/${i}`;
    const slackX = Math.abs(parent.box.w) * BOX_SLACK_RATIO;
    const slackY = Math.abs(parent.box.h) * BOX_SLACK_RATIO;
    const pLeft = parent.box.x - slackX;
    const pTop = parent.box.y - slackY;
    const pRight = parent.box.x + parent.box.w + slackX;
    const pBottom = parent.box.y + parent.box.h + slackY;

    parent.children?.forEach((child, j) => {
      const childPath = `${parentPath}/children/${j}`;
      const cLeft = child.box.x;
      const cTop = child.box.y;
      const cRight = child.box.x + child.box.w;
      const cBottom = child.box.y + child.box.h;

      const breaches: string[] = [];
      if (cLeft < pLeft) breaches.push(`left ${cLeft} < ${round(pLeft)}`);
      if (cTop < pTop) breaches.push(`top ${cTop} < ${round(pTop)}`);
      if (cRight > pRight) breaches.push(`right ${round(cRight)} > ${round(pRight)}`);
      if (cBottom > pBottom) breaches.push(`bottom ${round(cBottom)} > ${round(pBottom)}`);

      if (breaches.length) {
        out.push({
          code: 'E_BOX_OVERLAP',
          path: `${childPath}/box`,
          message: `Region "${child.id}" escapes its parent "${parent.id}" (2% slack applied): ${breaches.join(', ')}.`,
          fix_hint:
            'Re-measure the child box in source pixels; a child box must sit inside its parent box. Nested regions are geometry, not z-order.',
        });
      }
    });

    if (parent.children?.length) checkBoxes(parent.children, `${parentPath}/children`, out);
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Concrete quantizable values in tokens_candidates, with their JSON pointers. */
export function quantizableValues(spec: DesignSpecIR): { path: string; value: string; label: string }[] {
  const t = spec.tokens_candidates;
  const out: { path: string; value: string; label: string }[] = [];
  t.palette.forEach((p, i) =>
    out.push({ path: `/tokens_candidates/palette/${i}/color`, value: p.color, label: `palette "${p.slug}"` }),
  );
  t.spacing.steps.forEach((s, i) =>
    out.push({ path: `/tokens_candidates/spacing/steps/${i}/size`, value: s.size, label: `spacing step "${s.slug}"` }),
  );
  t.typography.sizes.forEach((s, i) =>
    out.push({ path: `/tokens_candidates/typography/sizes/${i}/size`, value: s.size, label: `font size "${s.slug}"` }),
  );
  out.push({ path: '/tokens_candidates/layout/contentSize', value: t.layout.contentSize, label: 'layout.contentSize' });
  out.push({ path: '/tokens_candidates/layout/wideSize', value: t.layout.wideSize, label: 'layout.wideSize' });
  return out;
}

/** The whole check. Exported so tests and the skill can call it directly. */
export function validateDesignSpec(input: unknown): SpecDiagnostics {
  const schemaIssues = checkWithZod(DesignSpecIRSchema, input);
  if (schemaIssues.length) {
    return {
      valid: false,
      diagnostics: schemaIssues.map((i) => ({
        code: 'E_SPEC_SCHEMA' as const,
        path: i.path,
        message: i.message,
        fix_hint:
          'Fix the spec against schemas/design-spec.schema.json. Every object in the spec is additionalProperties:false — an unexpected key is an error, not a hint.',
      })),
    };
  }

  const spec = DesignSpecIRSchema.parse(input);
  const diagnostics: SpecDiagnostic[] = [];

  // E_BOX_OVERLAP
  checkBoxes(spec.regions, '/regions', diagnostics);

  // E_ORPHAN_CONTENT
  const ids = new Set<string>();
  collectRegionIds(spec.regions, ids);
  spec.content.forEach((c, i) => {
    if (!ids.has(c.region_id)) {
      diagnostics.push({
        code: 'E_ORPHAN_CONTENT',
        path: `/content/${i}/region_id`,
        message: `Content item "${c.id}" points at region "${c.region_id}", which does not exist in regions[].`,
        fix_hint: 'Every content item must live in a measured region. Add the region or repoint region_id at an existing region id.',
      });
    }
  });

  // W_UNQUANTIZED
  const snapped = new Set(spec.tokens_candidates.quantization_log.map((q) => String(q.snapped_to)));
  for (const v of quantizableValues(spec)) {
    if (!snapped.has(String(v.value))) {
      diagnostics.push({
        code: 'W_UNQUANTIZED',
        path: v.path,
        message: `${v.label} value "${v.value}" has no quantization_log entry (no entry snapped_to === "${v.value}").`,
        fix_hint:
          'Every token value must be a deliberate snap of an observed measurement. Add {observed, snapped_to, delta} to tokens_candidates.quantization_log so the delta is reviewable.',
      });
    }
  }

  // W_NO_RESPONSIVE — top-level regions only
  spec.regions.forEach((r, i) => {
    if (!r.responsive_assumptions || r.responsive_assumptions.length === 0) {
      diagnostics.push({
        code: 'W_NO_RESPONSIVE',
        path: `/regions/${i}`,
        message: `Top-level region "${r.id}" declares no responsive_assumptions.`,
        fix_hint:
          'State at least one breakpoint behaviour per top-level region. Mark anything you did not observe in the source with confidence:"synthesized" so a human can veto it.',
      });
    }
  });

  return { valid: !diagnostics.some((d) => d.code.startsWith('E_')), diagnostics };
}

export const wpSpecValidate = defineTool({
  name: 'wp_spec_validate',
  title: 'Validate a Design Spec IR',
  description:
    'Fully local check of a DesignSpecIR before any tree is generated: schema (E_SPEC_SCHEMA, stops everything else), child-box containment within the parent box with 2% slack (E_BOX_OVERLAP), content region_id resolution (E_ORPHAN_CONTENT), token values all present in quantization_log (W_UNQUANTIZED) and at least one responsive assumption per top-level region (W_NO_RESPONSIVE). Must pass before implementing a from-design brief.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  local: true,
  handler: async (input: unknown, _ctx: Ctx) => validateDesignSpec(input),
});

export const tools = [wpSpecValidate];
