/**
 * Claims of an sms-backend agent token (minted by `POST /agent/session`).
 *
 * This service decodes the token but never verifies it — it does not hold
 * the signing secret. Before spending anything on a model call it asks
 * sms-backend for the school's quota with the same token, which verifies the
 * signature, the school binding and the `ai_agent` feature. A forged token
 * therefore never reaches the model.
 */
export interface AgentClaims {
  sub: number;
  role: string;
  roles?: string[];
  firstName?: string;
  lastName?: string;
  schoolId: number;
  slug: string;
  agent?: boolean;
  agentSessionId?: string;
  agentScopes?: string[];
  exp?: number;
}

export class TokenError extends Error {}

export function bearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Throws unless this looks like an unexpired agent token. */
export function requireAgentClaims(token: string, now = Date.now()): AgentClaims {
  const part = token.split('.')[1];
  if (!part) throw new TokenError('Missing or malformed assistant token.');
  let claims: AgentClaims;
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('Missing or malformed assistant token.');
  }
  if (!claims?.agent || !claims.slug || !claims.schoolId || !claims.sub) {
    throw new TokenError(
      'Not an assistant token. Start a session at POST /agent/session first.',
    );
  }
  if (claims.exp && claims.exp * 1000 <= now) {
    throw new TokenError('The assistant session has expired.');
  }
  return claims;
}

/** Conversations belong to a person in a school, across token refreshes. */
export function ownerKey(claims: AgentClaims): string {
  return `${claims.schoolId}:${claims.sub}`;
}

export function canWrite(claims: AgentClaims): boolean {
  return claims.agentScopes?.includes('write') ?? false;
}
