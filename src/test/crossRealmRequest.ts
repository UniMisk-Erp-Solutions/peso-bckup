import { vi } from "vitest";

// Real React Router navigation constructs a Node Request in this jsdom test
// environment, but its AbortController comes from jsdom. Undici rejects that
// cross-realm signal at Request construction. Keep the native Request fields,
// then restore the caller's signal without passing it through undici's realm
// check. Router code only depends on the standard AbortSignal interface.
const NativeRequest = globalThis.Request;

class CrossRealmRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const signal = init?.signal;
    if (signal) {
      const { signal: _signal, ...nativeInit } = init;
      super(input, nativeInit);
      Object.defineProperty(this, "signal", { configurable: true, value: signal });
      return;
    }
    super(input, init);
  }
}

export function useCrossRealmRequest(): void {
  vi.stubGlobal("Request", CrossRealmRequest);
}
