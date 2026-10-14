export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_runs: {
        Row: {
          agent: string
          attempt: number
          completion_tokens: number | null
          cost_usd: number | null
          created_at: string
          deck_id: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          job_id: string
          latency_ms: number | null
          model: string | null
          output: Json | null
          prompt_tokens: number | null
          slide_id: string | null
          status: Database["public"]["Enums"]["run_status"]
        }
        Insert: {
          agent: string
          attempt?: number
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          deck_id: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          job_id: string
          latency_ms?: number | null
          model?: string | null
          output?: Json | null
          prompt_tokens?: number | null
          slide_id?: string | null
          status?: Database["public"]["Enums"]["run_status"]
        }
        Update: {
          agent?: string
          attempt?: number
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          deck_id?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          job_id?: string
          latency_ms?: number | null
          model?: string | null
          output?: Json | null
          prompt_tokens?: number | null
          slide_id?: string | null
          status?: Database["public"]["Enums"]["run_status"]
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "generation_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_slide_id_fkey"
            columns: ["slide_id"]
            isOneToOne: false
            referencedRelation: "slides"
            referencedColumns: ["id"]
          },
        ]
      }
      cloud_lesson_jobs: {
        Row: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          progress: number
          project_id: string
          prompt: string
          provider_request_id: string | null
          scene_id: string | null
          shot_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id: string
          parameters?: Json
          progress?: number
          project_id: string
          prompt?: string
          provider_request_id?: string | null
          scene_id?: string | null
          shot_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind?: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id?: string
          parameters?: Json
          progress?: number
          project_id?: string
          prompt?: string
          provider_request_id?: string | null
          scene_id?: string | null
          shot_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cloud_lesson_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cloud_lesson_jobs_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_scenes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cloud_lesson_jobs_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_shots"
            referencedColumns: ["id"]
          },
        ]
      }
      cloud_lesson_projects: {
        Row: {
          cache_key: string | null
          class_level: number
          completed_at: string | null
          content_key: string | null
          cost_breakdown: Json
          cost_usd: number
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          learning_objective: string | null
          narration_duration_seconds: number | null
          narration_text: string | null
          narration_url: string | null
          owner_id: string
          reused_from_project_id: string | null
          status: string
          subject: string
          target_duration_seconds: number
          title: string | null
          topic: string
          updated_at: string
          visual_style: string
        }
        Insert: {
          cache_key?: string | null
          class_level: number
          completed_at?: string | null
          content_key?: string | null
          cost_breakdown?: Json
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          final_video_url?: string | null
          id?: string
          language_code: string
          learning_objective?: string | null
          narration_duration_seconds?: number | null
          narration_text?: string | null
          narration_url?: string | null
          owner_id: string
          reused_from_project_id?: string | null
          status?: string
          subject: string
          target_duration_seconds?: number
          title?: string | null
          topic: string
          updated_at?: string
          visual_style?: string
        }
        Update: {
          cache_key?: string | null
          class_level?: number
          completed_at?: string | null
          content_key?: string | null
          cost_breakdown?: Json
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          final_video_url?: string | null
          id?: string
          language_code?: string
          learning_objective?: string | null
          narration_duration_seconds?: number | null
          narration_text?: string | null
          narration_url?: string | null
          owner_id?: string
          reused_from_project_id?: string | null
          status?: string
          subject?: string
          target_duration_seconds?: number
          title?: string | null
          topic?: string
          updated_at?: string
          visual_style?: string
        }
        Relationships: [
          {
            foreignKeyName: "cloud_lesson_projects_reused_from_project_id_fkey"
            columns: ["reused_from_project_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      cloud_lesson_scenes: {
        Row: {
          caption: string
          completed_at: string | null
          created_at: string
          duration_seconds: number
          error_message: string | null
          fact: string
          id: string
          image_prompt: string
          image_url: string | null
          motion_description: string
          motion_mode: string
          narration: string
          overlay: Json
          project_id: string
          scene_index: number
          status: string
          title: string | null
          updated_at: string
          video_prompt: string
          video_url: string | null
          visual_description: string
        }
        Insert: {
          caption?: string
          completed_at?: string | null
          created_at?: string
          duration_seconds: number
          error_message?: string | null
          fact: string
          id?: string
          image_prompt: string
          image_url?: string | null
          motion_description: string
          motion_mode?: string
          narration: string
          overlay?: Json
          project_id: string
          scene_index: number
          status?: string
          title?: string | null
          updated_at?: string
          video_prompt: string
          video_url?: string | null
          visual_description: string
        }
        Update: {
          caption?: string
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          error_message?: string | null
          fact?: string
          id?: string
          image_prompt?: string
          image_url?: string | null
          motion_description?: string
          motion_mode?: string
          narration?: string
          overlay?: Json
          project_id?: string
          scene_index?: number
          status?: string
          title?: string | null
          updated_at?: string
          video_prompt?: string
          video_url?: string | null
          visual_description?: string
        }
        Relationships: [
          {
            foreignKeyName: "cloud_lesson_scenes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      cloud_lesson_shots: {
        Row: {
          camera_move: string
          completed_at: string | null
          created_at: string
          id: string
          image_prompt: string
          image_url: string | null
          project_id: string
          scene_id: string
          shot_index: number
          shot_size: string
          status: string
          updated_at: string
          visual_description: string
        }
        Insert: {
          camera_move?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          image_prompt: string
          image_url?: string | null
          project_id: string
          scene_id: string
          shot_index: number
          shot_size: string
          status?: string
          updated_at?: string
          visual_description: string
        }
        Update: {
          camera_move?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          image_prompt?: string
          image_url?: string | null
          project_id?: string
          scene_id?: string
          shot_index?: number
          shot_size?: string
          status?: string
          updated_at?: string
          visual_description?: string
        }
        Relationships: [
          {
            foreignKeyName: "cloud_lesson_shots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cloud_lesson_shots_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "cloud_lesson_scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_assets: {
        Row: {
          bucket: string
          bytes: number | null
          created_at: string
          credit: Json
          deck_id: string
          external_url: string | null
          height: number | null
          id: string
          kind: Database["public"]["Enums"]["asset_kind"]
          prompt: string | null
          provider_model: string | null
          slide_id: string | null
          source: Database["public"]["Enums"]["asset_source"]
          storage_path: string | null
          width: number | null
        }
        Insert: {
          bucket?: string
          bytes?: number | null
          created_at?: string
          credit?: Json
          deck_id: string
          external_url?: string | null
          height?: number | null
          id?: string
          kind: Database["public"]["Enums"]["asset_kind"]
          prompt?: string | null
          provider_model?: string | null
          slide_id?: string | null
          source: Database["public"]["Enums"]["asset_source"]
          storage_path?: string | null
          width?: number | null
        }
        Update: {
          bucket?: string
          bytes?: number | null
          created_at?: string
          credit?: Json
          deck_id?: string
          external_url?: string | null
          height?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["asset_kind"]
          prompt?: string | null
          provider_model?: string | null
          slide_id?: string | null
          source?: Database["public"]["Enums"]["asset_source"]
          storage_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deck_assets_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deck_assets_slide_id_fkey"
            columns: ["slide_id"]
            isOneToOne: false
            referencedRelation: "slides"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_drafts: {
        Row: {
          created_at: string
          deck_id: string
          messages: Json
          owner_id: string
          plan: Json
          research: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          deck_id: string
          messages?: Json
          owner_id: string
          plan: Json
          research?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          deck_id?: string
          messages?: Json
          owner_id?: string
          plan?: Json
          research?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deck_drafts_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: true
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_exports: {
        Row: {
          bytes: number | null
          created_at: string
          deck_id: string
          error: string | null
          finished_at: string | null
          format: Database["public"]["Enums"]["export_format"]
          id: string
          owner_id: string
          status: Database["public"]["Enums"]["run_status"]
          storage_path: string | null
          updated_at: string
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          deck_id: string
          error?: string | null
          finished_at?: string | null
          format: Database["public"]["Enums"]["export_format"]
          id?: string
          owner_id: string
          status?: Database["public"]["Enums"]["run_status"]
          storage_path?: string | null
          updated_at?: string
        }
        Update: {
          bytes?: number | null
          created_at?: string
          deck_id?: string
          error?: string | null
          finished_at?: string | null
          format?: Database["public"]["Enums"]["export_format"]
          id?: string
          owner_id?: string
          status?: Database["public"]["Enums"]["run_status"]
          storage_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deck_exports_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_imports: {
        Row: {
          bytes: number | null
          created_at: string
          deck_id: string | null
          detected: Json
          error: string | null
          finished_at: string | null
          id: string
          original_filename: string
          owner_id: string
          source_format: Database["public"]["Enums"]["import_format"]
          status: Database["public"]["Enums"]["run_status"]
          storage_path: string
          updated_at: string
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          deck_id?: string | null
          detected?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          original_filename: string
          owner_id: string
          source_format: Database["public"]["Enums"]["import_format"]
          status?: Database["public"]["Enums"]["run_status"]
          storage_path: string
          updated_at?: string
        }
        Update: {
          bytes?: number | null
          created_at?: string
          deck_id?: string | null
          detected?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          original_filename?: string
          owner_id?: string
          source_format?: Database["public"]["Enums"]["import_format"]
          status?: Database["public"]["Enums"]["run_status"]
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deck_imports_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_media_jobs: {
        Row: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          deck_id: string | null
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          prompt: string
          slide_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          target_block: number | null
          updated_at: string
          video_project_id: string | null
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          deck_id?: string | null
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id: string
          parameters?: Json
          profile: string
          progress?: number
          prompt: string
          slide_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          target_block?: number | null
          updated_at?: string
          video_project_id?: string | null
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          deck_id?: string | null
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind?: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id?: string
          parameters?: Json
          profile?: string
          progress?: number
          prompt?: string
          slide_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          target_block?: number | null
          updated_at?: string
          video_project_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deck_media_jobs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deck_media_jobs_slide_id_fkey"
            columns: ["slide_id"]
            isOneToOne: false
            referencedRelation: "slides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deck_media_jobs_video_project_id_fkey"
            columns: ["video_project_id"]
            isOneToOne: false
            referencedRelation: "video_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      decks: {
        Row: {
          audience: string | null
          board: string
          created_at: string
          grade_level: number | null
          id: string
          language: string
          metadata: Json
          owner_id: string
          requested_slide_count: number | null
          slide_count: number
          source_prompt: string | null
          status: Database["public"]["Enums"]["deck_status"]
          style_spec: Json
          subject: string | null
          theme: Json
          title: string
          tone: string | null
          topic: string | null
          updated_at: string
          visibility: Database["public"]["Enums"]["deck_visibility"]
        }
        Insert: {
          audience?: string | null
          board?: string
          created_at?: string
          grade_level?: number | null
          id?: string
          language?: string
          metadata?: Json
          owner_id: string
          requested_slide_count?: number | null
          slide_count?: number
          source_prompt?: string | null
          status?: Database["public"]["Enums"]["deck_status"]
          style_spec?: Json
          subject?: string | null
          theme?: Json
          title?: string
          tone?: string | null
          topic?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["deck_visibility"]
        }
        Update: {
          audience?: string | null
          board?: string
          created_at?: string
          grade_level?: number | null
          id?: string
          language?: string
          metadata?: Json
          owner_id?: string
          requested_slide_count?: number | null
          slide_count?: number
          source_prompt?: string | null
          status?: Database["public"]["Enums"]["deck_status"]
          style_spec?: Json
          subject?: string | null
          theme?: Json
          title?: string
          tone?: string | null
          topic?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["deck_visibility"]
        }
        Relationships: []
      }
      document_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          deck_id: string | null
          document_id: string
          embedding: string | null
          id: string
          metadata: Json
          owner_id: string
          token_count: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          deck_id?: string | null
          document_id: string
          embedding?: string | null
          id?: string
          metadata?: Json
          owner_id: string
          token_count?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          deck_id?: string | null
          document_id?: string
          embedding?: string | null
          id?: string
          metadata?: Json
          owner_id?: string
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          content: string | null
          created_at: string
          deck_id: string | null
          id: string
          metadata: Json
          owner_id: string
          source_type: Database["public"]["Enums"]["document_source"]
          source_url: string | null
          storage_path: string | null
          title: string | null
          token_count: number | null
          updated_at: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          deck_id?: string | null
          id?: string
          metadata?: Json
          owner_id: string
          source_type: Database["public"]["Enums"]["document_source"]
          source_url?: string | null
          storage_path?: string | null
          title?: string | null
          token_count?: number | null
          updated_at?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          deck_id?: string | null
          id?: string
          metadata?: Json
          owner_id?: string
          source_type?: Database["public"]["Enums"]["document_source"]
          source_url?: string | null
          storage_path?: string | null
          title?: string | null
          token_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      generation_jobs: {
        Row: {
          created_at: string
          deck_id: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          owner_id: string
          progress: number
          stage: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          total_cost_usd: number
          total_tokens: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          deck_id: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          owner_id: string
          progress?: number
          stage?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          total_cost_usd?: number
          total_tokens?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          deck_id?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          owner_id?: string
          progress?: number
          stage?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          total_cost_usd?: number
          total_tokens?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generation_jobs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_video_jobs: {
        Row: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          project_id: string
          prompt: string
          scene_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id: string
          parameters?: Json
          profile: string
          progress?: number
          project_id: string
          prompt?: string
          scene_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind?: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          owner_id?: string
          parameters?: Json
          profile?: string
          progress?: number
          project_id?: string
          prompt?: string
          scene_id?: string | null
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lesson_video_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "lesson_video_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_video_jobs_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "lesson_video_scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_video_projects: {
        Row: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }
        Insert: {
          class_level: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          final_video_url?: string | null
          id?: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds?: number | null
          narration_text: string
          narration_url?: string | null
          owner_id: string
          status?: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at?: string
        }
        Update: {
          class_level?: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          final_video_url?: string | null
          id?: string
          language_code?: string
          language_name?: string
          learning_objective?: string
          narration_duration_seconds?: number | null
          narration_text?: string
          narration_url?: string | null
          owner_id?: string
          status?: string
          subject?: string
          target_duration_seconds?: number
          title?: string
          topic?: string
          updated_at?: string
        }
        Relationships: []
      }
      lesson_video_scenes: {
        Row: {
          caption: string
          completed_at: string | null
          created_at: string
          duration_seconds: number
          error_message: string | null
          fact: string
          id: string
          image_prompt: string
          image_url: string | null
          narration: string
          overlay: Json
          project_id: string
          scene_index: number
          status: string
          updated_at: string
          video_prompt: string
          video_url: string | null
        }
        Insert: {
          caption?: string
          completed_at?: string | null
          created_at?: string
          duration_seconds: number
          error_message?: string | null
          fact: string
          id?: string
          image_prompt: string
          image_url?: string | null
          narration: string
          overlay?: Json
          project_id: string
          scene_index: number
          status?: string
          updated_at?: string
          video_prompt: string
          video_url?: string | null
        }
        Update: {
          caption?: string
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          error_message?: string | null
          fact?: string
          id?: string
          image_prompt?: string
          image_url?: string | null
          narration?: string
          overlay?: Json
          project_id?: string
          scene_index?: number
          status?: string
          updated_at?: string
          video_prompt?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lesson_video_scenes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "lesson_video_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      media_jobs: {
        Row: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          parameters: Json
          presentation_id: string | null
          profile: string
          progress: number
          prompt: string
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          parameters?: Json
          presentation_id?: string | null
          profile: string
          progress?: number
          prompt: string
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          available_at?: string
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          kind?: string
          locked_at?: string | null
          max_attempts?: number
          negative_prompt?: string
          output_metadata?: Json
          output_url?: string | null
          parameters?: Json
          presentation_id?: string | null
          profile?: string
          progress?: number
          prompt?: string
          source_image_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_jobs_presentation_id_fkey"
            columns: ["presentation_id"]
            isOneToOne: false
            referencedRelation: "presentations"
            referencedColumns: ["id"]
          },
        ]
      }
      presentations: {
        Row: {
          blocks_json: Json
          created_at: string
          id: string
          is_public: boolean
          subject: string
          theme: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          blocks_json?: Json
          created_at?: string
          id?: string
          is_public?: boolean
          subject?: string
          theme?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          blocks_json?: Json
          created_at?: string
          id?: string
          is_public?: boolean
          subject?: string
          theme?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          board: string | null
          class: string | null
          created_at: string
          full_name: string | null
          id: string
          onboarded_at: string | null
          preferences: Json
          updated_at: string
        }
        Insert: {
          board?: string | null
          class?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          onboarded_at?: string | null
          preferences?: Json
          updated_at?: string
        }
        Update: {
          board?: string | null
          class?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          onboarded_at?: string | null
          preferences?: Json
          updated_at?: string
        }
        Relationships: []
      }
      slides: {
        Row: {
          background_url: string | null
          blocks: Json
          created_at: string
          deck_id: string
          hero_image_url: string | null
          id: string
          image_prompt: string | null
          layout: string
          metadata: Json
          position: number
          speaker_notes: string | null
          subtitle: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          background_url?: string | null
          blocks?: Json
          created_at?: string
          deck_id: string
          hero_image_url?: string | null
          id?: string
          image_prompt?: string | null
          layout?: string
          metadata?: Json
          position: number
          speaker_notes?: string | null
          subtitle?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          background_url?: string | null
          blocks?: Json
          created_at?: string
          deck_id?: string
          hero_image_url?: string | null
          id?: string
          image_prompt?: string | null
          layout?: string
          metadata?: Json
          position?: number
          speaker_notes?: string | null
          subtitle?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slides_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "decks"
            referencedColumns: ["id"]
          },
        ]
      }
      video_projects: {
        Row: {
          class_level: number
          completed_at: string | null
          created_at: string
          duration_seconds: number
          error_message: string | null
          id: string
          image_job_id: string | null
          image_prompt: string
          image_url: string | null
          owner_id: string
          status: string
          subject: string
          topic: string
          updated_at: string
          video_job_id: string | null
          video_prompt: string
          video_url: string | null
        }
        Insert: {
          class_level: number
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          error_message?: string | null
          id?: string
          image_job_id?: string | null
          image_prompt: string
          image_url?: string | null
          owner_id: string
          status?: string
          subject: string
          topic: string
          updated_at?: string
          video_job_id?: string | null
          video_prompt: string
          video_url?: string | null
        }
        Update: {
          class_level?: number
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          error_message?: string | null
          id?: string
          image_job_id?: string | null
          image_prompt?: string
          image_url?: string | null
          owner_id?: string
          status?: string
          subject?: string
          topic?: string
          updated_at?: string
          video_job_id?: string | null
          video_prompt?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "video_projects_image_job_fkey"
            columns: ["image_job_id"]
            isOneToOne: false
            referencedRelation: "deck_media_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_projects_video_job_fkey"
            columns: ["video_job_id"]
            isOneToOne: false
            referencedRelation: "deck_media_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_cloud_lesson: {
        Args: { p_project_id: string }
        Returns: {
          cache_key: string | null
          class_level: number
          completed_at: string | null
          content_key: string | null
          cost_breakdown: Json
          cost_usd: number
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          learning_objective: string | null
          narration_duration_seconds: number | null
          narration_text: string | null
          narration_url: string | null
          owner_id: string
          reused_from_project_id: string | null
          status: string
          subject: string
          target_duration_seconds: number
          title: string | null
          topic: string
          updated_at: string
          visual_style: string
        }[]
        SetofOptions: {
          from: "*"
          to: "cloud_lesson_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      cancel_lesson_video_project: {
        Args: { p_project_id: string }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_cloud_lesson_job: {
        Args: { p_kinds: string[]; p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          progress: number
          project_id: string
          prompt: string
          provider_request_id: string | null
          scene_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "cloud_lesson_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_deck_media_job: {
        Args: { p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          deck_id: string | null
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          prompt: string
          slide_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          target_block: number | null
          updated_at: string
          video_project_id: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "deck_media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_lesson_video_job: {
        Args: { p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          project_id: string
          prompt: string
          scene_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_lesson_video_job_for_owner: {
        Args: { p_owner_id: string; p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          project_id: string
          prompt: string
          scene_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_lesson_video_job_for_projects: {
        Args: { p_project_ids: string[]; p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          project_id: string
          prompt: string
          scene_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_media_job: {
        Args: { p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          parameters: Json
          presentation_id: string | null
          profile: string
          progress: number
          prompt: string
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      clerk_user_id: { Args: never; Returns: string }
      complete_cloud_lesson_job: {
        Args: {
          p_cost_usd?: number
          p_job_id: string
          p_output_metadata?: Json
          p_output_url: string
          p_worker_id: string
        }
        Returns: boolean
      }
      complete_cloud_lesson_preparation: {
        Args: {
          p_cost_usd?: number
          p_job_id: string
          p_learning_objective: string
          p_narration_duration_seconds: number
          p_narration_text: string
          p_narration_url: string
          p_output_metadata?: Json
          p_scenes: Json
          p_title: string
          p_worker_id: string
        }
        Returns: boolean
      }
      complete_deck_media_job: {
        Args: {
          p_job_id: string
          p_output_metadata?: Json
          p_output_url: string
          p_worker_id: string
        }
        Returns: boolean
      }
      complete_lesson_video_job: {
        Args: {
          p_job_id: string
          p_output_metadata?: Json
          p_output_url: string
          p_worker_id: string
        }
        Returns: boolean
      }
      complete_lesson_video_preparation: {
        Args: {
          p_learning_objective: string
          p_narration_text: string
          p_project_id: string
          p_scenes: Json
          p_title: string
        }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_media_job: {
        Args: {
          p_job_id: string
          p_output_metadata?: Json
          p_output_url: string
          p_worker_id: string
        }
        Returns: boolean
      }
      create_lesson_video_project: {
        Args: {
          p_class_level: number
          p_language_code: string
          p_language_name: string
          p_learning_objective: string
          p_narration_text: string
          p_scenes: Json
          p_subject: string
          p_target_duration_seconds: number
          p_title: string
          p_topic: string
        }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_video_project: {
        Args: { p_class_level: number; p_subject: string; p_topic: string }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          duration_seconds: number
          error_message: string | null
          id: string
          image_job_id: string | null
          image_prompt: string
          image_url: string | null
          owner_id: string
          status: string
          subject: string
          topic: string
          updated_at: string
          video_job_id: string | null
          video_prompt: string
          video_url: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_video_project_v2: {
        Args: {
          p_class_level: number
          p_duration_seconds?: number
          p_subject: string
          p_topic: string
        }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          duration_seconds: number
          error_message: string | null
          id: string
          image_job_id: string | null
          image_prompt: string
          image_url: string | null
          owner_id: string
          status: string
          subject: string
          topic: string
          updated_at: string
          video_job_id: string | null
          video_prompt: string
          video_url: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fail_cloud_lesson_job: {
        Args: {
          p_cost_usd?: number
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_retry_delay_seconds?: number
          p_worker_id: string
        }
        Returns: boolean
      }
      fail_deck_media_job: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_retry_delay_seconds?: number
          p_worker_id: string
        }
        Returns: boolean
      }
      fail_lesson_video_job: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_retry_delay_seconds?: number
          p_worker_id: string
        }
        Returns: boolean
      }
      fail_lesson_video_setup: {
        Args: { p_error_message: string; p_project_id: string }
        Returns: boolean
      }
      fail_media_job: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_retry_delay_seconds?: number
          p_worker_id: string
        }
        Returns: boolean
      }
      heartbeat_cloud_lesson_job: {
        Args: {
          p_job_id: string
          p_progress: number
          p_provider_request_id?: string
          p_worker_id: string
        }
        Returns: string
      }
      heartbeat_deck_media_job: {
        Args: { p_job_id: string; p_progress: number; p_worker_id: string }
        Returns: boolean
      }
      heartbeat_lesson_video_job: {
        Args: { p_job_id: string; p_progress: number; p_worker_id: string }
        Returns: boolean
      }
      heartbeat_media_job: {
        Args: { p_job_id: string; p_progress: number; p_worker_id: string }
        Returns: boolean
      }
      is_deck_owner: { Args: { p_deck_id: string }; Returns: boolean }
      is_lesson_video_asset_owner: {
        Args: { p_name: string }
        Returns: boolean
      }
      is_lesson_video_project_owner: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      is_video_project_owner: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      match_document_chunks: {
        Args: {
          filter_deck_id?: string
          filter_document_ids?: string[]
          match_count?: number
          query_embedding: string
          similarity_threshold?: number
        }
        Returns: {
          content: string
          document_id: string
          id: string
          metadata: Json
          similarity: number
        }[]
      }
      request_deck_media_job_cancel: {
        Args: { p_job_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          deck_id: string | null
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          prompt: string
          slide_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          target_block: number | null
          updated_at: string
          video_project_id: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "deck_media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      request_media_job_cancel: {
        Args: { p_job_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          parameters: Json
          presentation_id: string | null
          profile: string
          progress: number
          prompt: string
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      reserve_cloud_lesson: {
        Args: {
          p_class_level: number
          p_language_code: string
          p_subject: string
          p_target_duration_seconds?: number
          p_topic: string
          p_visual_style?: string
        }
        Returns: {
          cache_key: string | null
          class_level: number
          completed_at: string | null
          content_key: string | null
          cost_breakdown: Json
          cost_usd: number
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          learning_objective: string | null
          narration_duration_seconds: number | null
          narration_text: string | null
          narration_url: string | null
          owner_id: string
          reused_from_project_id: string | null
          status: string
          subject: string
          target_duration_seconds: number
          title: string | null
          topic: string
          updated_at: string
          visual_style: string
        }[]
        SetofOptions: {
          from: "*"
          to: "cloud_lesson_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      reserve_lesson_video_project: {
        Args: {
          p_class_level: number
          p_language_code: string
          p_language_name: string
          p_subject: string
          p_target_duration_seconds: number
          p_topic: string
        }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      retry_deck_media_job: {
        Args: { p_job_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          deck_id: string | null
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          owner_id: string
          parameters: Json
          profile: string
          progress: number
          prompt: string
          slide_id: string | null
          source_image_url: string | null
          started_at: string | null
          status: string
          target_block: number | null
          updated_at: string
          video_project_id: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "deck_media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      retry_media_job: {
        Args: { p_job_id: string }
        Returns: {
          attempts: number
          available_at: string
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          heartbeat_at: string | null
          id: string
          kind: string
          locked_at: string | null
          max_attempts: number
          negative_prompt: string
          output_metadata: Json
          output_url: string | null
          parameters: Json
          presentation_id: string | null
          profile: string
          progress: number
          prompt: string
          source_image_url: string | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "media_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_lesson_video_narration: {
        Args: {
          p_narration_duration_seconds: number
          p_narration_url: string
          p_project_id: string
        }
        Returns: {
          class_level: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          final_video_url: string | null
          id: string
          language_code: string
          language_name: string
          learning_objective: string
          narration_duration_seconds: number | null
          narration_text: string
          narration_url: string | null
          owner_id: string
          status: string
          subject: string
          target_duration_seconds: number
          title: string
          topic: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "lesson_video_projects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      storage_deck_id: { Args: { p_name: string }; Returns: string }
    }
    Enums: {
      asset_kind: "background" | "hero" | "icon" | "chart" | "upload" | "export"
      asset_source: "generated" | "unsplash" | "upload" | "youtube" | "external"
      deck_status:
        | "draft"
        | "generating"
        | "ready"
        | "failed"
        | "archived"
        | "awaiting_review"
      deck_visibility: "private" | "unlisted" | "public"
      document_source:
        | "url"
        | "pdf"
        | "text"
        | "youtube"
        | "upload"
        | "pptx"
        | "docx"
      export_format: "pptx" | "pdf" | "png_zip"
      import_format: "pptx" | "ppt" | "pdf" | "docx" | "markdown" | "text"
      run_status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      asset_kind: ["background", "hero", "icon", "chart", "upload", "export"],
      asset_source: ["generated", "unsplash", "upload", "youtube", "external"],
      deck_status: [
        "draft",
        "generating",
        "ready",
        "failed",
        "archived",
        "awaiting_review",
      ],
      deck_visibility: ["private", "unlisted", "public"],
      document_source: [
        "url",
        "pdf",
        "text",
        "youtube",
        "upload",
        "pptx",
        "docx",
      ],
      export_format: ["pptx", "pdf", "png_zip"],
      import_format: ["pptx", "ppt", "pdf", "docx", "markdown", "text"],
      run_status: ["queued", "running", "succeeded", "failed", "cancelled"],
    },
  },
} as const
