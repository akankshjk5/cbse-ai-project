/**
 * Hand-written aliases over the generated schema types.
 *
 * `database.types.ts` is overwritten wholesale by `npm run db:types`, so
 * anything hand-written must live here instead. Import domain types from
 * `@/lib/supabase/types`; import `Database` itself from `./database.types`.
 */

import type { Database, Tables, TablesInsert, TablesUpdate, Enums } from './database.types';

export type { Database, Tables, TablesInsert, TablesUpdate, Enums };
export type { Json } from './database.types';

export type Profile = Tables<'profiles'>;
export type Deck = Tables<'decks'>;
export type Slide = Tables<'slides'>;
export type DeckAsset = Tables<'deck_assets'>;
export type DeckMediaJob = Tables<'deck_media_jobs'>;
export type VideoProject = Tables<'video_projects'>;
export type GenerationJob = Tables<'generation_jobs'>;
export type AgentRun = Tables<'agent_runs'>;
export type DocumentRow = Tables<'documents'>;
export type DocumentChunk = Tables<'document_chunks'>;
export type DeckImport = Tables<'deck_imports'>;
export type DeckExport = Tables<'deck_exports'>;

export type DeckStatus = Enums<'deck_status'>;
export type DeckVisibility = Enums<'deck_visibility'>;
export type RunStatus = Enums<'run_status'>;
export type AssetKind = Enums<'asset_kind'>;
export type AssetSource = Enums<'asset_source'>;
export type DocumentSource = Enums<'document_source'>;
export type ImportFormat = Enums<'import_format'>;
export type ExportFormat = Enums<'export_format'>;

/**
 * Reminder: `owner_id` and `profiles.id` hold Clerk user ids (`user_2abc...`),
 * not uuids. Both are `string` here, so only Postgres will catch a mix-up.
 */
