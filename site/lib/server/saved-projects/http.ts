import { getChatGPTUser } from "@/app/chatgpt-auth";
import { savedProjectClientError } from "./request";
import { ownerIdForEmail } from "./runtime";

export { assertSafeMutationRequest, readJsonBody } from "./request";

export async function getAuthenticatedOwnerId(): Promise<string | null> {
  const user = await getChatGPTUser();
  return user ? ownerIdForEmail(user.email) : null;
}

export function errorResponse(error: unknown): Response {
  const clientError = savedProjectClientError(error);
  if (clientError) {
    return Response.json(
      { error: clientError.message, code: clientError.code },
      { status: clientError.status },
    );
  }

  console.error("Saved projects request failed", error);
  return Response.json(
    { error: "Saved projects are temporarily unavailable" },
    { status: 500 },
  );
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { error: "Sign in with ChatGPT to save projects", code: "unauthorized" },
    { status: 401 },
  );
}
