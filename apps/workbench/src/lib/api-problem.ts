import type { Problem } from '@astra/contracts';

/**
 * A problem response from the API, with its stable code and field errors.
 * Kept free of server-only imports so client components can depend on modules that use it.
 */
export class ApiProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiProblem';
  }
}
