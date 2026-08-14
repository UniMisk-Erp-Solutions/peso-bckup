import { useRef } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { getTurnstileSiteKey } from "@/lib/turnstile";

type AuthTurnstileProps = {
  onToken: (token: string) => void;
  onExpire?: () => void;
  resetKey?: number;
};

export function AuthTurnstile({ onToken, onExpire, resetKey = 0 }: AuthTurnstileProps) {
  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileInstance | null>(null);

  if (!siteKey) return null;

  return (
    <div className="flex justify-center min-h-[65px]">
      <Turnstile
        key={resetKey}
        ref={turnstileRef}
        siteKey={siteKey}
        options={{ theme: "auto", size: "normal" }}
        onSuccess={(token) => onToken(token)}
        onExpire={() => {
          onToken("");
          onExpire?.();
        }}
        onError={() => {
          onToken("");
          onExpire?.();
        }}
      />
    </div>
  );
}
