/** Cloudflare Turnstile site key (public). Must match Supabase Auth CAPTCHA settings. */
export function getTurnstileSiteKey(): string | undefined {
  const key = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  const trimmed = key?.trim();
  return trimmed || undefined;
}

export function isTurnstileConfigured(): boolean {
  return Boolean(getTurnstileSiteKey());
}

/** Pass to supabase.auth.signInWithPassword / signUp when Turnstile is enabled. */
export function buildAuthCaptchaOptions(captchaToken?: string | null) {
  if (!captchaToken?.trim()) return {};
  return { captchaToken: captchaToken.trim() };
}
