import { env } from "cloudflare:workers";
import { deriveOwnerId } from "./domain";

type SoloTraceBindings = {
  SOLOTRACE_OWNER_ID_SECRET?: string;
};

export async function ownerIdForEmail(email: string): Promise<string> {
  const bindings = env as typeof env & SoloTraceBindings;
  return deriveOwnerId(email, bindings.SOLOTRACE_OWNER_ID_SECRET ?? "");
}
