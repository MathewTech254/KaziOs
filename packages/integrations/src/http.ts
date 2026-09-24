/**
 * The Node typings declare `Response.json()` as `unknown`, so each provider
 * narrows the parsed body to the shape it actually expects.
 */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
