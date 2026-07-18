# Security policy

LagShield is a hackathon-stage market-risk agent. It does not accept real-money orders or
custody funds.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository owner rather than opening a
public issue containing exploit details or credentials.

## Credential handling

- Never commit wallet keypairs, seed phrases, TxLINE tokens, JWTs, or RPC credentials.
- Store production secrets only in the deployment provider's secret manager.
- Use a dedicated low-balance wallet for TxLINE subscription activation.
- Rotate a credential immediately if it appears in a log, screenshot, issue, or commit.
