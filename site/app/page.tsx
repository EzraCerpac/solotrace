import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { hostedExamples } from "@/lib/examples";

export default function Home() {
  return (
    <div className="public-shell">
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Free example studio · no key required</p>
            <h1 id="hero-title">Hear the phrase. Trace the fingering.</h1>
            <p className="hero-deck">
              SoloTrace turns lead guitar into synchronized, editable tab. This
              hosted studio comes preloaded with three synthetic examples, so you
              can play, edit, refinger, compare, and export immediately.
            </p>
            <div className="hero-actions">
              <Link className="button primary" href="/try/northbound-lights">
                Try Northbound Lights
              </Link>
              <a className="text-link" href="#examples">Browse all examples</a>
            </div>
            <p className="quiet-note">
              Your anonymous edits stay on this device. Sign in with ChatGPT only
              when you choose to save a private copy.
            </p>
          </div>
          <div className="hero-notation" aria-label="A guitar waveform aligned to tablature">
            <div className="hero-meter"><span>92</span> BPM · 4/4</div>
            <svg viewBox="0 0 720 360" role="img" aria-labelledby="hero-score-title">
              <title id="hero-score-title">A waveform passing through six tablature strings</title>
              <g className="hero-strings">
                {[82, 122, 162, 202, 242, 282].map((y) => (
                  <line key={y} x1="52" x2="680" y1={y} y2={y} />
                ))}
              </g>
              <path className="hero-wave" d="M52 204 L66 204 L75 196 L84 220 L93 174 L102 238 L112 188 L122 211 L132 201 L148 204 L166 204 L175 192 L184 217 L193 180 L202 231 L211 193 L220 208 L234 202 L248 204 L266 204 L276 184 L286 227 L296 164 L306 243 L316 177 L326 216 L338 197 L352 204 L374 204 L384 191 L394 218 L404 179 L414 232 L424 190 L434 211 L446 200 L460 204 L478 204 L488 196 L498 214 L508 185 L518 226 L528 193 L538 210 L552 201 L568 204 L586 204 L596 198 L606 211 L616 192 L626 218 L636 198 L646 207 L660 203 L680 204" />
              <g className="hero-notes">
                <g transform="translate(122 162)"><rect x="-17" y="-16" width="34" height="32" rx="4"/><text y="6">7</text><text className="tech" x="24" y="-20">h</text></g>
                <g transform="translate(248 122)"><rect x="-20" y="-16" width="40" height="32" rx="4"/><text y="6">10</text><path d="M18 -18 q22 -35 40 -3"/></g>
                <g transform="translate(374 202)"><rect x="-17" y="-16" width="34" height="32" rx="4"/><text y="6">8</text><text className="tech" x="25" y="-20">/</text></g>
                <g transform="translate(518 82)"><rect x="-20" y="-16" width="40" height="32" rx="4"/><text y="6">12</text><path d="M18 -15 q8 -8 16 0 t16 0"/></g>
              </g>
            </svg>
            <div className="hero-legend"><span>audio</span><span>fingering</span><span>technique</span></div>
          </div>
        </section>

        <section className="examples-section" id="examples" aria-labelledby="examples-title">
          <div className="section-heading">
            <p className="eyebrow">Three zero-cost sessions</p>
            <h2 id="examples-title">Choose a phrase to pull apart</h2>
            <p>Every track is synthetic, CC0, and prepared locally. No upload or external processing happens here.</p>
          </div>
          <div className="example-grid">
            {hostedExamples.map((example, index) => (
              <article className={`example-card accent-${example.accent}`} key={example.slug}>
                <div className="example-number">0{index + 1}</div>
                <div className="example-card-body">
                  <div className="example-card-heading">
                    <div>
                      <h3>{example.title}</h3>
                      <p>{example.description}</p>
                    </div>
                    <span className="meter-chip">{example.bpm} BPM · {example.meter}</span>
                  </div>
                  <dl className="example-facts">
                    <div><dt>Tuning</dt><dd>{example.tuning}</dd></div>
                    <div><dt>Length</dt><dd>{example.duration}</dd></div>
                    <div><dt>Versions</dt><dd>{example.versions.length}</dd></div>
                  </dl>
                  <ul className="technique-list" aria-label="Techniques">
                    {example.techniques.map((technique) => <li key={technique}>{technique}</li>)}
                  </ul>
                  <Link className="card-link" href={`/try/${example.slug}`}>
                    Open session <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="hosted-boundary" aria-labelledby="boundary-title">
          <div><p className="eyebrow">Hosted studio</p><h2 id="boundary-title">Examples here. Your own audio on desktop.</h2></div>
          <p>
            This public edition deliberately avoids uploads, API keys, and paid
            compute. Use it to learn the editor. The local SoloTrace app remains
            the private route for processing personal recordings.
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <span>SoloTrace Example Studio</span>
        <span>Synthetic audio released CC0 · edits stay private</span>
      </footer>
    </div>
  );
}
