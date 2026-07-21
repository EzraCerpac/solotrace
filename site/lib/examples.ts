import catalog from "@/public/examples/catalog.json";

const presentation = {
  "northbound-lights": {
    artist: "SoloTrace Studio",
    techniques: ["Bends", "Vibrato", "Confidence review"],
    accent: "ocean",
  },
  "switchback-run": {
    artist: "SoloTrace Studio",
    techniques: ["Hammer-ons", "Pull-offs", "Slides"],
    accent: "oxide",
  },
  "low-orbit": {
    artist: "SoloTrace Studio",
    techniques: ["Position shifts", "Low-string phrasing", "Version comparison"],
    accent: "iris",
  },
} as const;

export type ExampleSlug = keyof typeof presentation;

export type HostedExample = {
  slug: ExampleSlug;
  title: string;
  artist: string;
  description: string;
  bpm: number;
  meter: string;
  tuning: string;
  duration: string;
  techniques: readonly string[];
  versions: string[];
  accent: "ocean" | "oxide" | "iris";
};

export const hostedExamples: readonly HostedExample[] = catalog.map((entry) => {
  if (!(entry.slug in presentation)) {
    throw new Error(`Unknown hosted example in catalog: ${entry.slug}`);
  }
  const slug = entry.slug as ExampleSlug;
  return {
    slug,
    title: entry.title,
    artist: presentation[slug].artist,
    description: entry.summary,
    bpm: entry.tempoBpm,
    meter: entry.timeSignature.join("/"),
    tuning: entry.tuningLabel,
    duration: `${entry.durationS} sec`,
    techniques: presentation[slug].techniques,
    versions: entry.versionNames,
    accent: presentation[slug].accent,
  };
});

export function hostedExample(slug: string): HostedExample | undefined {
  return hostedExamples.find((example) => example.slug === slug);
}
