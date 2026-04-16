/**
 * FounderSection — brand origin story and premium trust narrative.
 *
 * A light editorial section that answers the partner/buyer question:
 * "Who is behind this, and why should I trust it?"
 *
 * Three proof stats anchor the right column. The left column carries
 * the human narrative that differentiates GTG from generic sports merch.
 */

const PROOF_STATS = [
  {
    value: '100%',
    label: 'Officially licensed — every SKU',
  },
  {
    value: 'Every piece',
    label: 'Hologram-verified and tracked',
  },
  {
    value: 'Gift-ready',
    label: 'Out of the box, no assembly',
  },
] as const

export function FounderSection() {
  return (
    <section className="founder-section" aria-label="Our story">
      <div className="founder-inner">

        {/* ── Left: narrative copy ── */}
        <div className="founder-copy">
          <p className="founder-eyebrow">The Story</p>
          <h2 className="founder-title">
            Built for the fan who<br />takes it seriously.
          </h2>
          <p className="founder-narrative">
            Game Time Gift started with a question: why does a fan&apos;s most meaningful
            piece end up in a drawer? We built something display-worthy from day one —
            officially licensed, hologram-verified, and packaged to feel like what it is:
            a gift worth giving.
          </p>
          <p className="founder-detail">
            Every SKU is tracked. Every piece authenticated at the source. Every order
            arrives gift-ready — no extra wrap, no afterthought packaging. From Father&apos;s
            Day to retirement, the moment deserves more than a quick buy.
          </p>
          <p className="founder-sign">— The Game Time Gift Team</p>
        </div>

        {/* ── Right: proof stats ── */}
        <div className="founder-stats">
          {PROOF_STATS.map((stat) => (
            <article key={stat.label} className="founder-stat">
              <strong className="founder-stat-value">{stat.value}</strong>
              <span className="founder-stat-label">{stat.label}</span>
            </article>
          ))}
        </div>

      </div>
    </section>
  )
}
