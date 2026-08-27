/**
 * The asset-pass manifest, v2: ONE file per run directory carrying typed
 * entries for both lanes. Content entries are one-file-one-path, keyed by
 * (post_id, path). Surface entries are the dictionary: ONE file and MANY
 * target paths, keyed by asset_id — reuse is what reads as a designed
 * material system instead of AI noise.
 *
 * Writes always merge into what is on disk instead of overwriting it, so a
 * run that generates per page (or births its canvas early, at S3) grows one
 * manifest instead of clobbering it — the audit trail for the fan-out from
 * one asset to many targets.
 */
import * as fs from 'node:fs';
import type { ContentRef, SurfaceMechanism } from './scan.js';
import type { SurfaceClass, SurfacePromptEntry } from './gemini.js';

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_FILENAME = 'images-manifest.json';

export type { SurfaceClass } from './gemini.js';

export interface ManifestContentEntry extends ContentRef {
  post_id: number;
  rest_base: string;
  file: string;
  prompt: string;
  mime_type: string;
  bytes: number;
  ms: number;
}

export interface ManifestSurfaceTarget {
  post_id: number;
  rest_base: string;
  path: string;
  block_name: string;
  mechanism: SurfaceMechanism;
  /** The flat band underneath — the reservation and the fallback. */
  reservation: string | null;
}

export interface ManifestSurfaceEntry {
  kind: 'surface';
  asset_id: string;
  class: SurfaceClass;
  file: string;
  prompt: string;
  mime_type: string;
  bytes: number;
  ms: number;
  /** Chroma key the spot was generated on — recorded for determinism. */
  key_hex?: string;
  /** Measured luminance range (0..1) of the processed pixels. */
  lum_min?: number;
  lum_max?: number;
  post_processing: string;
  /** Application knobs carried from the dictionary entry. */
  intensity?: string;
  position?: string;
  size?: string;
  /** Set on first upload so ONE attachment serves every target and every post. */
  media_id?: number;
  media_url?: string;
  targets: ManifestSurfaceTarget[];
}

export interface ManifestV2 {
  schema_version: 2;
  model: string;
  style?: string;
  content: ManifestContentEntry[];
  surfaces: ManifestSurfaceEntry[];
}

export function emptyManifest(model: string, style?: string): ManifestV2 {
  const m: ManifestV2 = { schema_version: 2, model, content: [], surfaces: [] };
  if (style !== undefined) m.style = style;
  return m;
}

/** v1 shape, kept only so an old run directory still applies. */
interface ManifestV1 {
  post_id: number;
  rest_base: string;
  model: string;
  style?: string;
  images: Array<Omit<ManifestContentEntry, 'kind' | 'post_id' | 'rest_base'>>;
}

function isV1(raw: unknown): raw is ManifestV1 {
  return typeof raw === 'object' && raw !== null && !('schema_version' in raw) && Array.isArray((raw as ManifestV1).images);
}

export function loadManifest(path: string): ManifestV2 {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as unknown;
  if (isV1(raw)) {
    const m = emptyManifest(raw.model, raw.style);
    m.content = raw.images.map((img) => ({ kind: 'content', post_id: raw.post_id, rest_base: raw.rest_base, ...img }));
    return m;
  }
  return raw as ManifestV2;
}

export function loadManifestIfPresent(path: string): ManifestV2 | null {
  return fs.existsSync(path) ? loadManifest(path) : null;
}

const contentKey = (e: ManifestContentEntry): string => `${e.post_id}${e.path}`;
const targetKey = (t: ManifestSurfaceTarget): string => `${t.post_id}${t.path}`;

export function mergeManifest(existing: ManifestV2 | null, incoming: ManifestV2): ManifestV2 {
  if (!existing) return incoming;
  const merged = emptyManifest(incoming.model, incoming.style ?? existing.style);
  const content = new Map<string, ManifestContentEntry>();
  for (const e of existing.content) content.set(contentKey(e), e);
  for (const e of incoming.content) content.set(contentKey(e), e);
  merged.content = [...content.values()];
  const surfaces = new Map<string, ManifestSurfaceEntry>();
  for (const s of existing.surfaces) surfaces.set(s.asset_id, s);
  for (const s of incoming.surfaces) {
    const prior = surfaces.get(s.asset_id);
    if (!prior) {
      surfaces.set(s.asset_id, s);
      continue;
    }
    const targets = new Map<string, ManifestSurfaceTarget>();
    for (const t of prior.targets) targets.set(targetKey(t), t);
    for (const t of s.targets) targets.set(targetKey(t), t);
    surfaces.set(s.asset_id, { ...s, targets: [...targets.values()] });
  }
  merged.surfaces = [...surfaces.values()];
  return merged;
}

export function saveManifest(path: string, m: ManifestV2): void {
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
}

export interface SurfaceCallSpec extends SurfacePromptEntry {
  id: string;
  position?: string;
  size?: string;
}

export interface SurfaceCallPlan {
  generate: SurfaceCallSpec[];
  cached: string[];
}

/**
 * Dedup and replay in one decision: one image call per unique dictionary
 * asset per run, and none at all for an asset the manifest already holds with
 * its file still on disk — a resumed run replays assets instead of re-buying
 * them. Applications are free; only births are metered.
 */
export function planSurfaceCalls(
  dictionary: SurfaceCallSpec[],
  manifest: ManifestV2 | null,
  fileExists: (file: string) => boolean = fs.existsSync,
): SurfaceCallPlan {
  const generate: SurfaceCallSpec[] = [];
  const cached: string[] = [];
  const seen = new Set<string>();
  for (const entry of dictionary) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const prior = manifest?.surfaces.find((s) => s.asset_id === entry.id);
    if (prior && fileExists(prior.file)) cached.push(entry.id);
    else generate.push(entry);
  }
  return { generate, cached };
}
