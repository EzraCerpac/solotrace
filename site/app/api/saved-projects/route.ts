import {
  MAX_SAVED_PROJECTS_PER_OWNER,
  parseCreateSavedProjectInput,
} from "@/lib/server/saved-projects/domain";
import {
  assertSafeMutationRequest,
  errorResponse,
  getAuthenticatedOwnerId,
  readJsonBody,
  unauthorizedResponse,
} from "@/lib/server/saved-projects/http";
import {
  createSavedProject,
  listSavedProjects,
  SavedProjectLimitError,
} from "@/lib/server/saved-projects/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ownerId = await getAuthenticatedOwnerId();
    if (!ownerId) return unauthorizedResponse();
    const projects = await listSavedProjects(ownerId);
    return Response.json({
      projects,
      quota: {
        used: projects.length,
        limit: MAX_SAVED_PROJECTS_PER_OWNER,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const ownerId = await getAuthenticatedOwnerId();
    if (!ownerId) return unauthorizedResponse();
    const input = parseCreateSavedProjectInput(await readJsonBody(request));
    const project = await createSavedProject(ownerId, input);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof SavedProjectLimitError) {
      return Response.json(
        { error: error.message, code: "saved_project_limit" },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}
