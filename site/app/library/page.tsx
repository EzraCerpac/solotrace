import type { Metadata } from "next";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { LibraryClient } from "@/components/LibraryClient";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My library",
  description: "Private SoloTrace example copies saved with ChatGPT sign-in.",
};

export default async function LibraryPage() {
  const user = await requireChatGPTUser("/library");

  return (
    <div className="studio-route">
      <SiteHeader compact />
      <LibraryClient displayName={user.displayName} />
    </div>
  );
}
