/**
 * Neon Auth client for email/password authentication.
 *
 * Uses the @neon/auth SDK (BetterAuth-based) for email/password authentication.
 *
 * Environment variables:
 *   NEON_AUTH_URL   - The Neon Auth server URL (e.g., https://auth.neon.com)
 *   NEON_PROJECT_ID - Your Neon project ID
 *
 * @see https://neon.com/docs/ai/skills/neon-auth/SKILL.md
 */
async function getNeonAuth() {
  const { createAuthClient } = await import("@neon/auth");
  const url = process.env.NEON_AUTH_URL || "https://auth.neon.com";
  return createAuthClient(url);
}

/**
 * Sign up a new user with email and password using Neon Auth.
 */
export async function neonSignUp(email: string, password: string) {
  const auth = await getNeonAuth();
  const result = await auth.signUp.email({
    email,
    password,
    name: email.split("@")[0],
  });

  if (result.error) {
    throw new Error(result.error.message || "Failed to create account");
  }

  return { user: result.data?.user };
}

/**
 * Sign in a user with email and password using Neon Auth.
 */
export async function neonSignIn(email: string, password: string) {
  const auth = await getNeonAuth();
  const result = await auth.signIn.email({
    email,
    password,
  });

  if (result.error) {
    throw new Error(result.error.message || "Invalid email or password");
  }

  return { user: result.data?.user, session: (result.data as any)?.session };
}

/**
 * Get the current user from a Neon Auth session token.
 */
export async function neonGetUser(sessionToken: string) {
  const auth = await getNeonAuth();
  const result = await auth.getSession({
    fetchOptions: {
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    },
  });

  if (result.error || !result.data?.user) {
    return null;
  }

  return result.data.user;
}

/**
 * Sign out a user from Neon Auth.
 */
export async function neonSignOut(sessionToken: string) {
  const auth = await getNeonAuth();
  await auth.signOut({
    fetchOptions: {
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    },
  });
}
