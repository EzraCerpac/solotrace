import { parsePatchSavedProjectInput } from "@/lib/server/saved-projects/domain";
import {
  assertSafeMutationRequest,
  errorResponse,
  getAuthenticatedOwnerId,
  readJsonBody,
  unauthorizedResponse,
} from "@/lib/server/saved-projects/http";
import {
  deleteSavedProject,
  getSavedProject,
  SavedProjectConflictError,
  updateSavedProject,
} from "@/lib/server/saved-projects/repository";

type RouteContext = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const ownerId = await getAuthenticatedOwnerId();
    if (!ownerId) return unauthorizedResponse();
    const { id } = await context.params;
    const project = await getSavedProject(ownerId, id);
    if (!project) return notFoundResponse();
    return Response.json({ project });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const ownerId = await getAuthenticatedOwnerId();
    if (!ownerId) return unauthorizedResponse();
    const { id } = await context.params;
    const input = parsePatchSavedProjectInput(await readJsonBody(request));
    const project = await updateSavedProject(ownerId, id, input);
    if (!project) return notFoundResponse();
    return Response.json({ project });
  } catch (error) {
    if (error instanceof SavedProjectConflictError) {
      return Response.json(
        {
          error: error.message,
          code: "revision_conflict",
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const ownerId = await getAuthenticatedOwnerId();
    if (!ownerId) return unauthorizedResponse();
    const { id } = await context.params;
    if (!(await deleteSavedProject(ownerId, id))) return notFoundResponse();
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

function notFoundResponse(): Response {
  return Response.json(
    { error: "Saved project not found", code: "not_found" },
    { status: 404 },
  );
}
