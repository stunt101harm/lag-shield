import { lagShieldIdentity } from '@lagshield/core';

const foundationChecks = [
  'Strict TypeScript workspace',
  'Persistent agent service',
  'PostgreSQL migration path',
  'Deterministic test harness',
  'Frozen-lockfile CI',
];

export default function HomePage() {
  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="eyebrow">
          <span className="pulse" aria-hidden="true" />
          Foundation online
        </div>
        <h1 id="hero-title">{lagShieldIdentity.name}</h1>
        <p className="lede">
          Autonomous market protection for the moments when the match moves faster than
          the price.
        </p>
        <div className="state-flow" aria-label="LagShield market state flow">
          <span>Open</span>
          <b aria-hidden="true">→</b>
          <span>Widened</span>
          <b aria-hidden="true">→</b>
          <span className="paused">Paused</span>
          <b aria-hidden="true">→</b>
          <span>Recovery</span>
        </div>
      </section>

      <section className="foundation" aria-labelledby="foundation-title">
        <div>
          <p className="kicker">Build 0.1.0</p>
          <h2 id="foundation-title">Production foundation</h2>
          <p>
            The live TxLINE data plane, deterministic strategy, and proof receipts will
            land on this tested foundation.
          </p>
        </div>
        <ul>
          {foundationChecks.map((check) => (
            <li key={check}>
              <span aria-hidden="true">✓</span>
              {check}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
