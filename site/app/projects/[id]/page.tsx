import type { Metadata } from "next";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { SavedProjectStudio } from "@/components/SavedProjectStudio";
import { SiteHeader } from "@/components/SiteHeader";

type SavedProjectPageProps = {
  params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Saved project",
  description: "Edit a private SoloTrace example copy.",
};

export default async function SavedProjectPage({ params }: SavedProjectPageProps) {
  const { id } = await params;
  const returnTo = `/projects/${encodeURIComponent(id)}`;

  return <AuthenticatedSavedProject id={id} returnTo={returnTo} />;
}

async function AuthenticatedSavedProject({
  id,
  returnTo,
}: {
  id: string;
  returnTo: string;
}) {
  await requireChatGPTUser(returnTo);

  return (
    <div className="studio-route">
      <SiteHeader compact />
      <SavedProjectStudio id={id} />
    </div>
  );
}
