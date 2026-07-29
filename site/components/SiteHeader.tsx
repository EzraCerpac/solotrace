import Link from "next/link";

type SiteHeaderProps = {
  compact?: boolean;
};

export function SiteHeader({ compact = false }: SiteHeaderProps) {
  return (
    <header className={`site-header${compact ? " is-compact" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Link className="site-wordmark" href="/" aria-label="SoloTrace home">
        <span className="site-mark" aria-hidden="true">ST</span>
        <span>SoloTrace</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/#examples">Examples</Link>
        <Link href="/library">My library</Link>
      </nav>
      <a
        className="header-desktop-link"
        href="https://github.com/EzraCerpac/solotrace"
        rel="noreferrer"
      >
        Source · private beta
      </a>
    </header>
  );
}
