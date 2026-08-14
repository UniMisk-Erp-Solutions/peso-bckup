import { FunctionsHttpError } from "@supabase/functions-js";
import { supabase } from "@/integrations/supabase/client";

function edgeFunctionDeployHint(functionName: string): string {
  return `Deploy ${functionName} on your Supabase host (Coolify: copy supabase/functions/${functionName} to volumes/functions/${functionName}/index.ts and restart the edge-runtime container). See docs/coolify-edge-functions-deploy.md`;
}

async function formatEdgeFunctionError(
  functionName: string,
  error: { message?: string; context?: Response },
): Promise<string> {
  const message = error.message || "Edge function request failed";
  let detail = "";

  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      const bodyText = await error.context.clone().text();
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText) as { msg?: string; error?: string };
          detail = parsed.msg || parsed.error || bodyText;
        } catch {
          detail = bodyText.slice(0, 300);
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  if (detail.includes("could not find an appropriate entrypoint")) {
    return `${functionName} is not deployed on Supabase (missing function files on the server). ${edgeFunctionDeployHint(functionName)}`;
  }

  if (detail.includes("Server misconfiguration")) {
    return `${functionName} is deployed but missing SUPABASE_SERVICE_ROLE_KEY on the edge-runtime container. ${edgeFunctionDeployHint(functionName)}`;
  }

  if (detail) {
    return `${message}: ${detail}`;
  }

  if (/edge function|failed to send a request|cors|network/i.test(message)) {
    return `${message}. ${edgeFunctionDeployHint(functionName)}`;
  }

  return message;
}


export async function invokeAdminEdgeFunction<TResponse>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("You must be signed in to perform this action.");
  }

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (error) {
    throw new Error(await formatEdgeFunctionError(functionName, error));
  }

  return data as TResponse;
}
