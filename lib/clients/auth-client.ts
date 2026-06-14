import type { UserInfo } from '@/lib/types/rag';
import config from '@/lib/config/environment';
import { fetchWithTimeout } from '@/lib/utils/fetch-timeout';

const AUTH_SERVICE_TIMEOUT_MS = 5000;

/**
 * Validate an authentication token against an external auth service when configured.
 */
export async function validateToken(token: string): Promise<{ valid: boolean; user?: UserInfo }> {
  if (!token || token.trim() === '') {
    return { valid: false };
  }

  if (!config.services.authUrl) {
    return { valid: false };
  }

  try {
    const response = await fetchWithTimeout(
      `${config.services.authUrl}/api/rag/auth/validate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      },
      AUTH_SERVICE_TIMEOUT_MS,
    );

    if (!response.ok) {
      return { valid: false };
    }

    return response.json() as Promise<{ valid: boolean; user?: UserInfo }>;
  } catch (error) {
    // Fail-closed: an auth-service outage must not grant access. Log so the
    // resulting wave of 401/403 responses is traceable to its root cause.
    console.warn('[auth-client] Token validation failed (denying request):', error);
    return { valid: false };
  }
}

/**
 * Get user preferences from the external auth/profile service when configured.
 */
export async function getUserPreferences(userId: string): Promise<UserInfo['preferences']> {
  if (!config.services.authUrl || !userId) {
    return {};
  }

  try {
    const response = await fetchWithTimeout(
      `${config.services.authUrl}/api/rag/users/${userId}/preferences`,
      { cache: 'no-store' },
      AUTH_SERVICE_TIMEOUT_MS,
    );

    if (!response.ok) {
      return {};
    }

    return response.json() as Promise<UserInfo['preferences']>;
  } catch {
    return {};
  }
}
