/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_SITE_URL?: string;
  readonly VITE_GA_MEASUREMENT_ID?: string;
  readonly VITE_GSC_VERIFICATION?: string;
  readonly VITE_SOCIAL_LINKEDIN_URL?: string;
  readonly VITE_SOCIAL_TWITTER_URL?: string;
  readonly VITE_SOCIAL_INSTAGRAM_URL?: string;
  readonly VITE_SOCIAL_YOUTUBE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
