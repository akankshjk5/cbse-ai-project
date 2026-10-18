import 'server-only';

/**
 * Putting an output in the store and recording that it is really there.
 *
 * "Upload, then write a row" is two steps, and the gap between them is where
 * lessons go wrong. A worker that dies after the upload leaves an orphan
 * object; one that dies after the row leaves a lesson pointing at bytes that
 * were never written. Neither is visible later: both look like a finished
 * lesson until a teacher presses play in front of a class.
 *
 * So nothing is trusted that has not been read back. The checksum is computed
 * over the bytes the store returns on a fresh download, not over the buffer we
 * sent — those differ exactly when it matters, and comparing a buffer to
 * itself proves nothing about what was stored.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  AssetRejected,
  type AssetKind,
  mimeAllowed,
  sha256,
  signatureMatches,
} from './asset-rules';

export { AssetRejected, sha256 };
export type { AssetKind };

export interface StoreRequest {
  projectId: string;
  kind: AssetKind;
  bytes: Uint8Array;
  mimeType: string;
  bucket: string;
  /** Deterministic, so a retry targets the same object rather than orphaning one. */
  storageKey: string;
  languageCode?: string | null;
  sceneIndex?: number | null;
  cacheKey?: string | null;
}

export interface StoredAsset {
  assetId: string;
  checksum: string;
  byteSize: number;
  version: number;
  storageKey: string;
}

/**
 * Upload, read back, verify, then record — in that order, every time.
 *
 * The storage key is derived from the content rather than from a random id, so
 * a retry after a crash overwrites the same object instead of leaving the
 * previous attempt behind. `upsert: true` is deliberate for the same reason:
 * the object is addressed by what it contains, so rewriting it is idempotent.
 */
export async function storeAsset(request: StoreRequest): Promise<StoredAsset> {
  const { bytes, kind, mimeType } = request;

  // Every refusal below happens before a client exists, so a malformed asset
  // never reaches the store and the rules stay testable without credentials.
  if (bytes.length === 0) throw new AssetRejected('refusing to store an empty object');
  mimeAllowed(kind, mimeType);
  signatureMatches(kind, bytes);

  const expected = sha256(bytes);
  const client = createAdminClient();

  const { error: uploadError } = await client.storage
    .from(request.bucket)
    .upload(request.storageKey, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) throw new AssetRejected(`upload failed: ${uploadError.message}`);

  // The verification that matters: what can actually be read back.
  const { data: readBack, error: downloadError } = await client.storage
    .from(request.bucket)
    .download(request.storageKey);
  if (downloadError || !readBack) {
    throw new AssetRejected(
      `uploaded object could not be read back: ${downloadError?.message ?? 'no data'}`);
  }
  const stored = new Uint8Array(await readBack.arrayBuffer());
  const actual = sha256(stored);
  if (actual !== expected || stored.length !== bytes.length) {
    throw new AssetRejected(
      `stored object does not match what was sent (${stored.length} bytes vs ${bytes.length}); `
      + 'the upload was truncated or the key collided');
  }

  const { data, error } = await client.rpc('finalize_lesson_asset', {
    p_project_id: request.projectId,
    p_kind: kind,
    p_storage_bucket: request.bucket,
    p_storage_key: request.storageKey,
    p_checksum_sha256: actual,
    p_byte_size: stored.length,
    p_mime_type: mimeType,
    p_language_code: request.languageCode ?? null,
    p_scene_index: request.sceneIndex ?? null,
    p_cache_key: request.cacheKey ?? null,
  });
  if (error) throw new AssetRejected(`could not record the asset: ${error.message}`);

  const row = data as unknown as {
    id: string; checksum_sha256: string; byte_size: number; version: number; storage_key: string;
  };
  return {
    assetId: row.id,
    checksum: row.checksum_sha256,
    byteSize: row.byte_size,
    version: row.version,
    storageKey: row.storage_key,
  };
}

export type IntegrityVerdict = 'ok' | 'missing' | 'corrupt';

export interface IntegrityReport {
  assetId: string;
  verdict: IntegrityVerdict;
  detail: string;
}

/**
 * Re-read a recorded asset and say whether it is still what it claimed.
 *
 * `missing` and `corrupt` are reported separately because they call for
 * different responses: an object that is gone may be a storage incident worth
 * investigating before regenerating anything, while a checksum mismatch means
 * the bytes changed and only regeneration will fix it. Collapsing them into
 * "broken" loses the distinction exactly when it is needed.
 */
export async function verifyAsset(assetId: string): Promise<IntegrityReport> {
  const client = createAdminClient();
  const { data: asset, error } = await client
    .from('lesson_assets')
    .select('id, storage_bucket, storage_key, checksum_sha256, byte_size')
    .eq('id', assetId)
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new Error(`no such asset: ${assetId}`);

  const { data: blob, error: downloadError } = await client.storage
    .from(asset.storage_bucket)
    .download(asset.storage_key);

  if (downloadError || !blob) {
    await markUnusable(assetId, 'missing', downloadError?.message ?? 'object not found');
    return { assetId, verdict: 'missing', detail: downloadError?.message ?? 'object not found' };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.checksum_sha256 || bytes.length !== Number(asset.byte_size)) {
    const detail = `expected ${asset.byte_size} bytes, read ${bytes.length}`;
    await markUnusable(assetId, 'corrupt', detail);
    return { assetId, verdict: 'corrupt', detail };
  }
  return { assetId, verdict: 'ok', detail: `${bytes.length} bytes, checksum matches` };
}

async function markUnusable(assetId: string, status: 'missing' | 'corrupt', reason: string) {
  const client = createAdminClient();
  const { error } = await client.rpc('mark_lesson_asset_unusable', {
    p_asset_id: assetId, p_status: status, p_reason: reason,
  });
  if (error) throw error;
}

/**
 * Which requested outputs a project still owes, after integrity is considered.
 *
 * Read from the database rather than inferred, so a recovery job regenerates
 * exactly the damaged output. A corrupt deck does not cost the video its
 * keyframes.
 */
export async function outstandingOutputs(projectId: string): Promise<string[]> {
  const client = createAdminClient();
  const { data, error } = await client.rpc('lesson_outputs_outstanding', {
    p_project_id: projectId,
  });
  if (error) throw error;
  return (data ?? []) as string[];
}

/** The single gate. A lesson is complete when its outputs are verified, not before. */
export async function publishIfReady(projectId: string): Promise<boolean> {
  const client = createAdminClient();
  const { data, error } = await client.rpc('publish_cloud_lesson', { p_project_id: projectId });
  if (error) throw error;
  return data === true;
}
