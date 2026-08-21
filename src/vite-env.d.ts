/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_SITE_URL?: string;
  readonly VITE_GA_MEASUREMENT_ID?: string;
  readonly VITE_GSC_VERIFICATION?: string;
  readonly VITE_SOCIAL_LINKEDIN_URL?: string;
  readonly VITE_SOCIAL_TWITTER_URL?: string;
  readonly VITE_SOCIAL_INSTAGRAM_URL?: string;
  readonly VITE_SOCIAL_YOUTUBE_URL?: string;
  // Cloud maintenance control plane — docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
  readonly VITE_MAINTENANCE_SUPABASE_URL?: string;
  readonly VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_MAINTENANCE_ENV?: string;
  readonly VITE_MAINTENANCE_CONTROL_ENABLED?: string;
  readonly VITE_MAINTENANCE_REQUEST_TIMEOUT_MS?: string;
  readonly VITE_MAINTENANCE_POLL_INTERVAL_NORMAL_MS?: string;
  readonly VITE_MAINTENANCE_POLL_INTERVAL_ACTIVE_MS?: string;
  readonly VITE_MAINTENANCE_ACTIVE_FAILURE_GRACE_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
