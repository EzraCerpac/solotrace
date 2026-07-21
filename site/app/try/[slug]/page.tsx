import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExampleStudio } from "@/components/ExampleStudio";
import { SiteHeader } from "@/components/SiteHeader";
import { hostedExample, hostedExamples } from "@/lib/examples";

type ExamplePageProps = {
  params: Promise<{ slug: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return hostedExamples.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: ExamplePageProps): Promise<Metadata> {
  const example = hostedExample((await params).slug);
  if (!example) return {};
  return {
    title: example.title,
    description: `Play, edit, refinger, and export ${example.title} in the free SoloTrace example studio.`,
  };
}

export default async function ExamplePage({ params }: ExamplePageProps) {
  const example = hostedExample((await params).slug);
  if (!example) notFound();

  return (
    <div className="studio-route">
      <SiteHeader compact />
      <ExampleStudio slug={example.slug} />
    </div>
  );
}
